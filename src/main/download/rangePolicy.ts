/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 HttpRangePolicy.kt。
 */

export interface ContentRange {
  start: number;
  end: number;
  total: number | null;
}

const RANGE_RE = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i;

/** 解析 Content-Range 响应头 */
export function parseContentRange(value: string | null | undefined): ContentRange | null {
  if (!value) return null;
  const m = RANGE_RE.exec(value.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || end < start) return null;
  if (total !== null && end >= total) return null;
  return { start, end, total };
}

/** 校验响应 Content-Range 是否与请求区间一致 */
export function contentRangeMatches(
  value: string | null | undefined,
  requestedStart: number,
  requestedEnd: number | null,
): boolean {
  const range = parseContentRange(value);
  if (!range) return false;
  if (range.start !== requestedStart) return false;
  return requestedEnd === null || range.end === requestedEnd;
}

/** 判定响应是否为 HTML 错误页（防盗链 / 链接过期 / 广告页） */
export function isHtmlResponse(contentType: string | null | undefined): boolean {
  return !!contentType && contentType.toLowerCase().includes('text/html');
}
