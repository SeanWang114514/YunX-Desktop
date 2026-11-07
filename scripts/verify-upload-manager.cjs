const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UploadManager } = require('../src/main/upload/uploadManager.ts');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-manager-'));
  const fileA = path.join(dir, 'a.txt');
  const fileB = path.join(dir, 'b.txt');
  fs.writeFileSync(fileA, 'a');
  fs.writeFileSync(fileB, 'b');
  const calls = [];
  const adapter = { upload: async (input) => { calls.push(input.fileName); input.onProgress(1); return { path: `/apps/demo/${input.fileName}`, size: 1 }; } };
  const queuedTasks = [];
  const manager = new UploadManager({ secureOAuth: () => true, getBaiduOAuth: () => ({ config: { appName: 'demo' }, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } }), adapter });
  manager.on('progress', (task) => queuedTasks.push(task));
  const tasks = await manager.create([{ filePath: fileA }, { filePath: fileB }], 'BAIDU');
  check('create queues multiple files', tasks.length === 2 && tasks.every((t) => t.status === 'PENDING'));
  check('source paths never leave the main process',
    tasks.every((t) => !Object.hasOwn(t, 'sourcePath')) &&
    manager.list().every((t) => !Object.hasOwn(t, 'sourcePath')) &&
    !Object.hasOwn(manager.get(tasks[0].id), 'sourcePath'));
  await sleep(50);
  check('queue runs files serially and completes', calls.join(',') === 'a.txt,b.txt' && manager.list().every((t) => t.status === 'COMPLETED'));
  check('progress events never expose source paths', queuedTasks.length > 0 && queuedTasks.every((t) => !Object.hasOwn(t, 'sourcePath')));
  let unsupported = false;
  try { await manager.create([{ filePath: fileA }], 'QUARK'); } catch { unsupported = true; }
  check('unsupported platform rejected before adapter', unsupported && calls.length === 2);
  let directoryRejected = false;
  try { await manager.create([{ filePath: dir }], 'BAIDU'); } catch { directoryRejected = true; }
  check('directory path rejected', directoryRejected && calls.length === 2);
  let grantInvalid = false;
  try { await manager.createFromGrants([{ filePath: fileA }], 'BAIDU'); } catch { grantInvalid = true; }
  check('renderer-supplied raw path is not a usable upload grant', grantInvalid && calls.length === 2);
  const [fileGrant] = await manager.grantFiles([fileA]);
  check('file grant exposes only an opaque token and display metadata', !!fileGrant.fileToken && !Object.hasOwn(fileGrant, 'filePath'));
  const [grantedTask] = await manager.createFromGrants([{ fileToken: fileGrant.fileToken }], 'BAIDU');
  await sleep(30);
  check('one-time file grant creates a task', !!grantedTask && manager.get(grantedTask.id)?.status === 'COMPLETED' && calls.length === 3);
  let reusedGrantRejected = false;
  try { await manager.createFromGrants([{ fileToken: fileGrant.fileToken }], 'BAIDU'); } catch { reusedGrantRejected = true; }
  check('file grant cannot be reused', reusedGrantRejected && calls.length === 3);
  let nameRejected = false;
  const [nameGrant] = await manager.grantFiles([fileA]);
  try { await manager.createFromGrants([{ fileToken: nameGrant.fileToken, fileName: '../x' }], 'BAIDU'); } catch { nameRejected = true; }
  check('traversal destination rejected', nameRejected && calls.length === 3);
  const countBeforeInvalidBatch = manager.list().length;
  let batchRejected = false;
  const [batchGrant] = await manager.grantFiles([fileA]);
  try { await manager.createFromGrants([{ fileToken: batchGrant.fileToken }, { fileToken: 'missing-grant' }], 'BAIDU'); } catch { batchRejected = true; }
  await sleep(50);
  check('invalid multi-file selection is rejected atomically',
    batchRejected && manager.list().length === countBeforeInvalidBatch && calls.length === 3);
  let refreshedToken = '';
  let refreshCalls = 0;
  let currentOAuth = { config: { appName: 'demo' }, tokens: { accessToken: 'expired', refreshToken: 'refresh-old', expiresAt: Date.now() - 1 } };
  const refreshManager = new UploadManager({
    secureOAuth: () => true,
    getBaiduOAuth: () => currentOAuth,
    refreshBaiduOAuth: async () => {
      refreshCalls++;
      currentOAuth = { config: { appName: 'demo' }, tokens: { accessToken: 'fresh', refreshToken: 'refresh-new', expiresAt: Date.now() + 3600000 } };
      return currentOAuth;
    },
    adapter: { upload: async (input) => { refreshedToken = input.tokens.accessToken; return { path: `/apps/demo/${input.fileName}`, size: 1 }; } },
  });
  await refreshManager.create([{ filePath: fileA }], 'BAIDU');
  await sleep(50);
  check('expired OAuth token refreshes before upload', refreshedToken === 'fresh' && refreshCalls === 1);
  const cancelEvents = [];
  const cancellableManager = new UploadManager({
    secureOAuth: () => true,
    getBaiduOAuth: () => ({ config: { appName: 'demo' }, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } }),
    adapter: { upload: async ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) },
  });
  cancellableManager.on('error', (task) => cancelEvents.push(`error:${task.status}`));
  cancellableManager.on('progress', (task) => cancelEvents.push(`progress:${task.status}`));
  const [cancelTask] = await cancellableManager.create([{ filePath: fileA }], 'BAIDU');
  await sleep(20);
  cancellableManager.cancel(cancelTask.id);
  await sleep(20);
  check('cancellation emits cancelled progress, not upload failure',
    cancellableManager.get(cancelTask.id)?.status === 'CANCELLED' && !cancelEvents.includes('error:CANCELLED'));

  const partialEvents = [];
  const partialManager = new UploadManager({
    secureOAuth: () => true,
    getBaiduOAuth: () => ({ config: { appName: 'demo' }, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } }),
    adapter: { upload: async ({ signal, onProgress }) => {
      onProgress(5);
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return { path: '/apps/demo/a.txt', size: 10 };
    } },
  });
  partialManager.on('progress', (task) => partialEvents.push(task));
  const [partialTask] = await partialManager.create([{ filePath: fileA }], 'BAIDU');
  await sleep(20);
  partialManager.cancel(partialTask.id);
  await sleep(20);
  check('cancellation after partial upload documents remote residue',
    partialManager.get(partialTask.id)?.status === 'CANCELLED' && /远端可能残留临时分片/.test(partialManager.get(partialTask.id)?.error || '') && partialEvents.some((task) => task.status === 'CANCELLED'));

  let refreshStarted;
  const refreshGate = new Promise((resolve) => { refreshStarted = resolve; });
  let releaseRefresh;
  const refreshRelease = new Promise((resolve) => { releaseRefresh = resolve; });
  let firstUploadStarted;
  const firstUploadGate = new Promise((resolve) => { firstUploadStarted = resolve; });
  let releaseFirstUpload;
  const firstUploadRelease = new Promise((resolve) => { releaseFirstUpload = resolve; });
  let refreshUploadCalls = 0;
  let adapterCalls = 0;
  let refreshOAuth = { config: { appName: 'demo' }, tokens: { accessToken: 'fresh', refreshToken: 'r', expiresAt: Date.now() + 3600000 } };
  const refreshRaceManager = new UploadManager({
    secureOAuth: () => true,
    getBaiduOAuth: () => refreshOAuth,
    refreshBaiduOAuth: async () => {
      refreshStarted();
      await refreshRelease;
      refreshOAuth = { config: { appName: 'demo' }, tokens: { accessToken: 'new', refreshToken: 'r2', expiresAt: Date.now() + 3600000 } };
      return refreshOAuth;
    },
    adapter: { upload: async () => {
      adapterCalls++;
      if (adapterCalls === 1) {
        firstUploadStarted();
        await firstUploadRelease;
      } else refreshUploadCalls++;
      return { path: '/apps/demo/race.txt', size: 1 };
    } },
  });
  const [firstRaceTask, secondRaceTask] = await refreshRaceManager.create([{ filePath: fileA }, { filePath: fileB }], 'BAIDU');
  await firstUploadGate;
  refreshOAuth = { config: { appName: 'demo' }, tokens: { accessToken: 'expired', refreshToken: 'r', expiresAt: Date.now() - 1 } };
  releaseFirstUpload();
  await refreshGate;
  refreshRaceManager.cancel(secondRaceTask.id);
  releaseRefresh();
  await sleep(30);
  check('cancellation during OAuth refresh prevents adapter start',
    refreshRaceManager.get(secondRaceTask.id)?.status === 'CANCELLED' && refreshUploadCalls === 0 && refreshRaceManager.get(firstRaceTask.id)?.status === 'COMPLETED');

  const removalEvents = [];
  const removableManager = new UploadManager({
    secureOAuth: () => true,
    getBaiduOAuth: () => ({ config: { appName: 'demo' }, tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 } }),
    adapter: {
      upload: async ({ signal }) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        throw new Error('aborted');
      },
    },
  });
  removableManager.on('done', () => removalEvents.push('done'));
  removableManager.on('error', () => removalEvents.push('error'));
  const [removableTask] = await removableManager.create([{ filePath: fileA }], 'BAIDU');
  await sleep(20);
  removableManager.remove(removableTask.id);
  await sleep(20);
  check('removed running task stays removed', removableManager.list().length === 0 && removalEvents.length === 0);
  fs.rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((x) => !x.ok);
  console.log(`SUMMARY ${results.length - failed.length}/${results.length}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e.stack || e); process.exitCode = 2; });
