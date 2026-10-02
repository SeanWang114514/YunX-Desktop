/*
 * YunX Desktop (云析桌面版) —— 网络层：HTTP 客户端与通用解析工具。
 */

import { mergeSetCookies } from './cookieJar';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  redirect?: 'follow' | 'error' | 'manual';
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * 统一 HTTP 请求。使用 Node 内置 fetch（undici）。
 * 对齐 Kotlin 版 OkHttp 配置：连接 15s / 读 60s / 写 30s。
 */
export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT);
  try {
    return await fetch(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.headers,
      body: opts.body,
      redirect: opts.redirect ?? 'follow',
      signal: controller.signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new HttpError(`请求超时（${url.slice(0, 80)}）`);
    throw new HttpError(`网络请求失败：${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 请求并返回文本，附带 set-cookie */
export async function httpText(
  url: string,
  opts: HttpOptions = {},
): Promise<{ text: string; status: number; setCookies: string[]; headers: Headers }> {
  const res = await httpRequest(url, opts);
  const text = await res.text();
  return {
    text,
    status: res.status,
    setCookies: res.headers.getSetCookie?.() ?? [],
    headers: res.headers,
  };
}

/** 请求并解析 JSON（宽松：解析失败返回 null） */
export async function httpJson<T = any>(
  url: string,
  opts: HttpOptions = {},
): Promise<{ json: T | null; text: string; status: number; setCookies: string[] }> {
  const r = await httpText(url, opts);
  let json: T | null = null;
  try {
    json = r.text ? (JSON.parse(r.text) as T) : null;
  } catch {
    json = null;
  }
  return { json, text: r.text, status: r.status, setCookies: r.setCookies };
}

export { mergeSetCookies };

/** 表单编码 */
export function formEncode(data: Record<string, string | number>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/** sleep */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
