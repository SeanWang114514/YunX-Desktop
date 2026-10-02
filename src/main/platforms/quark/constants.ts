/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 QuarkConstants.kt。
 */

export const QuarkConstants = {
  /** 夸克 PC 客户端 User-Agent */
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/130.0.0.0 Safari/537.36 QuarkPC/6.0.8.649',

  /** 解析/下载 API 强制 User-Agent（与 Kotlin 版一致） */
  API_USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'quark-cloud-drive/2.5.20 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch',

  /** WebView 登录页（PC 环境） */
  LOGIN_URL: 'https://pan.quark.cn/?fr=pc&platform=pc',

  /** 提取 Cookie 的域名 */
  COOKIE_DOMAIN: 'https://pan.quark.cn',

  /** 验证登录状态的接口 */
  ACCOUNT_INFO_URL: 'https://pan.quark.cn/account/info',

  /** 业务 API 基础域名 */
  API_BASE: 'https://drive-pc.quark.cn',

  SHARE_TOKEN_URL: 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc',
  SHARE_PASSWORD_URL: 'https://drive-pc.quark.cn/1/clouddrive/share/password?pr=ucpro&fr=pc',
  SHARE_DETAIL_URL: 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/detail?pr=ucpro&fr=pc',
  DOWNLOAD_URL:
    'https://drive-pc.quark.cn/1/clouddrive/file/download?pr=ucpro&fr=pc&sys=win32&ve=3.23.2',
  FILE_URL: 'https://drive-pc.quark.cn/1/clouddrive/file?pr=ucpro&fr=pc',
  CLOUD_FILE_SORT_URL:
    'https://drive-pc.quark.cn/1/clouddrive/file/sort?pr=ucpro&fr=pc',
  SAVE_URL: 'https://drive-pc.quark.cn/1/clouddrive/share/sharepage/save?pr=ucpro&fr=pc',
  TASK_URL: 'https://drive-pc.quark.cn/1/clouddrive/task?pr=ucpro&fr=pc',
  DELETE_URL: 'https://drive-pc.quark.cn/1/clouddrive/file/delete?pr=ucpro&fr=pc&uc_param_str=',
  RENAME_URL: 'https://drive-pc.quark.cn/1/clouddrive/file/rename?pr=ucpro&fr=pc&uc_param_str=',
  MOVE_URL: 'https://drive-pc.quark.cn/1/clouddrive/file/move?pr=ucpro&fr=pc&uc_param_str=',
  SHARE_CREATE_URL: 'https://drive-pc.quark.cn/1/clouddrive/share?pr=ucpro&fr=pc&uc_param_str=',
  SHARE_INFO_URL: 'https://drive-pc.quark.cn/1/clouddrive/share/password?pr=ucpro&fr=pc&uc_param_str=',
  MEMBER_URL:
    'https://drive-pc.quark.cn/1/clouddrive/member?pr=ucpro&fr=pc&fetch_subscribe=true&_ch=home',
  CONFIG_URL: 'https://drive-pc.quark.cn/1/clouddrive/config?pr=ucpro&fr=pc',

  /** 根目录 fid */
  DEFAULT_PDIR_FID: '0',

  /** 临时转存目录名 */
  TEMP_DIR_NAME: 'YunX临时转存',

  /** 下载直链防盗链必须携带的 Referer */
  DOWNLOAD_REFERER: 'https://pan.quark.cn/',

  /** Origin / Referer（分享列表接口必需） */
  ORIGIN: 'https://pan.quark.cn',

  /** 关键 Cookie 字段，缺失则视为未登录 */
  isValidCookie(cookie: string | null | undefined): boolean {
    return !!cookie && cookie.includes('__pus=') && cookie.includes('__puus=');
  },
};

/** 夸克 Cookie 工具：合并/剥离 __puus、__pus */
export const QuarkCookieUtil = {
  TRACKED: new Set(['__puus', '__pus']),

  /** 把响应 Set-Cookie 列表里的最新 __puus/__pus 合并回原 Cookie 串 */
  mergeFromSetCookies(original: string, setCookies: string[]): string {
    let cookie = original;
    for (const sc of setCookies) {
      const kv = sc.split(';')[0].trim();
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const name = kv.slice(0, eq);
      if (this.TRACKED.has(name)) {
        cookie = this.setOrReplace(cookie, name, kv.slice(eq + 1));
      }
    }
    return cookie;
  },

  /** 去掉 __puus，用于触发服务端重新下发 */
  withoutPuus(cookie: string): string {
    return cookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('__puus='))
      .join('; ');
  },

  setOrReplace(cookie: string, name: string, value: string): string {
    const parts = cookie
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    const idx = parts.findIndex((p) => p.startsWith(`${name}=`));
    const kv = `${name}=${value}`;
    if (idx >= 0) parts[idx] = kv;
    else parts.push(kv);
    return parts.join('; ');
  },
};
