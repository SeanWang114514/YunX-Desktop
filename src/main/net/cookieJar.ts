/*
 * YunX Desktop (云析桌面版) —— 网络层：Cookie 管理。
 */

/** 从 fetch Response 的 set-cookie 提取并合并到已有 Cookie 串 */
export function mergeSetCookies(current: string, setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const part of current.split(';')) {
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
export function getCookie(cookie: string, name: string): string | null {
  for (const part of cookie.split(';')) {
    const t = part.trim();
    const eq = t.indexOf('=');
    if (eq > 0 && t.slice(0, eq) === name) return t.slice(eq + 1);
  }
  return null;
}

/** 设置/替换单个 Cookie 值 */
export function setCookie(cookie: string, name: string, value: string): string {
  const parts = cookie
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => p.slice(0, p.indexOf('=')) !== name);
  parts.push(`${name}=${value}`);
  return parts.join('; ');
}

/** 判断 Cookie 串是否包含指定字段 */
export function hasCookie(cookie: string | null | undefined, name: string): boolean {
  return !!cookie && cookie.includes(`${name}=`);
}

export function withCookies(cookie: string, extra: Record<string, string>): string {
  let out = cookie;
  for (const [k, v] of Object.entries(extra)) out = setCookie(out, k, v);
  return out;
}
