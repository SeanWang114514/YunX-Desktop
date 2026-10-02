/*
 * YunX Desktop —— 平台适配器离线验证（mock server）。
 * 用真实适配器代码打本地 mock server，断言签名/加密/字段映射等
 * 类型检查抓不到的线上格式错误。
 */

const http = require('node:http');
const path = require('node:path');

// 注册 ts 编译产物路径
const DIST = path.join(__dirname, '..', 'dist', 'main');

const { pan123Adapter } = require(path.join(DIST, 'platforms', 'pan123', 'api.js'));
const { c139Adapter } = require(path.join(DIST, 'platforms', 'c139', 'api.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function makeCtx(port, base) {
  return {
    http: (url, opts) => {
      // 把目标域重写到本地 mock
      const rewritten = url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`);
      return fetch(rewritten, opts);
    },
    saveCookie: () => {},
  };
}

(async () => {
  // ============ PAN123 ============
  {
    const captured = {};
    const server = await startServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured[u.pathname] = { headers: req.headers, query: u.searchParams, body };

        if (u.pathname === '/b/api/share/get') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              code: 0,
              data: {
                Expired: false,
                Next: '-1',
                InfoList: [
                  {
                    Type: 1,
                    FileId: 111,
                    FileName: 'folderA',
                    Size: 0,
                    ParentFileId: 0,
                    S3KeyFlag: 'kf-etag-node',
                    Etag: 'e1',
                    StorageNode: 'n1',
                    UpdateAt: '2026-01-01',
                  },
                  {
                    Type: 0,
                    FileId: 222,
                    FileName: 'movie.mp4',
                    Size: 1234,
                    ParentFileId: 0,
                    S3KeyFlag: 'kf2-etag2-node2',
                    Etag: 'e2',
                    StorageNode: 'n2',
                    UpdateAt: '2026-01-01',
                  },
                ],
              },
            }),
          );
          return;
        }
        if (u.pathname === '/b/api/share/download/info') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, data: { DownloadURL: 'http://127.0.0.1:' + 0 } }));
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
    const port = server.address().port;

    // 修正 DownloadURL 指向 mock
    const server2Handler = () => {};
    const ctx = makeCtx(port, 'pan123');

    const session = await pan123Adapter.createSession('2785Vv-T4Ded', null, 'jwt.token.here', ctx);
    check('pan123 createSession 返回 shareId', session.shareId === '2785Vv-T4Ded', session.shareId);

    const files = await pan123Adapter.listFiles(session, '0', 'jwt.token.here', ctx);
    check('pan123 列出 2 个条目', files.length === 2, `got ${files.length}`);
    check(
      'pan123 目录 isdir=true / 文件 isdir=false',
      files[0].isdir === true && files[1].isdir === false,
    );
    check(
      'pan123 fidToken = S3KeyFlag|Etag|StorageNode',
      files[1].fidToken === 'kf2-etag2-node2|e2|n2',
      files[1].fidToken,
    );
    check('pan123 列表仅用 Dart UA', /Dart/.test(captured['/b/api/share/get'].headers['user-agent'] || ''));
    check(
      'pan123 空密码时省略 SharePwd 参数',
      !captured['/b/api/share/get'].query.has('SharePwd'),
    );
    check('pan123 next 固定为 "0"', captured['/b/api/share/get'].query.get('next') === '0');

    // 验证签名算法
    const sign = pan123Adapter.__test_makeSign ? pan123Adapter.__test_makeSign('/b/api/share/download/info') : null;
    if (sign) {
      check('pan123 auth-key 为小写 hex 且不补零', /^[0-9a-f]+$/.test(sign.authKey), sign.authKey);
      check('pan123 auth-value 形如 ts-rand-crc', /^\d+-\d+-[0-9a-f]+$/.test(sign.authValue), sign.authValue);
    }

    server.close();
  }

  // ============ C139 ============
  {
    const captured = {};
    let decryptOk = false;
    const server = await startServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured[u.pathname] = { headers: req.headers, body };

        const crypto = require('node:crypto');
        const key = Buffer.from('PVGDwmcvfs1uV3d1', 'utf8');
        let plain = null;
        try {
          const raw = Buffer.from(body, 'base64');
          const iv = raw.subarray(0, 16);
          const ct = raw.subarray(16);
          const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
          plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
          decryptOk = true;
        } catch (e) {
          decryptOk = false;
        }
        captured[u.pathname].plain = plain;

        const enc = (obj) => {
          const iv = crypto.randomBytes(16);
          const c = crypto.createCipheriv('aes-128-cbc', key, iv);
          const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
          return Buffer.concat([iv, ct]).toString('base64');
        };

        if (u.pathname.endsWith('/getOutLinkGeneral')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            enc({
              success: true,
              resultCode: '0',
              data: {
                getOutLinkGeneralResp: {
                  outLinkGeneral: [{ lkName: 'MyShare', passwd: 'abcd' }],
                },
              },
            }),
          );
          return;
        }
        if (u.pathname.endsWith('/getOutLinkInfoV6')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            enc({
              success: true,
              resultCode: '0',
              data: {
                caLst: [{ caID: 'F1', caName: 'folder1', ctTime: '2026' }],
                coLst: [{ coID: 'C1', coName: 'a.mp4', coSize: 999, coType: 1, ctTime: '2026' }],
              },
            }),
          );
          return;
        }
        if (u.pathname.endsWith('/dlFromOutLinkV3')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            enc({
              success: true,
              resultCode: '0',
              data: { redrUrl: 'http://example.com/f.mp4', fileName: 'a.mp4', coSize: 999 },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end('{}');
      });
    });
    const port = server.address().port;
    const ctx = makeCtx(port, 'c139');
    const credential = 'authorization=Basic:cGM6MTM4MDAxMzgwMDA6dG9rZW4=';

    const session = await c139Adapter.createSession('LINKID123', null, credential, ctx);
    check('c139 createSession 成功', !!session.shareId);

    const files = await c139Adapter.listFiles(session, 'root', credential, ctx);
    check('c139 合并 caLst + coLst（目录+文件）', files.length === 2, `got ${files.length}`);
    check('c139 目录在前', files[0].isdir === true && files[0].fname === 'folder1');
    check('c139 文件在后', files[1].isdir === false && files[1].fname === 'a.mp4');

    check('c139 请求体确实被 AES 加密', decryptOk);
    check(
      'c139 解密后明文是 JSON 且含 linkID',
      captured['/yun-share/richlifeApp/devapp/IOutLink/getOutLinkGeneral'].plain?.includes('LINKID123'),
      captured['/yun-share/richlifeApp/devapp/IOutLink/getOutLinkGeneral'].plain?.slice(0, 80),
    );
    check(
      'c139 列表请求不带 authorization 头',
      !captured['/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6'].headers['authorization'],
    );
    check(
      'c139 加密请求带 hcy-cool-flag',
      captured['/yun-share/richlifeApp/devapp/IOutLink/getOutLinkGeneral'].headers['hcy-cool-flag'] === '1',
    );

    const listPlain = JSON.parse(
      captured['/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6'].plain,
    );
    check(
      'c139 根目录 pCaID 为字面量 "root"',
      listPlain.getOutLinkInfoReq.pCaID === 'root',
      listPlain.getOutLinkInfoReq.pCaID,
    );
    check('c139 列表 account 为空串', listPlain.getOutLinkInfoReq.account === '');

    server.close();
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
