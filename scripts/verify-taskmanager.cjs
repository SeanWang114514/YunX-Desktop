/*
 * YunX Desktop —— TaskManager 端到端集成测试。
 * 在 Electron 主进程环境下跑真实的 TaskManager（分片调度 + 并发 + 进度 + 断点续传 + 清理）。
 * 用本地 HTTP server 提供真实文件，校验落盘内容 SHA256。
 */

const { app } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// 主进程产物
const DIST = path.join(__dirname, '..', 'dist', 'main');
const { TaskManager } = require(path.join(DIST, 'download', 'taskManager.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-tm-'));
const CONTENT = crypto.randomBytes(9 * 1024 * 1024 + 777); // ~9MB，确保多分片
const SHA = crypto.createHash('sha256').update(CONTENT).digest('hex');

let requestCount = 0;
let rangeRequests = 0;

function startServer(opts = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      requestCount++;
      const range = req.headers.range;
      if (opts.failFirstN && requestCount <= opts.failFirstN) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      if (range && !opts.ignoreRange) {
        rangeRequests++;
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : CONTENT.length - 1;
        const slice = CONTENT.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${CONTENT.length}`,
          'Content-Length': slice.length,
          'Content-Type': 'application/octet-stream',
        });
        // throttle：慢速分块发送，让「暂停」测试可确定性触发
        if (opts.throttle) {
          const STEP = 128 * 1024;
          let off = 0;
          const timer = setInterval(() => {
            if (off >= slice.length || res.destroyed) {
              clearInterval(timer);
              if (!res.destroyed) res.end();
              return;
            }
            res.write(slice.subarray(off, off + STEP));
            off += STEP;
          }, opts.throttle);
          res.on('close', () => clearInterval(timer));
          return;
        }
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'Content-Length': CONTENT.length,
        'Content-Type': 'application/octet-stream',
      });
      res.end(CONTENT);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function waitFor(emitter, event, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等待 ${event} 超时`)), timeoutMs);
    emitter.once(event, (t2) => {
      clearTimeout(t);
      resolve(t2);
    });
  });
}

