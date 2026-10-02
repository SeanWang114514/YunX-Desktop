/*
 * YunX Desktop (云析桌面版) —— 网络层：Cookie 管理。
 *
 * 注意：凭据类型统一为 `CookieLike = string | null | undefined`。
 * 匿名浏览（未登录）时 credential 为 null，若函数签名只接受 string，
 * TypeScript 不会报错但运行时会抛 "Cannot read properties of null"。
 */

/** 未登录时凭据为 null，所有 Cookie 操作都必须容忍 */
export type CookieLike = string | null | undefined;

/** 从 fetch Response 的 set-cookie 提取并合并到已有 Cookie 串 */
export function mergeSetCookies(current: CookieLike, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of (current ?? '').split(';')) {
    const t = part.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq > 0) jar.set(t.slice(0, eq), t.slice(eq + 1));
  }
  for (const sc of setCookies) {
    const kv = sc.split(';')[0].trim();
    const eq = kv.indexOf('=');
    if (eq > 0) jar.set(kv.slice(0, eq), kv.slice(eq + 1));
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/** 读取单个 Cookie 值 */
export function getCookie(cookie: CookieLike, name: string): string | null {
  for (const part of (cookie ?? '').split(';')) {
    const t = part.trim();
    const eq = t.indexOf('=');
    if (eq > 0 && t.slice(0, eq) === name) return t.slice(eq + 1);
  }
  return null;
}

/** 设置/替换单个 Cookie 值 */
export function setCookie(cookie: CookieLike, name: string, value: string): string {
  const parts = (cookie ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => p.slice(0, p.indexOf('=')) !== name);
  parts.push(`${name}=${value}`);
  return parts.join('; ');
}

/** 判断 Cookie 串是否包含指定字段 */
export function hasCookie(cookie: CookieLike, name: string): boolean {
  return !!cookie && cookie.includes(`${name}=`);
}

/** 未登录时返回空串，供直接拼进请求头 */
export function cookieOrEmpty(cookie: CookieLike): string {
  return cookie ?? '';
}

export function withCookies(cookie: CookieLike, extra: Record<string, string>): string {
  let out = cookie ?? '';
  for (const [k, v] of Object.entries(extra)) out = setCookie(out, k, v);
  return out;
}
