import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import type { BaiduOAuthTokens, SharePlatform, UploadStatus, UploadTask } from '../../shared/types';
import { BaiduUploadAdapter } from './baiduUpload.js';

export interface UploadManagerOptions {
  getBaiduOAuth: () => { config: { appName: string }; tokens: BaiduOAuthTokens | null } | null;
  refreshBaiduOAuth?: () => Promise<{ config: { appName: string }; tokens: BaiduOAuthTokens } | null>;
  secureOAuth: () => boolean;
  adapter?: Pick<BaiduUploadAdapter, 'upload'>;
}

type UploadInput = { filePath: string; fileName?: string };
type UploadGrant = { fileToken: string; fileName: string; size: number };
type StoredGrant = UploadGrant & { sourcePath: string; expiresAt: number };
type InternalUploadTask = UploadTask & { sourcePath: string };
type PublicUploadTask = Omit<UploadTask, 'sourcePath'>;
const GRANT_TTL_MS = 10 * 60 * 1000;

export class UploadManager extends EventEmitter {
  private tasks = new Map<string, InternalUploadTask>();
  private controllers = new Map<string, AbortController>();
  private grants = new Map<string, StoredGrant>();
  private queue: string[] = [];
  private draining = false;
  private readonly options: UploadManagerOptions;
  constructor(options: UploadManagerOptions) { super(); this.options = options; }

  private publicTask(task: InternalUploadTask): PublicUploadTask {
    const { sourcePath: _sourcePath, ...visible } = task;
    return visible;
  }

  list(): PublicUploadTask[] { return [...this.tasks.values()].map((task) => this.publicTask(task)); }
  get(id: string): PublicUploadTask | undefined {
    const task = this.tasks.get(id);
    return task ? this.publicTask(task) : undefined;
  }

  private async validateInput(input: UploadInput, appName: string): Promise<InternalUploadTask> {
    const sourcePath = String(input.filePath ?? '').trim();
    if (!sourcePath) throw new Error('缺少本地文件路径');
    const info = await lstat(sourcePath);
    if (!info.isFile()) throw new Error('只能选择普通文件');
    await access(sourcePath, constants.R_OK);
    const fileName = this.validateName(input.fileName || sourcePath.split(/[\\/]/).pop() || '');
    return {
      id: randomUUID(), platform: 'BAIDU', fileName, sourcePath,
      destination: `/apps/${appName}/${fileName}`,
      totalBytes: info.size, uploadedBytes: 0, status: 'PENDING', createdAt: Date.now(),
    };
  }