app.whenReady().then(async () => {
  try {
    // ---------- 用例 1：正常分片下载 + 合并 ----------
    {
      requestCount = 0;
      rangeRequests = 0;
      const srv = await startServer({});
      const port = srv.address().port;
      const outDir = path.join(TMP, 'case1');
      const tm = new TaskManager({ tempRoot: path.join(TMP, 'parts1'), concurrency: 8 });

      const task = tm.create({
        platform: 'QUARK',
        fid: 'f1',
        fileName: 'big.bin',
        url: `http://127.0.0.1:${port}/big.bin`,
        dirPath: outDir,
        size: CONTENT.length,
        headers: {},
      });

      const doneP = waitFor(tm, 'done');
      const progressSeen = [];
      tm.on('progress', (t) => progressSeen.push(t.downloadedBytes));
      tm.on('error', (t) => console.log('  [task error]', t.error));

      await tm.start(task.id);
      const finished = await doneP;

      check('任务状态为 COMPLETED', finished.status === 'COMPLETED', finished.status);
      const outFile = path.join(outDir, 'big.bin');
      check('最终文件已生成', fs.existsSync(outFile));
      if (fs.existsSync(outFile)) {
        const got = fs.readFileSync(outFile);
        check('文件大小正确', got.length === CONTENT.length, `${got.length} vs ${CONTENT.length}`);
        check(
          '文件内容 SHA256 完全一致',
          crypto.createHash('sha256').update(got).digest('hex') === SHA,
        );
      }
      check('确实使用了 Range 分片请求', rangeRequests > 1, `rangeRequests=${rangeRequests}`);
      check('分片数 > 1', finished.chunks > 1, `chunks=${finished.chunks}`);
      check('下载过程有进度上报', progressSeen.length > 0, `progress events=${progressSeen.length}`);
      check('下载进度单调不减', progressSeen.every((v, i) => i === 0 || v >= progressSeen[i - 1]));
      check('临时分片目录已清理', !fs.existsSync(path.join(TMP, 'parts1', task.id)));
      srv.close();
    }

    // ---------- 用例 2：服务器忽略 Range → 自动回退单流 ----------
    {
      requestCount = 0;
      const srv = await startServer({ ignoreRange: true });
      const port = srv.address().port;
      const outDir = path.join(TMP, 'case2');
      const tm = new TaskManager({ tempRoot: path.join(TMP, 'parts2'), concurrency: 4 });

      const task = tm.create({
        platform: 'UC',
        fid: 'f2',
        fileName: 'fallback.bin',
        url: `http://127.0.0.1:${port}/f.bin`,
        dirPath: outDir,
        size: CONTENT.length,
        headers: {},
      });
      const doneP = waitFor(tm, 'done');
      tm.on('error', (t) => console.log('  [task error]', t.error));
      await tm.start(task.id);
      const finished = await doneP;

      check('Range 被忽略时任务仍完成（回退单流）', finished.status === 'COMPLETED', finished.status);
      const outFile = path.join(outDir, 'fallback.bin');
      check('回退单流后文件 SHA256 一致',
        fs.existsSync(outFile) &&
          crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex') === SHA);
      srv.close();
    }

    // ---------- 用例 3：暂停 + 断点续传 ----------
    {
      requestCount = 0;
      const srv = await startServer({ throttle: 25 });
      const port = srv.address().port;
      const outDir = path.join(TMP, 'case3');
      const partsRoot = path.join(TMP, 'parts3');
      const tm = new TaskManager({ tempRoot: partsRoot, concurrency: 2 });

      const task = tm.create({
        platform: 'BAIDU',
        fid: 'f3',
        fileName: 'resume.bin',
        url: `http://127.0.0.1:${port}/r.bin`,
        dirPath: outDir,
        size: CONTENT.length,
        headers: {},
      });
      tm.on('error', () => {});

      await tm.start(task.id);
      // 等确实收到了一部分数据再暂停（throttle 保证下载仍在进行中）
      await new Promise((r) => setTimeout(r, 700));
      await tm.pause(task.id);
      const paused = tm.get(task.id);
      check('暂停后状态为 PAUSED', paused.status === 'PAUSED', paused.status);
      const partial = paused.downloadedBytes;
      check('暂停时已下载部分数据（>0）', partial > 0, `${partial} bytes`);
      check('暂停时最终文件尚未生成', !fs.existsSync(path.join(outDir, 'resume.bin')));
      // 分片保留（可续传）
      const keptParts = fs.existsSync(path.join(partsRoot, task.id))
        ? fs.readdirSync(path.join(partsRoot, task.id)).length
        : 0;
      check('暂停后保留分片用于续传', keptParts > 0, `parts=${keptParts}`);

      // 续传
      const doneP = waitFor(tm, 'done');
      await tm.start(task.id);
      const finished = await doneP;
      check('续传后任务完成', finished.status === 'COMPLETED', finished.status);
      const outFile = path.join(outDir, 'resume.bin');
      check('续传后文件 SHA256 一致（无错位/空洞）',
        fs.existsSync(outFile) &&
          crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex') === SHA);
      srv.close();
    }

    // ---------- 用例 4：未知大小（无 Content-Length）也能下载 ----------
    {
      const srv = await new Promise((resolve) => {
        const s = http.createServer((req, res) => {
          // 忽略 Range，且不给 Content-Length（分块传输）
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(CONTENT);
        });
        s.listen(0, '127.0.0.1', () => resolve(s));
      });
      const port = srv.address().port;
      const outDir = path.join(TMP, 'case4');
      const tm = new TaskManager({ tempRoot: path.join(TMP, 'parts4'), concurrency: 4 });
      const task = tm.create({
        platform: 'PAN123',
        fid: 'f4',
        fileName: 'unknown.bin',
        url: `http://127.0.0.1:${port}/u.bin`,
        dirPath: outDir,
        size: 0,
        headers: {},
      });
      const doneP = waitFor(tm, 'done');
      tm.on('error', (t) => console.log('  [task error]', t.error));
      await tm.start(task.id);
      const finished = await doneP;
      const outFile = path.join(outDir, 'unknown.bin');
      check('未知大小任务完成', finished.status === 'COMPLETED', finished.status);
      check('未知大小内容 SHA256 一致',
        fs.existsSync(outFile) &&
          crypto.createHash('sha256').update(fs.readFileSync(outFile)).digest('hex') === SHA);
      srv.close();
    }

    // ---------- 用例 5：删除任务清理临时目录 ----------
    {
      const srv = await startServer({});
      const port = srv.address().port;
      const partsRoot = path.join(TMP, 'parts5');
      const tm = new TaskManager({ tempRoot: partsRoot, concurrency: 2 });
      const task = tm.create({
        platform: 'C139',
        fid: 'f5',
        fileName: 'del.bin',
        url: `http://127.0.0.1:${port}/d.bin`,
        dirPath: path.join(TMP, 'case5'),
        size: CONTENT.length,
        headers: {},
      });
      tm.on('error', () => {});
      await tm.start(task.id);
      await new Promise((r) => setTimeout(r, 100));
      await tm.remove(task.id);
      check('删除后任务列表不再包含该任务', tm.get(task.id) === undefined);
      check('删除后临时分片目录已清理', !fs.existsSync(path.join(partsRoot, task.id)));
      srv.close();
    }

    console.log('\n===== SUMMARY =====');
    const failed = results.filter((r) => !r.ok);
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.log('FAILED:');
      failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')));
      app.exit(1);
      return;
    }
    app.exit(0);
  } catch (e) {
    console.error('harness error:', e);
    app.exit(2);
  }
});
