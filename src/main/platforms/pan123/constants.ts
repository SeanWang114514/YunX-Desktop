/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 Pan123Constants.kt。
 */

export const Pan123Constants = {
  /** 业务 API 基础域名（分享列表 / 个人盘接口） */
  API_BASE: 'https://yun.123pan.cn',

  /** 分享下载信息走独立 host（抓包实证；alist 用 yun.123pan.com 等价） */
  DOWNLOAD_BASE: 'https://www.123865.com',

  /** WebView 登录页 */
  WEB_LOGIN_URL: 'https://yun.123pan.cn/',

  /** 登录态在 yun.123pan.cn localStorage 中的键名（Bearer JWT，约 90 天过期） */
  LOCAL_STORAGE_TOKEN_KEY: 'authorToken',

  /** 分享文件列表（匿名、无签名） */
  SHARE_GET_URL: 'https://yun.123pan.cn/b/api/share/get',

  /** 分享下载信息（需登录 + 签名；host 为 www.123865.com） */
  SHARE_DOWNLOAD_INFO_URL: 'https://www.123865.com/b/api/share/download/info',

  /** 个人盘文件列表（需登录 + 签名） */
  FILE_LIST_URL: 'https://yun.123pan.cn/b/api/file/list/new',

  /** 个人盘下载信息（注意：无 /b/ 前缀） */
  FILE_DOWNLOAD_INFO_URL: 'https://yun.123pan.cn/api/file/download_info',

  /** 个人盘流量检测（需登录 + 签名） */
  TRAFFIC_CHECK_URL: 'https://yun.123pan.cn/b/api/file/download/traffic/check',

  /** 删除（移入回收站） */
  FILE_TRASH_URL: 'https://yun.123pan.cn/b/api/file/trash',

  /** 重命名 */
  FILE_RENAME_URL: 'https://yun.123pan.cn/b/api/file/rename',

  /** 移动 */
  FILE_MOD_PID_URL: 'https://yun.123pan.cn/b/api/file/mod_pid',

  /** 创建分享 */
  SHARE_CREATE_URL: 'https://yun.123pan.cn/b/api/share/create',

  /** 用户信息（昵称 / 空间详情） */
  USER_INFO_URL: 'https://yun.123pan.cn/b/api/user/info',

  /** 网页端 User-Agent（鉴权接口 / 最终下载均用它） */
  WEB_UA:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/127.0.0.0 Safari/537.36',

  /** 分享列表 / redirect 探测专用 User-Agent（Dart 客户端特征，匿名接口只带它） */
  DART_UA: 'Dart/3.12 (dart:io)',

  /** 签名用平台字面量（签名内部固定 web/3，与请求头 platform/app-version 无关） */
  PLATFORM_WEB: 'web',
  /** 分享下载信息请求头 platform */
  PLATFORM_ANDROID: 'android',
  /** 签名用版本字面量 */
  APP_VERSION_WEB: '3',
  /** 分享下载信息请求头 app-version */
  APP_VERSION_ANDROID: '39',

  /** 分享下载真实 CDN 直链必须携带的 Referer */
  DOWNLOAD_REFERER: 'https://yun.123pan.cn/',

  /** 数字替换表：0→a 1→d 2→e 3→f 4→g 5→h 6→l 7→m 8→y 9→i */
  SIGN_TABLE: 'adefghlmyijnopkqrstubcvwsz',
  /** 签名内部固定 OS（与请求头 platform 无关） */
  SIGN_OS: 'web',
  /** 签名内部固定 VER（与请求头 app-version 无关） */
  SIGN_VER: '3',
  /** timeSign 时间基准偏移：ts + 57600 秒（+16h，UTC 格式化） */
  SIGN_OFFSET_SECONDS: 57600,

  /** 分享列表每页条数 */
  PAGE_SIZE: 100,
  /**
   * 分享列表翻页上限。
   * alist 实证：next 参数始终固定 "0"，翻页靠 Page 递增（Page 从 1 开始，1..49）。
   */
  MAX_PAGE: 49,
  /** createSession 探测用根目录 fid */
  ROOT_FID: '0',
  /** 永久分享过期时间（创建分享用） */
  EXPIRATION_FOREVER: '2099-12-12T08:00:00+08:00',
};

/**
 * 判断凭据是否构成有效登录态。
 * 123 的 credential 是 Bearer JWT（authorToken），非空即视为已登录；
 * 形如 JWT 的串（含两个 '.'）逐段非空时判为有效。
 */
export function isValidToken(token: string | null | undefined): boolean {
  if (!token || !token.trim()) return false;
  const t = token.trim();
  // JWT 形态：header.payload.signature 三段
  if (t.includes('.')) {
    const parts = t.split('.');
    return parts.length === 3 && parts.every((p) => p.length > 0);
  }
  // 非 JWT 形态：只要非空就当作用户自填的 token
  return true;
}
