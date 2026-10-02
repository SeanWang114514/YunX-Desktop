/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 ChunkDownloader.kt + DownloadManager.kt。
 * 使用 Node 内置 fetch 的分片并发下载器：
 *   - Range 分片 + 多线程并发 + 断点续传（分片落盘为独立 .part 文件）；
 *   - 服务器忽略 Range（200 整文件）时绝不整文件写入单片，交由上层回退单流；
 *   - 写入后严格校验「已写字节 == 预期字节」，杜绝空洞/损坏文件；
 *   - 任务级取消：记录 AbortController，暂停/删除时立即中断阻塞 IO。
 */

import { createWriteStream, existsSync, mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { contentRangeMatches, parseContentRange, isHtmlResponse } from './rangePolicy';

/** 分片单次失败后的瞬时 IO 重试次数 */
const CHUNK_RETRIES = 3;
/** 服务器忽略 Range 时对单分片重试 Range 的次数 */
const RANGE_RETRIES = 4;
/** 网络读缓冲：64KB */
export const BUFFER_SIZE = 64 * 1024;

export enum ChunkResult {
  OK = 'OK',
  RANGE_IGNORED = 'RANGE_IGNORED',
  FAILED = 'FAILED',
}

/** 慢连接抢占信号（由看门狗置位：断开当前连接，保留已写字节，换新连接续传） */
export class PreemptSignal {
  private flag = false;
  set(): void {
    this.flag = true;
  }
  reset(): void {
    this.flag = false;
  }
  get(): boolean {
    return this.flag;
  }
}

export class PreemptedError extends Error {
  constructor() {
    super('慢连接抢占');
  }
}

export class CancelledError extends Error {
  constructor(msg = '下载被取消') {
    super(msg);
    this.name = 'CancelledError';
  }
}

export interface DownloadChunkOptions {
  url: string;
  start: number;
  end: number;
  partFile: string;
  headers: Record<string, string>;
  preempt?: PreemptSignal;
  signal?: AbortSignal;
  onBytes: (n: number) => void;
}

/** 当前 part 文件已有字节数（断点续传起点） */
async function partLength(partFile: string): Promise<number> {
  try {
    const s = await stat(partFile);
    return s.size;
  } catch {
    return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 探测文件总大小：先带 Range: bytes=0-0 请求（期望 206 + Content-Range），
 * 失败再退回普通 GET 读 Content-Length。
 */
export async function getTotalSize(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<number | null> {
  const withRange = await probeSize(url, headers, true, signal);
  if (withRange !== null) return withRange;
  return probeSize(url, headers, false, signal);
}

async function probeSize(
  url: string,
  headers: Record<string, string>,
  withRange: boolean,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const reqHeaders: Record<string, string> = { ...headers };
    if (withRange) reqHeaders['Range'] = 'bytes=0-0';
    const res = await fetch(url, { headers: reqHeaders, signal });
    // 防盗链/过期/错误页（HTML）直接视为无法取大小
    if (isHtmlResponse(res.headers.get('content-type'))) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    if (withRange) {
      if (res.status !== 206) {
        await res.body?.cancel();
        return null;
      }
      const range = parseContentRange(res.headers.get('content-range'));
      await res.body?.cancel();
      if (!range || range.start !== 0 || range.end !== 0) return null;
      return range.total;
    }
    const len = Number(res.headers.get('content-length') ?? 0);
    await res.body?.cancel();
    return len > 0 ? len : null;
  } catch {
    return null;
  }
}

/**
 * 下载一个分片到 partFile（断点续传）。
 * - 瞬时 IO 异常：线性退避重试（CHUNK_RETRIES）；
 * - 服务器忽略 Range（返回 200）：立即返回 RANGE_IGNORED，由上层决定回退单流，
 *   绝不为单个分片下载整文件；
 * - 写入后校验「已写字节 == 预期字节」，不足按失败处理（避免空洞文件）。
 */
export async function downloadChunk(opts: DownloadChunkOptions): Promise<ChunkResult> {
  const { url, start, end, partFile, headers, preempt, signal, onBytes } = opts;
  const attempts = CHUNK_RETRIES + RANGE_RETRIES;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new CancelledError();

    const existing = await partLength(partFile);
    const from = start + existing;
    const unknownTotal = end === Number.MAX_SAFE_INTEGER;
    const expected = unknownTotal ? -1 : end - start + 1;

    // 分片已完整（断点续传）：直接成功
    if (!unknownTotal && existing >= expected) return ChunkResult.OK;

    let preempted = false;
    let res: ChunkResult | null = null;
    try {
      res = await doChunkAttempt({
        url,
        from,
        end,
        unknownTotal,
        partFile,
        headers,
        existing,
        preempt,
        signal,
        onBytes,
      });
    } catch (e) {
      if (e instanceof CancelledError || signal?.aborted) throw new CancelledError();
      if (e instanceof PreemptedError) {
        // 慢连接抢占：已写字节保留，下一轮从 partFile 长度续传；零退避立即换连接
        preempt?.reset();
        preempted = true;
        res = null;
      } else {
        res = null;
      }
    }

    if (res === ChunkResult.OK) return ChunkResult.OK;
    if (res === ChunkResult.FAILED) return ChunkResult.FAILED;
    if (res === ChunkResult.RANGE_IGNORED) return ChunkResult.RANGE_IGNORED;

    // 抢占属于「换连接」，不等退避；只有真实 IO 异常才退避
    if (!preempted && attempt < attempts - 1) {
      await sleep(Math.min(500 * (attempt + 1), 3000));
    }
  }
  return ChunkResult.FAILED;
}

/** 单次分片请求（不重试） */
async function doChunkAttempt(args: {
  url: string;
  from: number;
  end: number;
  unknownTotal: boolean;
  partFile: string;
  headers: Record<string, string>;
  existing: number;
  preempt?: PreemptSignal;
  signal?: AbortSignal;
  onBytes: (n: number) => void;
}): Promise<ChunkResult> {
  const { url, from, end, unknownTotal, partFile, headers, existing, preempt, signal, onBytes } = args;

  const reqHeaders: Record<string, string> = {
    ...headers,
    Range: unknownTotal ? `bytes=${from}-` : `bytes=${from}-${end}`,
  };

  const res = await fetch(url, { headers: reqHeaders, signal });

  // 防盗链/广告回退页：直接判失败
  if (isHtmlResponse(res.headers.get('content-type'))) {
    await res.body?.cancel();
    return ChunkResult.FAILED;
  }

  if (res.status === 206) {
    const requestedEnd = unknownTotal ? null : end;
    if (!contentRangeMatches(res.headers.get('content-range'), from, requestedEnd)) {
      await res.body?.cancel();
      return ChunkResult.FAILED;
    }
    if (!res.body) return ChunkResult.FAILED;
    const expected = unknownTotal ? -1 : end - from + 1;
    const written = await writeSlice(res.body, partFile, existing, expected, preempt, onBytes);
    // 慢连接抢占：主动断开、保留已写字节
    if (preempt?.get()) throw new PreemptedError();
    // 校验：206 也必须写满预期字节，否则视为失败（防空洞/损坏）
    if (!unknownTotal && written !== expected) return ChunkResult.FAILED;
    return ChunkResult.OK;
  }

  if (res.status === 200) {
    // Range 请求被忽略：拒绝按分片写入整文件
    await res.body?.cancel();
    return ChunkResult.RANGE_IGNORED;
  }

  await res.body?.cancel();
  return ChunkResult.FAILED;
}

/** 把响应流写入 partFile（追加到 existing 之后），按 expected 截断；返回实际写入字节数 */
async function writeSlice(
  body: ReadableStream<Uint8Array>,
  partFile: string,
  existing: number,
  expected: number,
  preempt: PreemptSignal | undefined,
  onBytes: (n: number) => void,
): Promise<number> {
  const fd = openSync(partFile, existsSync(partFile) ? 'r+' : 'w+');
  let written = 0;
  const reader = body.getReader();
  try {
    // 定位到已有长度之后（追加写入）
    const { ftruncateSync } = await import('node:fs');
    ftruncateSync(fd, existing);
    // Node 的 writeSync 需要位置参数来随机写；用 'a' 语义不可靠，这里显式 seek
    let pos = existing;
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      // 服务器可能忽略 end 返回超量 body：严格截断，避免文件膨胀
      const allow = expected < 0 ? value.length : Math.min(value.length, expected - written);
      if (allow <= 0) break;
      writeSync(fd, value, 0, allow, pos);
      pos += allow;
      written += allow;
      onBytes(allow);
      // 慢连接抢占：立即停止读取，已写字节保留
      if (preempt?.get()) break;
      if (expected >= 0 && written >= expected) break;
    }
  } finally {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* ignore */
    }
    closeSync(fd);
  }
  return written;
}

