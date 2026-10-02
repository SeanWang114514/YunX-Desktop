/*
 * YunX Desktop (云析桌面版) —— 平台适配器统一接口。
 * 每个网盘实现该接口，主流程不感知平台差异。
 */

import type {
  DownloadLink,
  QuotaInfo,
  ShareFile,
  ShareSession,
  SharePlatform,
} from '../../shared/types';
import type { HttpOptions } from '../net/http';

/** 平台 API 抛出的业务错误（携带服务端 message，透传给 UI） */
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

/** 平台名称与登录要求 */
export interface PlatformMeta {
  platform: SharePlatform;
  label: string;
  /** 解析该平台分享链接是否必须登录 */
  requiresAuth: boolean;
  /** 未登录时是否仍可浏览分享列表（仅取直链需要登录） */
  canListAnonymous?: boolean;
}

/** 解析上下文：由主流程注入，供适配器回调 */
export interface ResolveContext {
  /** 发起 HTTP 请求 */
  http: (url: string, opts?: HttpOptions) => Promise<Response>;
  /** 会话刷新时回写最新 Cookie/Token（保持登录态新鲜） */
  saveCookie?: (credential: string) => void;
  /** 进度/日志回调 */
  log?: (msg: string) => void;
}

export interface PlatformAdapter extends PlatformMeta {
  /** 判断凭据是否构成有效登录态 */
  isLoggedIn(credential: string | null | undefined): boolean;

  /** 创建分享会话（获取 stoken / 校验提取码） */
  createSession(
    shareId: string,
    pwd: string | null,
    credential: string,
    ctx: ResolveContext,
  ): Promise<ShareSession>;

  /** 列出指定目录下的文件 */
  listFiles(
    session: ShareSession,
    dirFid: string,
    credential: string,
    ctx: ResolveContext,
  ): Promise<ShareFile[]>;

  /** 获取分享文件的下载直链 */
  getShareDownloadLink(
    session: ShareSession,
    file: ShareFile,
    credential: string,
    ctx: ResolveContext,
  ): Promise<DownloadLink>;

  /** 下载完成后清理临时转存（可选） */
  cleanupTempDir?(
    dirFid: string,
    credential: string,
    ctx: ResolveContext,
  ): Promise<void>;

  /** 网盘空间详情（可选） */
  getQuota?(credential: string, ctx: ResolveContext): Promise<QuotaInfo | null>;

  /** 获取昵称（可选，用于登录后展示） */
  fetchNickname?(credential: string, ctx: ResolveContext): Promise<string | null>;
}
