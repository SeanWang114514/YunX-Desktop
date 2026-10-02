/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 Pan123Api.kt + Pan123ResolveRepository.kt。
 * 完全使用 Node 内置 fetch（undici），不需要额外 HTTP 依赖。
 *
 * 认证要求（文档 §P.1）：**分享列表完全匿名**（只带 Dart UA，无 token/无签名/无 Cookie）；
 * **取下载直链必须登录**（Bearer JWT，authorToken）+ auth-key/auth-value 签名。
 */

import type { DownloadLink, ShareFile, ShareSession } from '../../../shared/types';
import { Pan123Constants, isValidToken } from './constants';
import type { PlatformAdapter, ResolveContext } from '../types';
import { PlatformError } from '../types';
import { httpJson, httpRequest } from '../../net/http';
import {
  crc32Hex,
  formatUtcOffsetMinutes,
  tryBase64Decode,
  randomHex32,
} from '../../util/crypto';

/** 解析后的 cdN 直链；json 为 null 表示响应体不是 JSON */
class Pan123Api {
  constructor(private ctx: ResolveContext) {}

  /** 设备标识（文档 §3.2：同一会话内不变、不参与签名） */
  private readonly loginuuid = randomHex32();

  // ---------- 签名算法（文档 §6，抓包逐字还原） ----------

  /**
   * 生成 123 云盘签名头（文档 §6.2）：
   * - auth-key (timeSign) = crc32_hex(替换表映射后的 UTC "YYYYMMDDHHmm"，基准 ts + 57600s = +16h)；
   * - auth-value = "<ts>-<random>-<crc32_hex(ts|random|path|web|3|auth_key)>"；
   *   签名内部固定 OS=web / VER=3（与请求头 platform/app-version 无关，文档 §6.3）。
   * @param path URL 路径：含 /b 前缀、不含 host、不含 query（如 /b/api/share/download/info）
   */
  makeSign(path: string, ts = Math.floor(Date.now() / 1000)): { authKey: string; authValue: string } {
    // 1) auth-key (timeSign)：ts + 16h 以 UTC 格式化为 YYYYMMDDHHmm，逐数字替换
    const minute = formatUtcOffsetMinutes(new Date(ts * 1000), Pan123Constants.SIGN_OFFSET_SECONDS);
    const table = Pan123Constants.SIGN_TABLE;
    let substituted = '';
    for (const ch of minute) {
      const d = ch.charCodeAt(0) - 48; // '0'
      substituted += table[d] ?? '';
    }
    // crc32Hex 不补零，对齐 Kotlin Long.toHexString
    const authKey = crc32Hex(substituted);

    // 2) auth-value：ts|random|path|web|3|auth_key 的 crc32
    const random = Math.floor(Math.random() * 10_000_000);
    const data = `${ts}|${random}|${path}|${Pan123Constants.SIGN_OS}|${Pan123Constants.SIGN_VER}|${authKey}`;
    const authValue = `${ts}-${random}-${crc32Hex(data)}`;
    return { authKey, authValue };
  }

  // ---------- 响应工具 ----------

  /** 成功判定：code == 0（登录接口除外，为 200） */
  private checkOk(json: any, fallback: string): void {
    const code = Number(json?.code ?? -1);
    if (code === 0) return;
    const msg = typeof json?.message === 'string' && json.message ? json.message : fallback;
    throw new PlatformError(`${msg}（code=${code}）`, code);
  }