/**
 * 单流整文件下载（Range 被忽略时的回退路径）。
 * 完整 GET 从字节 0 开始，必须丢弃任何旧前缀，禁止「旧前缀 + 完整响应」拼接损坏。
 */
export async function downloadFull(opts: {
  url: string;
  partFile: string;
  headers: Record<string, string>;
  total?: number;
  signal?: AbortSignal;
  onBytes: (n: number) => void;
  onMergeProgress?: (n: number) => void;
}): Promise<boolean> {
  const { url, partFile, headers, total = -1, signal, onBytes, onMergeProgress } = opts;

  // 完整 GET 必须从 0 开始，清空旧文件
  const fd0 = openSync(partFile, 'w');
  closeSync(fd0);

  const res = await fetch(url, { headers, signal });

  if (isHtmlResponse(res.headers.get('content-type'))) {
    await res.body?.cancel();
    throw new Error('下载失败：链接已失效或需要 Referer（返回 HTML 页）');
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`下载失败 HTTP ${res.status}`);
  }
  if (!res.body) return false;

  const expected = total > 0 ? total : -1;
  let written = 0;
  const fd = openSync(partFile, 'r+');
  const reader = res.body.getReader();
  try {
    let pos = 0;
    while (true) {
      if (signal?.aborted) throw new CancelledError();
      const { done, value } = await reader.read();
      if (done || !value) break;
      const allow = expected < 0 ? value.length : Math.min(value.length, expected - written);
      if (allow <= 0) break;
      writeSync(fd, value, 0, allow, pos);
      pos += allow;
      written += allow;
      onBytes(allow);
      onMergeProgress?.(written);
      if (expected >= 0 && written >= expected) break;
    }
  } finally {
    try {
      reader.cancel().catch(() => {});
    } catch {
      /* ignore */
    }
    closeSync(fd);
  }

  // 已知总大小：落盘必须恰好达到 total，否则视为失败（防空洞/截断损坏）
  if (total > 0 && written < total) return false;
  return true;
}

