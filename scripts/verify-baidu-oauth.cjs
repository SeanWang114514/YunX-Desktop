const { createBaiduAuthorizeUrl, parseBaiduOAuthCallback, exchangeBaiduCode, refreshBaiduToken } = require('../src/main/upload/baiduOAuth.ts');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const config = { appKey: 'key-1', appSecret: 'secret-1', appName: 'demo', redirectUri: 'oob' };
  const auth = createBaiduAuthorizeUrl(config, 'state-1');
  const authUrl = new URL(auth.url);
  check('authorization URL has official scope and client', authUrl.origin === 'https://openapi.baidu.com' && authUrl.pathname === '/oauth/2.0/authorize' && authUrl.searchParams.get('scope') === 'basic,netdisk' && authUrl.searchParams.get('client_id') === 'key-1');
  check('authorization URL preserves state', auth.state === 'state-1' && authUrl.searchParams.get('state') === 'state-1');
  check('OOB callback returns one-time code', parseBaiduOAuthCallback('http://openapi.baidu.com/oauth/2.0/login_success?code=code-1&state=state-1', 'state-1') === 'code-1');
  let rejected = false;
  try { parseBaiduOAuthCallback('http://openapi.baidu.com/oauth/2.0/login_success?code=code-1&state=bad', 'state-1'); } catch { rejected = true; }
  check('callback rejects mismatched state', rejected);

  const requests = [];
  const request = async (url, opts) => {
    requests.push({ url: new URL(url), opts });
    return new Response(JSON.stringify({ access_token: 'access-1', refresh_token: 'refresh-2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const exchanged = await exchangeBaiduCode(config, 'code-1', request);
  const refreshed = await refreshBaiduToken(config, 'refresh-1', request);
  check('code exchange uses GET and authorization-code fields', requests[0].opts.method === 'GET' && requests[0].url.searchParams.get('grant_type') === 'authorization_code' && requests[0].url.searchParams.get('client_secret') === 'secret-1');
  check('refresh rotates to returned refresh token', refreshed.refreshToken === 'refresh-2' && exchanged.accessToken === 'access-1');
  const failed = results.filter((x) => !x.ok);
  console.log(`SUMMARY ${results.length - failed.length}/${results.length}`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((e) => { console.error(e.stack || e); process.exitCode = 2; });
