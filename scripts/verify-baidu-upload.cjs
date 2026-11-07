const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DIST = path.join(__dirname, '..', 'dist', 'main');
const { BaiduUploadAdapter } = require(path.join(__dirname, '..', 'src', 'main', 'upload', 'baiduUpload.ts'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
function readRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

(async () => {
  const captured = [];
  const server = http.createServer(async (req, res) => {
    const body = await readRequest(req);
    const u = new URL(req.url, 'http://127.0.0.1');
    captured.push({ method: req.method, url: u, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname.endsWith('/xpan/file') && u.searchParams.get('method') === 'precreate') {
      res.end(JSON.stringify({ errno: 0, uploadid: 'upload-1', block_list: [1] }));
      return;
    }
    if (u.pathname.endsWith('/pcs/file') && u.searchParams.get('method') === 'locateupload') {
      res.end(JSON.stringify({ error_code: 0, servers: [{ server: 'https://upload.test' }] }));
      return;
    }
    if (u.pathname.endsWith('/superfile2')) {
      res.end(JSON.stringify({ md5: 'part-md5' }));
      return;
    }
    if (u.pathname.endsWith('/xpan/file') && u.searchParams.get('method') === 'create') {
      res.end(JSON.stringify({ errno: 0, fs_id: 99, path: '/apps/demo/test.bin', size: 5242881 }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ errno: 404 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-upload-')), 'test.bin');
  const data = crypto.randomBytes(5 * 1024 * 1024 + 1);
  fs.writeFileSync(file, data);
  const request = (url, init = {}) => {
    const rewritten = url.replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`);
    return fetch(rewritten, init);
  };
  const progress = [];
  const result = await new BaiduUploadAdapter({ request }).upload({
    filePath: file,
    fileName: 'test.bin',
    appName: 'demo',
    tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3600000 },
    signal: new AbortController().signal,
    onProgress: (bytes) => progress.push(bytes),
  });

  const pre = captured.find((r) => r.url.searchParams.get('method') === 'precreate');
  const locate = captured.find((r) => r.url.searchParams.get('method') === 'locateupload');
  const parts = captured.filter((r) => r.url.pathname.endsWith('/superfile2'));
  const create = captured.find((r) => r.url.searchParams.get('method') === 'create');
  const preBody = new URLSearchParams(pre.body.toString());
  const createBody = new URLSearchParams(create.body.toString());
  check('precreate uses documented access token and file fields', pre && pre.url.searchParams.get('access_token') === 'access-1' && preBody.get('path') === '/apps/demo/test.bin' && preBody.get('autoinit') === '1');
  check('precreate block list contains lowercase MD5 values', JSON.parse(preBody.get('block_list')).every((x) => /^[0-9a-f]{32}$/.test(x)));
  check('locateupload uses upload id and version', locate && locate.url.searchParams.get('uploadid') === 'upload-1' && locate.url.searchParams.get('upload_version') === '2.0');
  check('only missing block index is uploaded with documented multipart query fields', parts.length === 1 && parts[0].url.searchParams.get('partseq') === '1' && parts[0].url.searchParams.get('method') === 'upload' && parts[0].url.searchParams.get('type') === 'tmpfile' && /name="file"/.test(parts[0].body.toString()));
  check('create preserves path and uses conflict-fail rtype', createBody.get('path') === '/apps/demo/test.bin' && createBody.get('rtype') === '0');
  check('progress reaches file size after successful missing chunk', progress.reduce((sum, bytes) => sum + bytes, 0) === data.length);
  check('adapter returns created file metadata', result.path === '/apps/demo/test.bin' && result.size === data.length);

  const { readExact } = await import('../src/main/upload/baiduUpload.ts');  let shortReadRejected = false;
  const fakeHandle = { read: async (buffer, offset, length, position) => {
    const available = Math.max(0, 4 - position);
    const bytesRead = Math.min(length, available);
    buffer.fill(65, offset, offset + bytesRead);
    return { bytesRead };
  } };
  try {
    await readExact(fakeHandle, 10, 0);
  } catch (e) { shortReadRejected = /截断|大小/.test(String(e?.message)); }
  check('short read is rejected instead of zero-padded', shortReadRejected);
  const goodHandle = { read: async (buffer, offset, length) => { buffer.fill(65, offset, offset + length); return { bytesRead: length }; } };
  const good = await readExact(goodHandle, 10, 0);
  check('readExact returns the full requested chunk', good.length === 10 && good.every((byte) => byte === 65));

  server.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  const failed = results.filter((x) => !x.ok);
  console.log(`SUMMARY ${results.length - failed.length}/${results.length}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => {
  console.error('harness error:', e.stack || e);
  process.exitCode = 2;
});