/** 分片文件名 */
export function chunkPath(dir: string, index: number): string {
  return join(dir, `chunk_${String(index).padStart(5, '0')}.part`);
}

/** 确保目录存在 */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 顺序合并分片到最终文件，写完一片立即删除该片（边写边删，避免峰值占用翻倍）。
 * onProgress 每写完一个分片回调一次（大文件合并耗时较长，用于上报「合并中」进度）。
 */
export async function mergeChunks(
  chunkFiles: string[],
  outFile: string,
  signal?: AbortSignal,
  onProgress?: (mergedBytes: number) => void,
): Promise<number> {
  const { createReadStream } = await import('node:fs');
  const out = createWriteStream(outFile);
  let total = 0;

  try {
    for (const part of chunkFiles) {
      if (signal?.aborted) throw new CancelledError();
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(part, { highWaterMark: BUFFER_SIZE });
        rs.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
          total += buf.length;
          const ok = out.write(buf);
          if (!ok) rs.pause();
          if (signal?.aborted) {
            rs.destroy();
            reject(new CancelledError());
            return;
          }
          if (!ok) out.once('drain', () => rs.resume());
        });
        rs.on('end', () => resolve());
        rs.on('error', reject);
      });
      // 该片已完整写入目标，立即释放分片空间
      try {
        await unlink(part);
      } catch {
        /* 删除失败不阻断 */
      }
      onProgress?.(total);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return total;
}
