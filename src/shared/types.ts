/*
 * YunX Desktop (云析桌面版) —— 主进程与渲染进程共享的数据模型。
 * 移植自 CYQawa/YunX（AGPL-3.0）的 model/ShareModels.kt 与 db/DownloadTaskEntity.kt。
 */

import type { SharePlatform } from './linkParser';

export type { SharePlatform };

/** 分享解析会话（一次解析流程的凭证） */
export interface ShareSession {
  shareId: string;
  stoken: string;
  title: string;
}

/** 分享文件 / 目录项 */
export interface ShareFile {
  fid: string;
  fname: string;
  fsize: number;
  isdir: boolean;
  pdirFid: string;
  fidToken: string;
  modifyTime?: string;
}

/** 下载直链 */
export interface DownloadLink {
  fid: string;
  filename: string;
  downloadUrl: string;
  size: number;
  /** 下载完成后需删除的临时转存目录 fid（夸克去重修复） */
  cleanupDirFid?: string | null;
  /** 是否为 HLS（m3u8）转码流 */
  isHls?: boolean;
  /** 拉取直链时必须携带的请求头（Referer / User-Agent 防盗链） */
  headers?: Record<string, string>;
}

/** 网盘空间详情 */
export interface QuotaInfo {
  used: number;
  total: number;
  usedInTrash?: number;
}

/** 解析结果（渲染进程展示用） */
export interface ResolveResult {
  platform: SharePlatform;
  shareId: string;
  title: string;
  files: ShareFile[];
}

/** 下载任务状态 */
export type TaskStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** 下载任务 */
export interface DownloadTask {
  id: string;
  platform: SharePlatform;
  fid: string;
  fileName: string;
  url: string;
  dirPath: string;
  totalBytes: number;
  downloadedBytes: number;
  status: TaskStatus;
  /** 分片数 */
  chunks: number;
  error?: string;
  speedBps?: number;
  createdAt: number;
  /** 下载完成/失败后需要清理的临时转存目录 fid */
  cleanupDirFid?: string | null;
  headers?: Record<string, string>;
}

/** 登录态（各平台 Cookie / Token） */
export interface AuthState {
  platform: SharePlatform;
  /** Cookie 串（夸克/UC/百度/139）或 JWT（123）或 token 串（迅雷） */
  credential: string;
  nickname?: string;
  updatedAt: number;
}