  private pruneGrants(): void {
    const now = Date.now();
    for (const [token, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(token);
  }

  async grantFiles(files: string[]): Promise<UploadGrant[]> {
    this.pruneGrants();
    if (!Array.isArray(files) || files.length < 1 || files.length > 100) throw new Error('一次只能选择 1-100 个文件');
    const staged = await Promise.all(files.map(async (filePath) => {
      const sourcePath = String(filePath ?? '').trim();
      if (!sourcePath) throw new Error('缺少本地文件路径');
      const info = await lstat(sourcePath);
      if (!info.isFile()) throw new Error('只能选择普通文件');
      await access(sourcePath, constants.R_OK);
      const fileName = this.validateName(sourcePath.split(/[\\/]/).pop() || '');
      const fileToken = randomUUID();
      return { fileToken, fileName, size: info.size, sourcePath, expiresAt: Date.now() + GRANT_TTL_MS };
    }));
    for (const grant of staged) this.grants.set(grant.fileToken, grant);
    return staged.map(({ fileToken, fileName, size }) => ({ fileToken, fileName, size }));
  }

  async createFromGrants(files: Array<{ fileToken: string; fileName?: string }>, platform: SharePlatform): Promise<PublicUploadTask[]> {
    this.pruneGrants();
    if (!Array.isArray(files) || files.length < 1 || files.length > 100) throw new Error('一次只能选择 1-100 个文件');
    const selected = files.map((item) => {
      const grant = this.grants.get(String(item?.fileToken ?? ''));
      if (!grant) throw new Error('文件选择已失效，请重新选择文件');
      return { grant, fileName: item.fileName ?? grant.fileName };
    });
    const staged = await this.create(selected.map(({ grant, fileName }) => ({ filePath: grant.sourcePath, fileName })), platform);
    for (const { grant } of selected) this.grants.delete(grant.fileToken);
    return staged;
  }

  async create(files: UploadInput[], platform: SharePlatform): Promise<PublicUploadTask[]> {
    if (!Array.isArray(files) || files.length < 1 || files.length > 100) throw new Error('一次只能选择 1-100 个文件');
    if (platform !== 'BAIDU') throw new Error('该平台暂未提供可核验的官方上传接口');
    if (!this.options.secureOAuth()) throw new Error('系统安全存储不可用，百度上传已禁用');
    let oauth = this.options.getBaiduOAuth();
    if (!oauth?.tokens || !oauth.config.appName) throw new Error('请先配置并授权百度开放平台上传');
    if (oauth.tokens.expiresAt <= Date.now() && this.options.refreshBaiduOAuth) {
      oauth = await this.options.refreshBaiduOAuth();
    }
    if (!oauth?.tokens || !oauth.config.appName) throw new Error('百度 OAuth 令牌已过期，请重新授权');
    const staged = await Promise.all(files.map((input) => this.validateInput(input, oauth!.config.appName)));
    const visible = staged.map((task) => this.publicTask(task));
    for (const task of staged) {
      this.tasks.set(task.id, task);
      this.queue.push(task.id);
    }
    void this.drain();
    return visible;
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.controllers.get(id)?.abort();
    if (task.status === 'PENDING' || task.status === 'RUNNING') {
      // 百度官方未提供取消/回滚接口：已发送分片可能留在远端临时空间
      if (task.status === 'RUNNING' && task.uploadedBytes > 0) task.error = '已取消；远端可能残留临时分片，未回滚';
      task.status = 'CANCELLED';
    }
    this.emit('progress', this.publicTask(task));
  }

  remove(id: string): void {
    this.cancel(id);
    this.tasks.delete(id);
    this.queue = this.queue.filter((queued) => queued !== id);
    this.controllers.delete(id);
  }

  private validateName(name: string): string {
    if (!name || name.length > 240 || name === '.' || name === '..' || /[\\/\0]/.test(name) || name.includes('..')) {
      throw new Error('目标文件名只能是应用空间根目录下的单层文件名');
    }
    return name;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const task = this.tasks.get(id);
        if (task && task.status !== 'CANCELLED') await this.run(task);
      }
    } finally { this.draining = false; }
  }

  private async run(task: InternalUploadTask): Promise<void> {
    if (!this.tasks.has(task.id)) return;
    let oauth = this.options.getBaiduOAuth();
    if (!oauth?.tokens) { task.status = 'FAILED'; task.error = '百度 OAuth 凭据不可用'; this.emit('error', this.publicTask(task)); return; }
    if (oauth.tokens.expiresAt <= Date.now() && this.options.refreshBaiduOAuth) {
      try { oauth = await this.options.refreshBaiduOAuth(); }
      catch (error: any) {
        task.status = 'FAILED';
        task.error = error?.message ?? '百度 OAuth 令牌刷新失败';
        this.emit('error', this.publicTask(task));
        return;
      }
    }
    if (!this.tasks.has(task.id) || task.status === 'CANCELLED') return;
    if (!oauth?.tokens || !oauth.config.appName) {
      task.status = 'FAILED';
      task.error = '百度 OAuth 令牌已过期，请重新授权';
      this.emit('error', this.publicTask(task));
      return;
    }
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    task.status = 'RUNNING';
    this.emit('progress', this.publicTask(task));
    try {
      const result = await (this.options.adapter ?? new BaiduUploadAdapter()).upload({
        filePath: task.sourcePath, fileName: task.fileName, appName: oauth.config.appName,
        tokens: oauth.tokens, signal: controller.signal,
        onProgress: (bytes) => {
          if (!this.tasks.has(task.id)) return;
          task.uploadedBytes += bytes;
          this.emit('progress', this.publicTask(task));
        },
      });
      if (!this.tasks.has(task.id)) return;
      task.destination = result.path; task.uploadedBytes = task.totalBytes; task.status = 'COMPLETED';
      this.emit('done', this.publicTask(task));
    } catch (error: any) {
      if (!this.tasks.has(task.id)) return;
      task.status = controller.signal.aborted ? 'CANCELLED' : 'FAILED';
      if (task.status === 'CANCELLED') {
        if (task.uploadedBytes > 0) task.error = '已取消；远端可能残留临时分片，未回滚';
        this.emit('progress', this.publicTask(task));
      } else {
        task.error = error?.message ?? String(error);
        this.emit('error', this.publicTask(task));
      }
    } finally { this.controllers.delete(task.id); }
  }
}

export type { UploadStatus, UploadTask };
