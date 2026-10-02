/*
 * YunX Desktop (云析桌面版) —— 解析服务。
 * 统一入口：解析分享链接 → 创建会话 → 列出文件 → 获取下载直链。
 * 对应 Kotlin 版 ResolveViewModel + ShareResolveRepository 的编排职责。
 */

import type { DownloadLink, ResolveResult, ShareFile, ShareSession, SharePlatform } from '../../shared/types';
import { parseShareLink, PLATFORM_LABELS } from '../../shared/linkParser';
import { getAdapter } from '../platforms';
import type { ResolveContext } from '../platforms/types';
import { PlatformError } from '../platforms/types';
import { httpRequest } from '../net/http';
import type { CredentialStore } from '../store/credentialStore';

export interface ResolveServiceDeps {
  store: CredentialStore;
  /** 日志回调 */
  log?: (msg: string) => void;
}

/** 会话缓存：同一分享链接复用 stoken，避免重复请求 */
interface CachedSession {
  session: ShareSession;
  platform: SharePlatform;
  at: number;
}

const SESSION_TTL = 10 * 60 * 1000;

export class ResolveService {
  private sessions = new Map<string, CachedSession>();

  constructor(private deps: ResolveServiceDeps) {}

  /** 构造适配器运行上下文（注入凭据回写） */
  private ctx(platform: SharePlatform): ResolveContext {
    return {
      http: (url, opts) => httpRequest(url, opts),
      saveCookie: (credential) => {
        // 会话刷新后回写，保持 __puus / token 新鲜
        this.deps.store.saveCredential(platform, credential);
      },
      log: this.deps.log,
    };
  }

  /** 解析分享链接文本，返回平台与 shareId */
  parseLink(text: string) {
    const parsed = parseShareLink(text);
    if (!parsed) {
      throw new PlatformError(
        '无法识别分享链接。支持的平台：夸克 / UC / 迅雷 / 百度 / 139 / 123 云盘',
      );
    }
    return parsed;
  }

  /**
   * 解析分享并列出根目录文件。
   * 未登录时：若平台支持匿名浏览则只列文件（取直链时才要求登录）。
   */
  async resolve(text: string, pwdOverride?: string | null): Promise<ResolveResult> {
    const parsed = this.parseLink(text);
    const adapter = getAdapter(parsed.platform);
    const credential = this.deps.store.getCredential(parsed.platform);
    const ctx = this.ctx(parsed.platform);

    const pwd = pwdOverride?.trim() ? pwdOverride.trim() : parsed.pwd;

    if (adapter.requiresAuth && !adapter.isLoggedIn(credential) && !adapter.canListAnonymous) {
      throw new PlatformError(
        `${PLATFORM_LABELS[parsed.platform]}需要先登录账号才能解析该分享`,
      );
    }

    const session = await adapter.createSession(parsed.shareId, pwd ?? null, credential, ctx);
    this.sessions.set(this.sessionKey(parsed.platform, parsed.shareId), {
      session,
      platform: parsed.platform,
      at: Date.now(),
    });

    const files = await adapter.listFiles(session, '0', credential, ctx);

    return {
      platform: parsed.platform,
      shareId: parsed.shareId,
      title: session.title || '分享文件',
      files,
    };
  }

  /** 列出分享内某个子目录 */
  async listDir(
    platform: SharePlatform,
    shareId: string,
    dirFid: string,
    text?: string,
  ): Promise<ShareFile[]> {
    const adapter = getAdapter(platform);
    const credential = this.deps.store.getCredential(platform);
    const ctx = this.ctx(platform);

    let session = this.sessions.get(this.sessionKey(platform, shareId))?.session;
    if (!session) {
      if (!text) throw new PlatformError('分享会话已过期，请重新解析链接');
      const parsed = this.parseLink(text);
      session = await adapter.createSession(parsed.shareId, parsed.pwd, credential, ctx);
      this.sessions.set(this.sessionKey(platform, shareId), {
        session,
        platform,
        at: Date.now(),
      });
    }
    return adapter.listFiles(session, dirFid, credential, ctx);
  }

  /** 获取文件下载直链 */
  async getDownloadLink(
    platform: SharePlatform,
    shareId: string,
    file: ShareFile,
    text?: string,
  ): Promise<DownloadLink> {
    const adapter = getAdapter(platform);
    const credential = this.deps.store.getCredential(platform);
    const ctx = this.ctx(platform);

    if (!adapter.isLoggedIn(credential)) {
      throw new PlatformError(
        `${PLATFORM_LABELS[platform]}需要先登录账号才能获取下载直链`,
      );
    }

    let session = this.sessions.get(this.sessionKey(platform, shareId))?.session;
    if (!session) {
      if (!text) throw new PlatformError('分享会话已过期，请重新解析链接');
      const parsed = this.parseLink(text);
      session = await adapter.createSession(parsed.shareId, parsed.pwd, credential, ctx);
      this.sessions.set(this.sessionKey(platform, shareId), {
        session,
        platform,
        at: Date.now(),
      });
    }

    const link = await adapter.getShareDownloadLink(session, file, credential, ctx);
    if (!link.downloadUrl) throw new PlatformError('未获取到下载链接');
    if (!link.filename) link.filename = file.fname;
    return link;
  }

  /** 下载完成后清理临时转存目录 */
  async cleanupTempDir(platform: SharePlatform, dirFid: string): Promise<void> {
    const adapter = getAdapter(platform);
    if (!adapter.cleanupTempDir) return;
    const credential = this.deps.store.getCredential(platform);
    const ctx = this.ctx(platform);
    try {
      await adapter.cleanupTempDir(dirFid, credential, ctx);
    } catch (e) {
      this.deps.log?.(`[cleanup] ${platform} 临时目录清理失败: ${e}`);
    }
  }

  private sessionKey(platform: SharePlatform, shareId: string): string {    return `${platform}:${shareId}`;
  }

  /** 清理过期会话 */
  pruneSessions(): void {
    const now = Date.now();
    for (const [k, v] of this.sessions) {
      if (now - v.at > SESSION_TTL) this.sessions.delete(k);
    }
  }
}
