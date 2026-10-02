/*
 * YunX Desktop —— 链接解析器 + 分片下载引擎验证。
 * 分片引擎用本地 HTTP server 真实地跑 Range 分片、断点续传与 Range 忽略回退。
 */

const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const D = path.join(__dirname, '..', 'dist', 'main');
const { parseShareLink } = require(path.join(__dirname, '..', 'dist', 'shared', 'linkParser.js'));
const cd = require(path.join(D, 'download', 'chunkDownloader.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// ============ 1. 链接解析 ============
console.log('--- 链接解析 ---');
const linkCases = [
  ['https://pan.quark.cn/s/abc123def', 'QUARK', 'abc123def', null],
  ['https://drive.uc.cn/s/xyz789', 'UC', 'xyz789', null],
  ['https://pan.xunlei.com/s/XYZ_-abc', 'XUNLEI', 'XYZ_-abc', null],
  ['https://pan.baidu.com/s/1AbCdEf', 'BAIDU', 'AbCdEf', null],
  ['https://yun.139.com/shareweb/#/w/i/LINKID99', 'C139', 'LINKID99', null],
  ['https://www.123pan.com/s/2785Vv-T4Ded', 'PAN123', '2785Vv-T4Ded', null],
  ['https://www.123865.com/s/2785Vv-T4Ded', 'PAN123', '2785Vv-T4Ded', null],
  ['https://123.share.123pan.cn/123pan/AbC-123', 'PAN123', 'AbC-123', null],
  ['https://www.123pan.cn/api/srr?sk=2785Vv-T4Ded&st=s', 'PAN123', '2785Vv-T4Ded', null],
  ['https://pan.quark.cn/s/abc123def?pwd=1234', 'QUARK', 'abc123def', '1234'],
];
for (const [text, plat, id, pwd] of linkCases) {
  const r = parseShareLink(text);
  check(
    `解析 ${plat} ${text.slice(0, 46)}`,
    r && r.platform === plat && r.shareId === id && r.pwd === pwd,
    r ? `${r.platform}/${r.shareId}/pwd=${r.pwd}` : 'null',
  );
}

// 整段分享文案 + 中文提示
const prose = '我用夸克网盘分享了「电影合集」，点击链接即可保存。打开「夸克APP」在线查看。链接：https://pan.quark.cn/s/9f8e7d6c 提取码：a1b2';
const pr = parseShareLink(prose);
check('从整段文案提取链接+提取码', pr && pr.platform === 'QUARK' && pr.shareId === '9f8e7d6c' && pr.pwd === 'a1b2', JSON.stringify(pr));

// 结尾标点应被裁掉
const punct = parseShareLink('链接：https://pan.baidu.com/s/1XyZ123，提取码 x9y8');
check('中文逗号结尾被裁剪', punct && punct.shareId === 'XyZ123' && punct.pwd === 'x9y8', JSON.stringify(punct));

check('无法识别的链接返回 null', parseShareLink('https://example.com/whatever') === null);
check('空字符串返回 null', parseShareLink('') === null);

// ============ 2. 分片下载引擎 ============
console.log('\n--- 分片下载引擎 ---');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-test-'));
const CONTENT = crypto.randomBytes(3 * 1024 * 1024 + 12345); // 3MB+，确保多分片
const KEY = 'unit-test-key';

function startServer(opts) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (opts.refuseAll) {
        res.writeHead(403);
        res.end('nope');
        return;
      }
      const auth = req.headers['x-test-key'];
      const range = req.headers.range;
      // HTML 错误页优先级最高：防盗链/过期页不分是否带 Range
      if (opts.htmlInstead) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>expired</html>');
        return;
      }
      if (range && !opts.ignoreRange) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : CONTENT.length - 1;
        const slice = CONTENT.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${CONTENT.length}`,
          'Content-Length': slice.length,
          'Content-Type': 'application/octet-stream',
        });
        res.end(slice);
        return;
      }
      if (opts.htmlInstead) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>expired</html>');
        return;
      }
      res.writeHead(200, {        'Content-Length': CONTENT.length,
        'Content-Type': 'application/octet-stream',
      });
      res.end(CONTENT);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 2a. 探测总大小
  {
    const srv = await startServer({});
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/f.bin`;
    const size = await cd.getTotalSize(url, {});
    check('getTotalSize 通过 Range 探测出正确大小', size === CONTENT.length, `${size} vs ${CONTENT.length}`);
    srv.close();
  }

  // 2b. 分片下载 + 合并，校验字节完全一致
  {
    const srv = await startServer({});
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/f.bin`;
    const dir = path.join(TMP, 'case-b');
    cd.ensureDir(dir);
    const CHUNKS = 4;
    const size = Math.ceil(CONTENT.length / CHUNKS);
    const parts = [];
    for (let i = 0; i < CHUNKS; i++) {
      const start = i * size;
      const end = Math.min(start + size, CONTENT.length) - 1;
      const pf = cd.chunkPath(dir, i);
      const r = await cd.downloadChunk({
        url, start, end, partFile: pf, headers: {},
        onBytes: () => {},
      });
      parts.push(pf);
      if (r !== cd.ChunkResult.OK) check(`分片 ${i} 下载成功`, false, r);
    }
    const out = path.join(TMP, 'merged.bin');
    const merged = await cd.mergeChunks(parts, out);
    const got = fs.readFileSync(out);
    check('分片合并后字节数与源一致', merged === CONTENT.length, `${merged} vs ${CONTENT.length}`);
    check('分片合并后内容 SHA256 完全一致', crypto.createHash('sha256').update(got).digest('hex') === crypto.createHash('sha256').update(CONTENT).digest('hex'));
    check('合并后 .part 分片已被删除（边写边删）', parts.every((p) => !fs.existsSync(p)));
    srv.close();
  }

  // 2c. 断点续传：先写一半，再续传
  {
    const srv = await startServer({});
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/f.bin`;
    const dir = path.join(TMP, 'case-c');
    cd.ensureDir(dir);
    const pf = cd.chunkPath(dir, 0);
    // 预置前 1MB（模拟上次中断）
    fs.writeFileSync(pf, CONTENT.subarray(0, 1024 * 1024));
    const r = await cd.downloadChunk({
      url, start: 0, end: CONTENT.length - 1, partFile: pf, headers: {},
      onBytes: () => {},
    });
    const got = fs.readFileSync(pf);
    check('断点续传结果正确（OK）', r === cd.ChunkResult.OK, r);
    check('断点续传后文件完整且内容一致',
      got.length === CONTENT.length &&
      crypto.createHash('sha256').update(got).digest('hex') === crypto.createHash('sha256').update(CONTENT).digest('hex'),
      `len=${got.length}`);
    srv.close();
  }

  // 2d. 服务器忽略 Range → 必须返回 RANGE_IGNORED，绝不整文件写入单片
  {
    const srv = await startServer({ ignoreRange: true });
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/f.bin`;
    const dir = path.join(TMP, 'case-d');
    cd.ensureDir(dir);
    const pf = cd.chunkPath(dir, 0);
    const r = await cd.downloadChunk({
      url, start: 0, end: 1023, partFile: pf, headers: {},
      onBytes: () => {},
    });
    check('Range 被忽略时返回 RANGE_IGNORED', r === cd.ChunkResult.RANGE_IGNORED, r);
    check('RANGE_IGNORED 时未写入整文件到分片', !fs.existsSync(pf) || fs.statSync(pf).size === 0,
      fs.existsSync(pf) ? `size=${fs.statSync(pf).size}` : 'no file');
    srv.close();
  }

  // 2e. HTML 错误页 → FAILED，绝不存盘
  {
    const srv = await startServer({ htmlInstead: true });
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/f.bin`;
    const dir = path.join(TMP, 'case-e');
    cd.ensureDir(dir);
    const pf = cd.chunkPath(dir, 0);
    const r = await cd.downloadChunk({
      url, start: 0, end: 1023, partFile: pf, headers: {},
      onBytes: () => {},
    });
    check('防盗链/过期 HTML 页返回 FAILED', r === cd.ChunkResult.FAILED, r);
    check('HTML 页未被写入磁盘', !fs.existsSync(pf) || fs.statSync(pf).size === 0);
    srv.close();
  }

  // 2f. 单流回退：内容与源一致
  {
    const srv = await startServer({ ignoreRange: true });
    const port = srv.address().port;
    const url = `http://127.0.0.1:${port}/f.bin`;
    const dir = path.join(TMP, 'case-f');
    cd.ensureDir(dir);
    const pf = path.join(dir, 'full.part');
    let bytes = 0;
    const ok = await cd.downloadFull({
      url, partFile: pf, headers: {}, total: CONTENT.length,
      onBytes: (n) => (bytes += n),
    });
    const got = fs.readFileSync(pf);
    check('单流回退返回 true', ok === true);
    check('单流回退内容 SHA256 一致',
      crypto.createHash('sha256').update(got).digest('hex') === crypto.createHash('sha256').update(CONTENT).digest('hex'),
      `len=${got.length}`);
    srv.close();
  }

  // 2g. Content-Range 校验：伪造错误区间应判失败
  {
    const srv = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        // 故意返回与请求不符的区间
        res.writeHead(206, {
          'Content-Range': `bytes 0-99/${CONTENT.length}`,
          'Content-Length': 100,
        });
        res.end(CONTENT.subarray(0, 100));
      });
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = srv.address().port;
    const dir = path.join(TMP, 'case-g');
    cd.ensureDir(dir);
    const r = await cd.downloadChunk({
      url: `http://127.0.0.1:${port}/f.bin`,
      start: 1000, end: 1999, partFile: cd.chunkPath(dir, 0), headers: {},
      onBytes: () => {},
    });
    check('Content-Range 与请求不符时判 FAILED', r === cd.ChunkResult.FAILED, r);
    srv.close();
  }

  console.log('\n===== SUMMARY =====');
  const failed = results.filter((r) => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')));
    process.exit(1);
  }
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
