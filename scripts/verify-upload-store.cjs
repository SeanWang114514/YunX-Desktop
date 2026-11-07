const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'yunx-oauth-store-'));
let encryptionAvailable = true;
globalThis.__yunxElectronStub = {
  app: { getPath: () => userData },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8').replace(/^encrypted:/, ''),
  },
};

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const { CredentialStore } = await import('../src/main/store/credentialStore.ts');
  const store = new CredentialStore();
  check('OAuth capability reports encryption state', store.canUseSecureOAuth() === true);
  const config = { appKey: 'app-key', appSecret: 'app-secret', appName: 'YunX', redirectUri: 'oob' };
  const first = { accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: 10 };
  store.saveBaiduOAuth(config, first);
  const file = path.join(userData, 'yunx-store.json');
  const raw = fs.readFileSync(file, 'utf8');
  const roundTrip = store.getBaiduOAuth();
  check('OAuth config and tokens round-trip', roundTrip?.config?.appKey === 'app-key' && roundTrip?.tokens?.refreshToken === 'refresh-one');
  check('OAuth values are not stored as plaintext', !raw.includes('app-secret') && !raw.includes('refresh-one'));
  const rotated = { accessToken: 'access-two', refreshToken: 'refresh-two', expiresAt: 20 };
  store.saveBaiduOAuth(config, rotated);
  check('refresh-token rotation replaces the stored token set', store.getBaiduOAuth()?.tokens?.refreshToken === 'refresh-two');

  const realFile = store.file;
  store.file = path.join(userData, 'missing-dir', 'yunx-store.json');
  let persistenceRejected = false;
  try { store.saveBaiduOAuth(config, { accessToken: 'access-three', refreshToken: 'refresh-three', expiresAt: 30 }); } catch { persistenceRejected = true; }
  store.file = realFile;
  check('OAuth save propagates persistence failure',
    persistenceRejected && store.getBaiduOAuth()?.tokens?.refreshToken === 'refresh-two' && JSON.parse(fs.readFileSync(file, 'utf8')).baiduOAuth.data);

  encryptionAvailable = false;
  let rejected = false;
  try { store.saveBaiduOAuth(config, first); } catch { rejected = true; }
  check('OAuth save is rejected without secure storage', rejected && !store.canUseSecureOAuth());
  check('failed save leaves persisted OAuth data unchanged', store.getBaiduOAuth() === null && !fs.readFileSync(file, 'utf8').includes('refresh-one'));
  encryptionAvailable = true;

  store.saveBaiduOAuth(config, rotated);
  const staleRevision = store.getBaiduOAuthRevision();
  store.clearBaiduOAuth();
  const savedAfterClear = store.saveBaiduOAuthIfCurrent(config, { accessToken: 'stale', refreshToken: 'stale-refresh', expiresAt: 40 }, staleRevision);
  check('refresh result is discarded when OAuth was cleared during the request',
    savedAfterClear === false && store.getBaiduOAuth() === null);
  store.saveBaiduOAuth(config, rotated);
  const currentRevision = store.getBaiduOAuthRevision();
  const savedCurrent = store.saveBaiduOAuthIfCurrent(config, { accessToken: 'fresh', refreshToken: 'fresh-refresh', expiresAt: 50 }, currentRevision);
  check('refresh result is saved when credentials are unchanged',
    savedCurrent === true && store.getBaiduOAuth()?.tokens?.refreshToken === 'fresh-refresh');
  store.clearBaiduOAuth();
  check('clear removes OAuth data', store.getBaiduOAuth() === null);
  const failed = results.filter((x) => !x.ok);
  console.log(`SUMMARY ${results.length - failed.length}/${results.length}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => {
  console.error('harness error:', e.stack || e);
  process.exitCode = 2;
}).finally(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});
