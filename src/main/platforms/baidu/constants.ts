/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 BaiduConstants.kt。
 * 所有常量逐字对齐 Kotlin 源码（share-link-api-spec.md §B.2）。
 */

export const BaiduConstants = {
  /** WebView 登录页 */
  LOGIN_URL: 'https://pan.baidu.com/',

  /** 提取 Cookie 的域名 */
  COOKIE_DOMAIN: 'https://pan.baidu.com',

  /** PC Web User-Agent（share/verify、xpan/share、share/transfer 使用） */
  UA_WEB:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0.0.0 Safari/537.36',

  /** 网盘客户端 User-Agent（locatedownload、api/list、api/create、api/filemanager 使用） */
  UA_NETDISK: 'netdisk;12.24.6;piano;android-android;16;JSbridge4.4.0;jointBridge;1.1.0',

  /** 网盘应用 ID（全部接口固定值） */
  APP_ID: '250528',

  /** 临时转存目录名（个人网盘根目录下） */
  TEMP_DIR_NAME: 'YunX临时转存',

  // ---------- 分享解析链路 ----------

  /** 验证提取码：POST share/verify?surl=<surl>，返回 randsk（URL 编码形式，直接作为 sekey） */
  SHARE_VERIFY_URL: 'https://pan.baidu.com/share/verify',

  /** 分享文件列表：GET rest/2.0/xpan/share?method=list（分页 num=100） */
  SHARE_LIST_URL: 'https://pan.baidu.com/rest/2.0/xpan/share?method=list',

  /** 转存分享文件：POST share/transfer（同步返回 extra.list[0]） */
  SHARE_TRANSFER_URL: 'https://pan.baidu.com/share/transfer',

  /** 高速下载直链：POST d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload */
  LOCATE_DOWNLOAD_URL: 'https://d.pcs.baidu.com/rest/2.0/pcs/file',

  /** 分享页 Referer 前缀（share/verify 与 xpan/share 带 surl，transfer 不带） */
  SHARE_REFERER: 'https://pan.baidu.com/s/',

  /** 转存接口 Origin */
  ORIGIN: 'https://pan.baidu.com',

  // ---------- 个人网盘 / bdstoken ----------

  /** bdstoken / nickname：GET api/gettemplatevariable?clienttype=0&app_id=250528&web=1&fields=<urlenc> */
  TEMPLATE_VARIABLE_URL: 'https://pan.baidu.com/api/gettemplatevariable',

  /** bdstoken 的 fields 原值：["bdstoken"]（URL 编码后为 %5B%22bdstoken%22%5D） */
  FIELDS_BDSTOKEN: '["bdstoken"]',

  /** 昵称的 fields 原值：["username"] */
  FIELDS_USERNAME: '["username"]',

  /** 个人网盘目录列表：GET yun.baidu.com/api/list（num=100，自动翻页） */
  CLOUD_LIST_URL: 'https://yun.baidu.com/api/list',

  /**
   * 新建文件夹：POST pan.baidu.com/api/create?a=commit&channel=chunlei&web=1&app_id=250528&clienttype=0&bdstoken=<bdstoken>
   * 官方新建文件夹用的是 api/create?a=commit（对齐抓包）：
   * filemanager?opera=mkdir 在纯 Cookie 认证下恒 errno=2（接口校验路径不同）。
   */
  CREATE_DIR_URL: 'https://pan.baidu.com/api/create',

  /** 删除文件：POST api/filemanager?async=2&onnest=fail&opera=delete&bdstoken=<bdstoken>&newVerify=1&clienttype=0&app_id=250528&web=1 */
  FILE_MANAGER_URL: 'https://pan.baidu.com/api/filemanager',

  /** 网盘空间详情：GET yun.baidu.com/api/quota（total / used） */
  QUOTA_URL: 'https://yun.baidu.com/api/quota',

  /** 个人网盘接口的 Referer */
  DISK_REFERER: 'https://yun.baidu.com/disk/main',

  /** 个人网盘根目录路径 */
  ROOT_DIR: '/',

  // ---------- locatedownload 抓包写死常量 ----------

  /**
   * 抓包常量：psign 写死；rand/devuid/cuid/deviceid 有 BDUSS 登录态时可直接复用。
   * 百度链路**没有**客户端 sign/salt/appkey 计算（share-link-api-spec.md §B.3），
   * 仅 time 取当前 Unix 秒。
   */
  LOCATE_PSIGN: '860a071f77c860e8cea06e4e54c518f3',
  LOCATE_RAND: '5ed606e9da222cde0474cdf70eda884b',
  LOCATE_DEVUID: '0F1E9FC2E084472DA5A61C4CF4C759AF',
  LOCATE_CUID: '0F1E9FC2E084472DA5A61C4CF4C759AF',
  LOCATE_DEVICEID: '348642637967375013',
  LOCATE_VERSION: '2.2.111.34',
  LOCATE_VERSION_APP: '12.24.6',

  // ---------- 分页 ----------

  /** 单页条数（官方 page_size 上限） */
  PAGE_SIZE: 100,

  /** 分享列表 / 个人网盘列表翻页封顶，防止异常死循环 */
  MAX_PAGE: 100,

  /**
   * errno 语义（BaiduApi.kt checkErrno 注释）：
   * -12 提取码错误 / 403 分享已失效 / 31066 文件不存在 / 2 缺少 BDCLND（或列表模式不对）。
   */
  ERRNO_MESSAGES: {
    '-12': '提取码错误',
    '403': '分享已失效',
    '31066': '文件不存在',
    '2': '分享校验失败（缺少 BDCLND 或列表模式不正确）',
  } as Record<string, string>,

  /** 关键 Cookie 字段，缺失 BDUSS 则视为未登录 */
  isValidCookie(cookie: string | null | undefined): boolean {
    return !!cookie && cookie.includes('BDUSS=');
  },
};

/**
 * errno → 友好中文提示。
 * 对齐 Kotlin：优先透传服务端 err_msg/show_msg，没有再用本地码表，最后用兜底文案。
 */
export function baiduErrnoMessage(
  errno: number,
  errMsg: string | undefined,
  showMsg: string | undefined,
  fallback: string,
): string {
  const server = (errMsg ?? '').trim() || (showMsg ?? '').trim();
  if (server) return `${server}（errno=${errno}）`;
  const local = BaiduConstants.ERRNO_MESSAGES[String(errno)];
  if (local) return `${local}（errno=${errno}）`;
  return `${fallback}（errno=${errno}）`;
}

export const BAIDU_TEMP_DIR = `/${BaiduConstants.TEMP_DIR_NAME}`;
