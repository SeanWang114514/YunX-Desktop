/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 任务管理器：分片调度 + 并发上限 + 进度上报 + 暂停/续传。
 * 对应 Kotlin 版 DownloadManager.kt 的核心职责（桌面端简化了 Android 的
 * 前台 Service / ScopedStorage / 通知，保留分片契约与断点续传语义）。
 */

import { EventEmitter } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadTask, TaskStatus } from '../../shared/types';
import type { SharePlatform } from '../../shared/types';import {
  ChunkResult,
  PreemptSignal,
  CancelledError,
  downloadChunk,
  downloadFull,
  getTotalSize,
  chunkPath,
  ensureDir,
  mergeChunks,
} from './chunkDownloader';

/** 默认并发分片数（对齐 Kotlin 版并发上限 32，桌面端默认 16 更稳） */
const DEFAULT_CONCURRENCY = 16;
/** 单片目标大小：无法确定时按此切分 */
const MIN_CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_CHUNKS = 64;

export interface TaskManagerOptions {
  /** 分片并发数 */
  concurrency?: number;
  /** 分片落盘的临时根目录 */
  tempRoot: string;
}

interface Runtime {
  task: DownloadTask;
  controller: AbortController;
  chunks: number;
  chunkSize: number;
  usedFullStream: boolean;
  bytesSinceTick: number;
  lastTick: number;
  speedMbps: number;
  /** 当前 run() 的 promise；暂停/删除时需等它真正退出，避免竞态 */
  running: Promise<void> | null;
}

export interface TaskEvents {
  progress: (task: DownloadTask) => void;
  done: (task: DownloadTask) => void;
  error: (task: DownloadTask) => void;
}

export class TaskManager extends EventEmitter {
  private runtimes = new Map<string, Runtime>();
  private opts: Required<TaskManagerOptions>;

  constructor(opts: TaskManagerOptions) {
    super();
    this.opts = {
      concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
      tempRoot: opts.tempRoot,
    };
  }

  list(): DownloadTask[] {
    return [...this.runtimes.values()].map((r) => ({ ...r.task }));
  }

  get(id: string): DownloadTask | undefined {
    const r = this.runtimes.get(id);
    return r ? { ...r.task } : undefined;
  }

  private emitProgress(rt: Runtime): void {
    const t = rt.task;
    const now = Date.now();
    const dt = (now - rt.lastTick) / 1000;
    if (dt >= 0.5) {
      t.speedBps = Math.floor(rt.bytesSinceTick / dt);
      rt.bytesSinceTick = 0;
      rt.lastTick = now;
      this.emit('progress', { ...t });
    }
  }

  /** 新建任务（不自动开始） */
  create(input: {
    platform: SharePlatform;
    fid: string;
    fileName: string;
    url: string;
    dirPath: string;
    size: number;
    cleanupDirFid?: string | null;
    headers?: Record<string, string>;
  }): DownloadTask {
    const id = randomUUID();
    const task: DownloadTask = {
      id,
      platform: input.platform,
      fid: input.fid,
      fileName: input.fileName,
      url: input.url,
      dirPath: input.dirPath,
      totalBytes: input.size,
      downloadedBytes: 0,
      status: 'PENDING',
      chunks: 0,
      createdAt: Date.now(),
      cleanupDirFid: input.cleanupDirFid ?? null,
      headers: input.headers ?? {},
    };
    this.runtimes.set(id, {
      task,
      controller: new AbortController(),
      chunks: 0,
      chunkSize: 0,
      usedFullStream: false,
      bytesSinceTick: 0,
      lastTick: Date.now(),
      speedMbps: 0,
      running: null,
    });
    return { ...task };
  }

  /** 分片落盘目录 */
  private partDir(id: string): string {
    return join(this.opts.tempRoot, id);
  }

  /** 启动/继续任务 */
  async start(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) throw new Error('任务不存在');
    if (rt.task.status === 'RUNNING') return;

    rt.controller = new AbortController();
    rt.task.status = 'RUNNING';
    rt.task.error = undefined;
    rt.lastTick = Date.now();
    rt.bytesSinceTick = 0;
    this.emit('progress', { ...rt.task });

