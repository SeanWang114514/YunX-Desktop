/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 C139Constants.kt。
 */

import { tryBase64Decode } from '../../util/crypto';

export const C139Constants = {
  /**
   * WebView 登录页：139 云盘移动版（PC 版 SPA 在 WebView 环境会因深度环境检测渲染空白）。
   */
  LOGIN_URL: 'https://yun.139.com/m/#/login',

  /** 提取 Cookie 的主域名（fast login 核心：Os_SSo_Sid + RMKEY 在此域） */
  COOKIE_DOMAIN: 'https://mail.10086.cn',

  /** 备用 Cookie 域名（authorization / ud_id 等在此域，网页版直接给） */
  COOKIE_DOMAIN_BACKUP: 'https://yun.139.com',

  /** 分享专用 host（share-kd-njs.yun.139.com） */
  SHARE_BASE: 'https://share-kd-njs.yun.139.com',

  /** 分享列目录（7.13+ 请求/响应均 AES 加密） */
  SHARE_LIST_URL:
    'https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6',

  /** 分享取直链（7.13+ 请求/响应均 AES 加密） */
  SHARE_LINK_URL:
    'https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3',

  /** 分享标题 / 明文提取码（getOutLinkGeneral → outLinkGeneral[].lkName / passwd） */
  SHARE_GENERAL_URL:
    'https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkGeneral',

  /** 分享接口 AES-CBC 固定密钥（16 字节 UTF-8 原文，所有账号共用） */
  SHARE_AES_KEY: 'PVGDwmcvfs1uV3d1',

  /** 分享接口必带设备/渠道上下文头（缺任一即 9530） */
  SHARE_X_DEVICEINFO: '||3|12.27.0|||||chrome 150.0.0.0|360X444|zh-cn|||',
  SHARE_X_HUAWEI_CHANNELSRC: '10245500',
  SHARE_X_MM_SOURCE: '0002',

  /** 分享接口 User-Agent（必须浏览器/WebView UA，不能用 okhttp/4.x） */
  SHARE_MOBILE_UA:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/150.0.0.0 Mobile Safari/537.36',

  /** PC 桌面 UA（OBS 直链下载时携带） */
  PC_UA:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/120.0.0.0 Safari/537.36',

  /** Origin / Referer（分享接口必需） */
  ORIGIN: 'https://yun.139.com',
  REFERER: 'https://yun.139.com/',

  /** 分享列目录分页：bNum 从 1 开始，每次 +200，eNum = bNum + 199 */
  PAGE_SIZE: 200,
  /** 分页上限：bNum <= 20000（100 页 / 20000 条） */
  MAX_BEGIN: 20_000,
  /** 根目录 pCaID 必须是字面量 "root"（空串会报 pCaID不能为空） */
  ROOT_PCAID: 'root',

  /** mcloud-sign 随机串字符池（rand 取 16 位） */
  RAND_POOL: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',

  /** 快速登录必须同时存在的关键字段（路径 A） */
  REQUIRED_FAST_KEYS: ['Os_SSo_Sid', 'RMKEY'] as const,

  /** 错误码：提取码错误 */
  ERR_WRONG_PASSWORD: '9188',
  /** 错误码：缺少设备/渠道上下文头（或缺 hcy-cool-flag） */
  ERR_MISSING_DEVICE_HEADERS: '9530',
};

/**
 * 提取 authorization 请求头值（形如 "Basic cGM6..."）；没有返回 null。
 * 对齐 Kotlin C139Constants.extractAuthorization。
 */
export function extractAuthorization(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const kv = part.trim();
    if (kv.startsWith('authorization=')) {
      const v = kv.slice('authorization='.length);
      if (v.trim()) return v;
    }
  }
  return null;
}

/** 取 Cookie 中某个键的原始值（首个匹配） */
function cookieValue(cookie: string, name: string): string | null {
  const prefix = `${name}=`;
  for (const part of cookie.split(';')) {
    const kv = part.trim();
    if (kv.startsWith(prefix)) {
      const v = kv.slice(prefix.length);
      if (v.trim()) return v;
    }
  }
  return null;
}

/**
 * 从 Cookie 提取**完整账号（手机号）**——解析接口 body 必须用它，不能是脱敏值：
 *  1) ORCHES-I-ACCOUNT-ENCRYPT：base64 解码即完整手机号；
 *  2) authorization：去掉字面量前缀 "Basic" → base64 解码 → 冒号分段取 index [1]
 *     （§3.2 最终态 Authorization = base64("pc:<account>:<authToken>")）；
 *  3) Login_UserNumber：原始值。
 * 拿不到返回 null。
 */
export function extractAccountFull(cookie: string | null | undefined): string | null {
  if (!cookie) return null;

  // 1) ORCHES-I-ACCOUNT-ENCRYPT：base64 手机号
  const encrypted = cookieValue(cookie, 'ORCHES-I-ACCOUNT-ENCRYPT');
  if (encrypted) {
    const decoded = tryBase64Decode(encrypted);
    if (decoded && decoded.trim()) return decoded.trim();
  }

  // 2) authorization："Basic base64(pc:账号:authToken)"
  const auth = extractAuthorization(cookie);
  if (auth) {
    const b64 = auth.replace(/^Basic/, '').trim();
    const decoded = tryBase64Decode(b64);
    if (decoded) {
      const account = decoded.split(':')[1];
      if (account && account.trim()) return account.trim();
    }
  }

  // 3) Login_UserNumber：手机号/账号
  const userNumber = cookieValue(cookie, 'Login_UserNumber');
  if (userNumber) return userNumber.trim();

  return null;
}

/**
 * 关键字段是否齐全（两种形式任一成立即视为有效登录态）：
 *  - 路径 B：authorization 存在且非空；
 *  - 路径 A：Os_SSo_Sid + RMKEY 同时存在且非空。
 * 对齐 Kotlin C139Constants.isValidCookie。
 */
export function isValidCookie(cookie: string | null | undefined): boolean {
  if (!cookie || !cookie.trim()) return false;
  for (const part of cookie.split(';')) {
    const kv = part.trim();
    if (kv.startsWith('authorization=') && kv.length > 'authorization='.length) return true;
  }
  return C139Constants.REQUIRED_FAST_KEYS.every((key) => {
    const prefix = `${key}=`;
    return cookie.split(';').some((p) => {
      const kv = p.trim();
      return kv.startsWith(prefix) && kv.length > prefix.length;
    });
  });
}
