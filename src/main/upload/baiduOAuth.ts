import { randomBytes } from 'node:crypto';
import type { BaiduOAuthConfig, BaiduOAuthTokens } from '../../shared/types';

export const BAIDU_OAUTH_AUTHORIZE_URL = 'https://openapi.baidu.com/oauth/2.0/authorize';
export const BAIDU_OAUTH_TOKEN_URL = 'https://openapi.baidu.com/oauth/2.0/token';
export const BAIDU_OAUTH_OOB_URL = 'http://openapi.baidu.com/oauth/2.0/login_success';

export function createBaiduAuthorizeUrl(config: BaiduOAuthConfig, state = randomBytes(16).toString('hex')): { url: string; state: string } {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.appKey,
    redirect_uri: config.redirectUri || 'oob',
    scope: 'basic,netdisk',
    state,
  });
  return { url: `${BAIDU_OAUTH_AUTHORIZE_URL}?${params.toString()}`, state };
}

export function parseBaiduOAuthCallback(url: string, expectedState: string): string {
  const callback = new URL(url);
  const expected = new URL(BAIDU_OAUTH_OOB_URL);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname) throw new Error('百度 OAuth 回调地址不匹配');
  if (!expectedState || callback.searchParams.get('state') !== expectedState) throw new Error('百度 OAuth state 校验失败');
  const error = callback.searchParams.get('error');
  if (error) throw new Error(`百度 OAuth 授权失败：${error}`);
  const code = callback.searchParams.get('code')?.trim();
  if (!code) throw new Error('百度 OAuth 回调未返回授权码');
  return code;
}

async function requestToken(params: URLSearchParams, request: typeof fetch): Promise<BaiduOAuthTokens> {
  const res = await request(`${BAIDU_OAUTH_TOKEN_URL}?${params.toString()}`, { method: 'GET' });
  const json: any = await res.json();
  if (!res.ok || json?.error || !json?.access_token || !json?.refresh_token) {
    throw new Error(`百度 OAuth 令牌请求失败：${json?.error_description || json?.error || res.status}`);
  }
  return {
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token),
    expiresAt: Date.now() + Math.max(0, Number(json.expires_in) || 0) * 1000,
  };
}

export function exchangeBaiduCode(config: BaiduOAuthConfig, code: string, request: typeof fetch = fetch): Promise<BaiduOAuthTokens> {
  return requestToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: config.appKey,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri || 'oob',
  }), request);
}

export function refreshBaiduToken(config: BaiduOAuthConfig, refreshToken: string, request: typeof fetch = fetch): Promise<BaiduOAuthTokens> {
  return requestToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.appKey,
    client_secret: config.appSecret,
  }), request);
}