    // 后台执行，立即返回（用通知上报进度）。
    // 记录 promise：暂停/删除时 await 它，避免清理与在飞写入竞态。
    const p = this.run(rt)
      .catch((e) => {
        if (e instanceof CancelledError) return;
        rt.task.status = 'FAILED';
        rt.task.error = e?.message ?? String(e);
        this.emit('error', { ...rt.task });
      })
      .finally(() => {
        if (rt.running === p) rt.running = null;
      });
    rt.running = p;
  }

  /** 任务主体 */
  private async run(rt: Runtime): Promise<void> {
    const t = rt.task;
    const signal = rt.controller.signal;

    if (!existsSync(t.dirPath)) await mkdir(t.dirPath, { recursive: true });
    ensureDir(this.partDir(t.id));

    // 1) 探测总大小（失败则走单流）
    if (!t.totalBytes || t.totalBytes <= 0) {
      const size = await getTotalSize(t.url, t.headers ?? {}, signal);
      if (signal.aborted) throw new CancelledError();
      if (size && size > 0) t.totalBytes = size;
    }

    // 2) 规划分片
    const total = t.totalBytes > 0 ? t.totalBytes : -1;
    const plan = this.planChunks(total);
    rt.chunks = plan.count;
    rt.chunkSize = plan.size;
    t.chunks = plan.count;
    this.emit('progress', { ...t });

    // 已是单流模式（无法分片）：直接整文件
    if (plan.count <= 1) {
      await this.runSingleStream(rt);
      return;
    }

    // 3) 并发分片下载
    const results = await this.runChunks(rt, plan);
    if (signal.aborted) throw new CancelledError();

    const allOk = results.every((r) => r === ChunkResult.OK);
    const anyRangeIgnored = results.some((r) => r === ChunkResult.RANGE_IGNORED);

    if (!allOk && anyRangeIgnored) {
      // 服务器忽略 Range：清理分片，回退单流整文件
      this.cleanParts(t.id);
      rt.task.downloadedBytes = 0;
      await this.runSingleStream(rt);
      return;
    }
    if (!allOk) {
      throw new Error('部分分片下载失败，可点击继续重试');
    }

    // 4) 合并分片 → 最终文件（边写边删）
    //    ★ 先合并到同目录下的 .yunx-part 临时文件，全部写完后才 rename 到最终名。
    //    这样暂停/中断时不会在最终路径留下「看起来已完成」的截断文件。
    //    （必须同目录 rename：跨卷 rename 会失败）
    const target = join(t.dirPath, t.fileName);
    const staging = `${target}.yunx-part`;
    const parts = Array.from({ length: plan.count }, (_, i) => chunkPath(this.partDir(t.id), i));
    let merged: number;
    try {
      merged = await mergeChunks(parts, staging, signal, (bytes) => {
        t.downloadedBytes = bytes;
        this.emitProgress(rt);
      });
    } catch (e) {
      // 中断/失败：清掉半成品暂存文件，保留分片以便续传
      try {
        rmSync(staging, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    }
    if (signal.aborted) {
      try {
        rmSync(staging, { force: true });
      } catch {
        /* ignore */
      }
      throw new CancelledError();
    }

    if (total > 0 && merged < total) {
      try {
        rmSync(staging, { force: true });
      } catch {
        /* ignore */
      }
      throw new Error(`写入不足：${merged} / ${total} 字节`);
    }

    // 原子落位
    await rename(staging, target);

    this.cleanParts(t.id);
    rt.task.status = 'COMPLETED';
    rt.task.downloadedBytes = rt.task.totalBytes || merged;
    rt.task.speedBps = 0;
    this.emit('done', { ...rt.task });
  }

  /** 分片规划 */
  private planChunks(total: number): { count: number; size: number } {
    if (total <= 0) return { count: 1, size: 0 };
    let count = Math.min(MAX_CHUNKS, Math.max(1, Math.ceil(total / MIN_CHUNK_SIZE)));
    // 小文件不分片
    if (total < MIN_CHUNK_SIZE * 2) return { count: 1, size: 0 };
    count = Math.min(count, MAX_CHUNKS);
    const size = Math.ceil(total / count);
    return { count, size };
  }

  /** 并发执行所有分片，返回每片结果 */
  private async runChunks(
    rt: Runtime,
    plan: { count: number; size: number },
  ): Promise<ChunkResult[]> {
    const t = rt.task;
    const signal = rt.controller.signal;
    const dir = this.partDir(t.id);
    const results = new Array<ChunkResult>(plan.count).fill(ChunkResult.FAILED);

    // 已完成的字节数（断点续传：统计已有 part 文件）
    let doneBytes = 0;
    for (let i = 0; i < plan.count; i++) {
      const start = i * plan.size;
      const end = Math.min(start + plan.size, t.totalBytes) - 1;
      try {
        const s = await stat(chunkPath(dir, i));
        const expected = end - start + 1;
        doneBytes += Math.min(s.size, expected);
      } catch {
        /* 不存在 */
      }
    }
    t.downloadedBytes = doneBytes;
    this.emit('progress', { ...t });

    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (signal.aborted) throw new CancelledError();
        const i = next++;
        if (i >= plan.count) return;

        const start = i * plan.size;
        const end = Math.min(start + plan.size, t.totalBytes) - 1;
        const preempt = new PreemptSignal();

        const res = await downloadChunk({
          url: t.url,
          start,
          end,
          partFile: chunkPath(dir, i),
          headers: t.headers ?? {},
          preempt,
          signal,
          onBytes: (n) => {
            t.downloadedBytes += n;
            rt.bytesSinceTick += n;
            this.emitProgress(rt);
          },
        });
        results[i] = res;
        // 该片被忽略 Range 时，整体回退单流，提前结束其它分片
        if (res === ChunkResult.RANGE_IGNORED) return;
      }
    };

    const workers = Array.from(
      { length: Math.min(this.opts.concurrency, plan.count) },
      () => worker(),
    );
    await Promise.all(workers);
    return results;
  }

  /** 单流整文件下载（回退路径） */
  private async runSingleStream(rt: Runtime): Promise<void> {
    const t = rt.task;
    const signal = rt.controller.signal;
    const tmp = join(this.partDir(t.id), 'full.part');
    ensureDir(dirname(tmp));

    t.downloadedBytes = 0;
    rt.usedFullStream = true;
    this.emit('progress', { ...t });

    const ok = await downloadFull({
      url: t.url,
      partFile: tmp,
      headers: t.headers ?? {},
      total: t.totalBytes > 0 ? t.totalBytes : -1,
      signal,
      onBytes: (n) => {
        t.downloadedBytes += n;
        rt.bytesSinceTick += n;
        this.emitProgress(rt);
      },
    });
    if (signal.aborted) throw new CancelledError();
    if (!ok) throw new Error('单流下载未完成，可点击继续重试');

    const target = join(t.dirPath, t.fileName);
    if (!existsSync(t.dirPath)) await mkdir(t.dirPath, { recursive: true });
    await rename(tmp, target);
    this.cleanParts(t.id);

    rt.task.status = 'COMPLETED';
    rt.task.speedBps = 0;
    this.emit('done', { ...rt.task });
  }

  /** 清理分片临时目录 */
  private cleanParts(id: string): void {
    try {
      rmSync(this.partDir(id), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  /** 暂停任务（保留分片，可续传） */
  async pause(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt || rt.task.status !== 'RUNNING') return;
    rt.controller.abort();
    rt.task.status = 'PAUSED';
    rt.task.speedBps = 0;
    // 等待在飞的 run() 真正退出，确保不再有写入落盘
    await rt.running?.catch(() => {});
    this.emit('progress', { ...rt.task });
  }

  /** 删除任务（取消并清理分片） */
  async remove(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.controller.abort();
    // ★ 必须先等 run() 退出再清理：否则在飞的分片写入会在删除后重建临时目录
    await rt.running?.catch(() => {});
    this.cleanParts(id);
    this.runtimes.delete(id);
  }

  /** 清空所有任务 */
  async clear(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) await this.remove(id);
  }
}