  /**
   * 请求并解析 JSON（executeJson 语义：HTTP 状态非 2xx 且响应为空才报错）。
   * 走 ctx.http 以便测试注入与统一超时/代理，而非模块级 httpJson。
   */
  private async executeJson(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<any> {
    let text: string;
    let status: number;
    try {
      const res = await this.ctx.http(url, {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers: opts.headers,
        body: opts.body,
      });
      status = res.status;
      text = await res.text();
    } catch (e: any) {
      throw new PlatformError(`网络请求失败：${e?.message ?? e}`);
    }
    if (!text) {
      if (status < 200 || status >= 300) {
        throw new PlatformError(`请求失败（HTTP ${status}）`, status);
      }
      throw new PlatformError(`请求失败：响应为空（${status}）`, status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new PlatformError('响应解析失败', status);
    }
  }

  // ---------- 分享文件列表（文档 §5.2，匿名、无签名） ----------

  /**
   * 读取分享文件/目录列表（匿名），支持提取码、翻页、进入子目录。
   * ⚠️ 无提取码时不传 SharePwd（传空值会 400 "请输入Next"）；next 永远传字面量 "0"，靠 Page 递增翻页。
   * @returns files 本页文件列表；nextCursor 下一页游标（null = 末页，文档 §5.2：Next=="-1" 无下一页）
   */
  async getShareFiles(
    shareKey: string,
    sharePwd: string,
    parentFileId: string,
    next: string,
    page: number,
  ): Promise<{ files: ShareFile[]; nextCursor: string | null }> {
    // 参数顺序与抓包一致（§5.2 文件夹分享/有提取码）
    let url =
      `${Pan123Constants.SHARE_GET_URL}` +
      `?limit=${Pan123Constants.PAGE_SIZE}` +
      `&next=${next}` +
      `&orderBy=file_name` +
      `&orderDirection=asc` +
      `&shareKey=${encodeURIComponent(shareKey)}` +
      `&ParentFileId=${parentFileId}` +
      `&Page=${page}`;
    if (sharePwd.trim()) {
      url += `&SharePwd=${encodeURIComponent(sharePwd)}`;
    }

    // 分享列表：匿名请求，只带 Dart UA —— 无 token、无签名、无 Cookie
    const json = await this.executeJson(url, {
      headers: { 'User-Agent': Pan123Constants.DART_UA },
    });
    this.checkOk(json, '获取文件列表失败');
    const data = json?.data;
    if (!data) return { files: [], nextCursor: null };
    if (data.Expired === true) {
      throw new PlatformError('分享已失效');
    }
    const files = Pan123Api.parseInfoList(data);
    // 文档 §5.2：Next=="-1" 无下一页；空串 "" 表示还有下一页（需继续翻页）；数字为游标
    const rawNext = Pan123Api.optString(data, 'Next');
    const nextCursor = rawNext === '-1' ? null : rawNext;
    return { files, nextCursor };
  }

  // ---------- 分享下载信息（文档 §5.3，需登录 + 签名） ----------

  /**
   * 分享文件取下载直链（POST /b/api/share/download/info）。
   * 走 android 平台头，签名内部仍固定 web/3（文档 §6.3）。
   * @param file 列表项（fidToken 编码了 "S3KeyFlag|Etag|StorageNode"）
   * @returns 解码 + 跟随 redirect_url 后的真实 CDN 直链（下载需带 Referer: https://yun.123pan.cn/）
   */
  async getShareLink(shareKey: string, file: ShareFile, token: string): Promise<DownloadLink> {
    if (!token || !token.trim()) throw new PlatformError('请先登录123云盘');
    const [s3KeyFlag, etag] = decodeToken(file.fidToken);
    // 注意 key 大小写：请求体是 FileID/S3KeyFlag（大写 I/D），列表响应是 FileId（小写 d）
    const body = JSON.stringify({
      ShareKey: shareKey,
      FileID: file.fid,
      S3KeyFlag: s3KeyFlag,
      Size: file.fsize,
      Etag: etag,
    });
    const { authKey, authValue } = this.makeSign('/b/api/share/download/info');
    const json = await this.executeJson(Pan123Constants.SHARE_DOWNLOAD_INFO_URL, {
      method: 'POST',
      headers: {
        platform: Pan123Constants.PLATFORM_ANDROID,
        'app-version': Pan123Constants.APP_VERSION_ANDROID,
        authorization: `Bearer ${token.trim()}`,
        loginuuid: this.loginuuid,
        'auth-key': authKey,
        'auth-value': authValue,
        'Content-Type': 'application/json;charset=UTF-8',
        'User-Agent': Pan123Constants.WEB_UA,
      },
      body,
    });
    this.checkOk(json, '获取下载链接失败');
    const downloadUrl = Pan123Api.optString(json?.data, 'DownloadURL');
    if (!downloadUrl.trim()) throw new PlatformError('获取下载链接失败：未返回 DownloadURL');

    // download-v2 包装 URL → Base64 解码 params 得真实 CDN 文件 URL（文档 §5.3.1）
    const decoded = decodeDownloadUrl(downloadUrl) ?? downloadUrl;
    // 跟随可能存在的 redirect_url（auto_redirect=0，GET 直链返回 JSON 而非文件，可能多跳）
    const realUrl = await this.followRedirectUrl(decoded);
    return {
      fid: file.fid,
      filename: file.fname,
      downloadUrl: realUrl,
      size: file.fsize,
      // 123 分享下载无需转存，无 cleanupDirFid
      headers: {
        'User-Agent': Pan123Constants.WEB_UA,
        Referer: Pan123Constants.DOWNLOAD_REFERER,
      },
    };
  }

  // ---------- redirect_url 跟随（文档 §5.3.2） ----------

  /**
   * 循环跟随 123 CDN 的 redirect_url（最多 5 跳）。
   * 带 auto_redirect=0 时 GET 直链返回 JSON {"code":0,"data":{"redirect_url":...}} 而非直接文件，
   * 且 redirect_url 自身也可能带 auto_redirect=0（可能多跳）。
   */
  private async followRedirectUrl(initialUrl: string): Promise<string> {
    let url = initialUrl;
    for (let i = 0; i < 5; i++) {
      const next = await this.probeJsonRedirect(url);
      if (!next) return url;
      url = next;
    }
    return url;
  }

  /**
   * 探测单跳：响应体很小（Content-Length ≤ 8KB，JSON 跳转页）且含 data.redirect_url 时返回新地址，
   * 否则 null（当前 URL 即最终可下载地址）。大响应/无 Content-Length 视为真实文件流，不读取 body。
   */
  private async probeJsonRedirect(url: string): Promise<string | null> {
    try {
      const res = await httpRequest(url, {
        method: 'GET',
        headers: {
          Referer: Pan123Constants.DOWNLOAD_REFERER,
          'User-Agent': Pan123Constants.DART_UA,
        },
      });
      const lenHeader = res.headers.get('content-length');
      const len = lenHeader != null ? Number(lenHeader) : -1;
      if (!(len >= 0 && len <= 8192)) {
        // 无 Content-Length 或体积过大 → 真实文件流，保持当前 URL
        try {
          await res.body?.cancel();
        } catch {
          /* 忽略取消失败 */
        }
        return null;
      }
      const body = await res.text();
      if (!body.trimStart().startsWith('{')) return null;
      try {
        const parsed = JSON.parse(body);
        const next = parsed?.data?.redirect_url;
        if (typeof next === 'string' && next.trim()) return next;
      } catch {
        /* 非 JSON，保持当前 URL */
      }
      return null;
    } catch {
      // 任何异常 → 当前 URL 即最终地址
      return null;
    }
  }

  /** 校验登录态 + 取昵称：GET /b/api/user/info → data.Nickname；失败返回 null */
  async fetchNickname(token: string): Promise<string | null> {
    try {
      if (!token || !token.trim()) return null;
      const { authKey, authValue } = this.makeSign('/b/api/user/info');
      const json = await this.executeJson(Pan123Constants.USER_INFO_URL, {
        headers: {
          platform: Pan123Constants.PLATFORM_WEB,
          'app-version': Pan123Constants.APP_VERSION_WEB,
          authorization: `Bearer ${token.trim()}`,
          loginuuid: this.loginuuid,
          'auth-key': authKey,
          'auth-value': authValue,
          'User-Agent': Pan123Constants.WEB_UA,
          Accept: 'application/json, text/plain, */*',
        },
      });
      this.checkOk(json, '获取用户信息失败');
      const nick = Pan123Api.optString(json?.data, 'Nickname');
      return nick.trim() ? nick : null;
    } catch {
      return null;
    }
  }

  // ---------- 内部工具 ----------

  /**
   * 安全取字符串：org.json 的 optString 对缺失/null 返回 ""（不返回 "null"），
   * 这里对齐该语义，避免 JS 的 String(null) === "null" 陷阱。
   */
  private static optString(obj: any, key: string): string {
    const v = obj?.[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : String(v);
  }

  /** 解析响应 InfoList（分享与个人盘结构一致，文档 §5.2/§5.4） */
  private static parseInfoList(data: any): ShareFile[] {
    const arr = data?.InfoList;
    if (!Array.isArray(arr)) return [];
    const out: ShareFile[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const type = Number(item.Type ?? 0);
      out.push({
        fid: Pan123Api.optString(item, 'FileId'),
        fname: Pan123Api.optString(item, 'FileName'),
        fsize: Number(item.Size ?? 0),
        isdir: type === 1,
        pdirFid: Pan123Api.optString(item, 'ParentFileId'),
        // 123 下载需要 S3KeyFlag + Etag + StorageNode，编码进 fidToken："S3KeyFlag|Etag|StorageNode"
        fidToken:
          `${Pan123Api.optString(item, 'S3KeyFlag')}|` +
          `${Pan123Api.optString(item, 'Etag')}|` +
          `${Pan123Api.optString(item, 'StorageNode')}`,
        modifyTime: Pan123Api.optString(item, 'UpdateAt'),
      });
    }
    return out;
  }
}

/** 解码 fidToken（"S3KeyFlag|Etag|StorageNode"；旧格式两段时 StorageNode 为空） */
function decodeToken(fidToken: string): [string, string, string] {
  const parts = (fidToken ?? '').split('|');
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''];
}

/**
 * 解码 123 下载 URL（兼容两种形态，文档 §5.3.1）：
 *  - 形态 1：整段 base64（alist 风格）→ 直接解码，且结果必须以 http 开头才接受；
 *  - 形态 2：download-v2?params=<base64 URL-safe> → 取 params= 之后、下一个 & 之前，-→+ _→/ 后解码。
 * ⚠️ 绝不能用 startsWith("http") 短路：中转页 URL 同样以 http 开头，无法区分。
 * 解码失败/无 params= → null，调用方回退原始串。
 */
export function decodeDownloadUrl(downloadUrl: string): string | null {
  const trimmed = (downloadUrl ?? '').trim();
  // 形态 1：整段 base64（不含协议头的串）
  if (!trimmed.includes('://')) {
    const out = tryBase64Decode(trimmed);
    if (out && out.toLowerCase().startsWith('http')) return out;
    return null;
  }
  // 形态 2：download-v2?params=<base64>
  const idx = trimmed.indexOf('params=');
  if (idx < 0) return null;
  const rest = trimmed.slice(idx + 'params='.length);
  const amp = rest.indexOf('&');
  const params = amp >= 0 ? rest.slice(0, amp) : rest;
  if (!params) return null;
  const normalized = params.replace(/-/g, '+').replace(/_/g, '/');
  const out = tryBase64Decode(normalized);
  if (!out) return null;
  return out;
}

/** 123 云盘适配器：匿名列表 → 登录 + 签名取直链（无转存、无清理） */
export const pan123Adapter: PlatformAdapter = {
  platform: 'PAN123',
  label: '123 云盘',
  /** 取下载直链必须登录（Bearer JWT），但分享列表可匿名浏览 */
  requiresAuth: true,
  canListAnonymous: true,

  isLoggedIn(credential) {
    return isValidToken(credential);
  },

  async createSession(link, pwd, _credential, ctx): Promise<ShareSession> {
    const api = new Pan123Api(ctx);
    // 提取码优先级：用户手输 > 链接/文案自带（Kotlin：pwd?.takeIf { isNotBlank() } ?: parsed.pwd.orEmpty()）
    const sharePwd = pwd?.trim() ? pwd.trim() : '';
    // 用分享根目录列表校验提取码 + 取标题（标题用首个文件名占位，文档待验证 #4）
    const { files } = await api.getShareFiles(
      link,
      sharePwd,
      Pan123Constants.ROOT_FID,
      '0',
      1,
    );
    const title = files.find((f) => f.fname.trim())?.fname ?? link;
    return { shareId: link, stoken: sharePwd, title };
  },

  async listFiles(session, dirFid, _credential, ctx): Promise<ShareFile[]> {
    const api = new Pan123Api(ctx);
    // alist 实证（drivers/123_share/util.go）：next 参数始终固定 "0"，翻页靠 Page 递增；
    // 结束条件：Next=="-1" 或列表为空（Next=="" 表示还有，继续翻页）；Page 封顶 49
    const all: ShareFile[] = [];
    let page = 1;
    for (;;) {
      const { files, nextCursor } = await api.getShareFiles(
        session.shareId,
        session.stoken,
        dirFid,
        '0',
        page,
      );
      all.push(...files);
      const hasMore = files.length > 0 && nextCursor !== null;
      page++;
      if (!hasMore || page > Pan123Constants.MAX_PAGE) break;
    }
    return all;
  },

  async getShareDownloadLink(session, file, credential, ctx): Promise<DownloadLink> {
    const api = new Pan123Api(ctx);
    if (!credential || !credential.trim()) throw new PlatformError('请先登录123云盘');
    const link = await api.getShareLink(session.shareId, file, credential);
    // 文件名以列表为准（响应不含文件名）
    link.filename = file.fname.trim() ? file.fname : link.filename;
    return link;
  },

  async fetchNickname(credential, ctx): Promise<string | null> {
    return new Pan123Api(ctx).fetchNickname(credential);
  },
};

export { Pan123Api };
