/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 XunleiApi.kt + XunleiResolveRepository.kt。
 * 认证用 access_token（Bearer），pan 请求抓包确认无 x-signature，但必须具备：
 *   - 设备标识（X-Device-Id，来自 XunleiDeviceFingerprint）
 *   - 验证码 token（X-Captcha-Token，captcha/init 用 10-salt captcha_sign 换得）
 * 完全使用 Node 内置 fetch（undici），不需要额外 HTTP 依赖。
 */

import type { DownloadLink, QuotaInfo, ShareFile, ShareSession } from '../../../shared/types';
import { XunleiConstants, XunleiDeviceFingerprint, xunleiPanHeaders } from './constants';
import type { PlatformAdapter, ResolveContext } from '../types';
import { PlatformError } from '../types';
import { md5Hex } from '../../util/crypto';
import { sleep } from '../../util/async';

/**
 * 迅雷登录凭据。
 * 对齐 XunleiAccountEntity + ResolveViewModel.currentCredential（那里只传 accessToken）：
 * 桌面版把 accessToken/refreshToken/deviceId/captchaToken 序列化进 credential 字符串。
 * 兼容三种形态：
 *   1) JSON：{"accessToken":"...","refreshToken":"...","deviceId":"...","captchaToken":"..."}
 *   2) 管道串：accessToken|refreshToken|deviceId|captchaToken
 *   3) 裸 JWT（老数据 / 仅 accessToken）→ 设备指纹与 captchaToken 走动态生成/惰性获取
 */
export interface XunleiCredential {
  accessToken: string;
  refreshToken: string;
  deviceId: string;
  captchaToken: string;
}

/** 解析登录凭据（非 JWT 值一律忽略，避免把乱码当 token 用） */
export function parseXunleiCredential(credential: string | null | undefined): XunleiCredential | null {
  const raw = (credential ?? '').trim();
  if (!raw) return null;
  const out: XunleiCredential = { accessToken: '', refreshToken: '', deviceId: '', captchaToken: '' };

  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      out.accessToken = String(j?.accessToken ?? j?.access_token ?? '').trim();
      out.refreshToken = String(j?.refreshToken ?? j?.refresh_token ?? '').trim();
      out.deviceId = String(j?.deviceId ?? j?.device_id ?? '').trim();
      out.captchaToken = String(j?.captchaToken ?? j?.captcha_token ?? '').trim();
    } catch {
      return null;
    }
  } else if (raw.includes('|')) {
    const parts = raw.split('|');
    out.accessToken = (parts[0] ?? '').trim();
    out.refreshToken = (parts[1] ?? '').trim();
    out.deviceId = (parts[2] ?? '').trim();
    out.captchaToken = (parts[3] ?? '').trim();
  } else {
    out.accessToken = raw;
  }

  if (!isJwt(out.accessToken)) return null;
  return out;
}

/** 迅雷 access_token 为 JWT（三段 Base64Url）；Kotlin 侧 jwtExp/jwtSub 亦按 JWT 解析 */
function isJwt(token: string): boolean {
  return token.split('.').length === 3 && token.length > 20;
}

/** 序列化为可落库的 credential 字符串 */
export function serializeXunleiCredential(c: XunleiCredential): string {
  return JSON.stringify({
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    deviceId: c.deviceId,
    captchaToken: c.captchaToken,
  });
}

/** 解析 JWT 载荷（Base64Url，无填充） */
function jwtPayload(token: string): any | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** JWT exp（秒）；解析失败返回 0（对齐 XunleiApi.jwtExp） */
function jwtExp(token: string): number {
  const p = jwtPayload(token);
  return p && typeof p.exp === 'number' ? p.exp : 0;
}

/** JWT sub（用户 ID，captcha/init 的 meta 需要；空 user_id 会拿到降级 token） */
function jwtSub(token: string): string {
  const p = jwtPayload(token);
  return p && typeof p.sub === 'string' ? p.sub : '';
}

/** Kotlin runCatching { ... }.getOrNull() */
async function runCatchingNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** 分享解析结果（对应 Kotlin XunleiShareResult） */
interface XunleiShareResult {
  title: string;
  files: ShareFile[];
  passCodeToken: string;
  shareId: string;
  nextPageToken: string;
}

/** 单页文件列表（对应 Kotlin XunleiFilePage） */
interface XunleiFilePage {
  files: ShareFile[];
  nextPageToken: string;
}

export class XunleiApi {
  /** 401/unauthenticated 时自动刷新：提供 refresh_token 换新 token（由调用方注入并持久化） */
  refreshTokenProvider: (deviceId: string) => Promise<[string, string] | null> = async () => null;

  /** captcha_invalid 时刷新出的新 captcha_token（后续请求优先使用） */
  private refreshedCaptcha: string | null = null;

  /** 当前有效 access_token（401 自动刷新后更新；pan 请求优先使用） */
  private currentAccessToken = '';

  /** 当前用户 ID（从 access_token JWT 解析，captcha init 的 meta 需要） */
  private currentUserId = '';

  constructor(private ctx: ResolveContext) {}

  // ---------- 登录 ----------

  /**
   * 1. 验证码盾初始化，返回 captcha_token（换 token 与 pan 请求需带 X-Captcha-Token）。
   * 官方抓包：client_id 用 app 凭据 Xp6vsxz_7IYVw2BB。
   * 按文档 §9.5：meta 必须带 captcha_sign（10-salt 算法），否则拿到降级 token（POST 类接口可能拒绝）。
   */
  async initCaptcha(
    deviceId: string,
    username: string,
    action = 'POST:/auth/signin/token',
  ): Promise<string | null> {
    const ts = Date.now().toString();
    const sign = this.buildCaptchaSign(deviceId, ts);
    const body = JSON.stringify({
      action,
      captcha_token: '',
      client_id: XunleiConstants.APP_CLIENT_ID,
      device_id: deviceId,
      meta: {
        username,
        client_version: XunleiConstants.APP_CLIENT_VERSION,
        package_name: XunleiConstants.APP_PACKAGE_NAME,
        timestamp: ts,
        captcha_sign: sign,
        // 真实 user_id，空会得到降级 token
        user_id: this.currentUserId,
      },
      redirect_uri: XunleiConstants.REDIRECT_URI,
    });
    const headers: Record<string, string> = {
      'User-Agent': XunleiConstants.APP_UA,
      Accept: 'application/json;charset=UTF-8',
      'Content-Type': 'application/json',
      'X-Client-Id': XunleiConstants.APP_CLIENT_ID,
      'X-Device-Id': deviceId,
      'X-Client-Version': XunleiConstants.CLIENT_VERSION_HEADER,
    };
    return runCatchingNull(async () => {
      const res = await this.ctx.http(XunleiConstants.CAPTCHA_INIT_URL, {
        method: 'POST',
        headers,
        body,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      const token = String(json?.captcha_token ?? '');
      return token || null;
    });
  }

  /** 2. 账号密码登录（官方首次登录：creditkey=""，sdk UA）。 */
  async loginWithPassword(
    username: string,
    password: string,
    deviceId: string,
    checkCode = '',
  ): Promise<Record<string, string>> {
    const body = JSON.stringify({
      ...this.baseLoginBody(deviceId, '25.0.5.25', '513006'),
      userName: username,
      passWord: password,
      verifyKey: '',
      verifyCode: checkCode,
      isMd5Pwd: '0',
    });
    // 官方抓包 v3/login 头：sdk UA + content-type，无 Cookie，无 x-device-id/x-client-id
    const res = await this.ctx.http(XunleiConstants.LOGIN_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'android-ok-http-client/xl-acc-sdk/version-5.1.3.513006',
        'Content-Type': 'application/json',
      },
      body,
    });
    const text = await res.text();
    return this.parseLoginResponse(text ? JSON.parse(text) : {});
  }

  /** 3a. 发送短信验证码（官方：UA=xl-acc-sdk/version-5.0.12.512000，creditkey=""，无 Cookie） */
  async sendSms(mobile: string, deviceId: string): Promise<Record<string, string>> {
    const body = JSON.stringify({
      ...this.baseLoginBody(deviceId, '8.31.0.9726', '231500'),
      mobile,
      register: '0',
    });
    const res = await this.ctx.http(XunleiConstants.SEND_SMS_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'android-ok-http-client/xl-acc-sdk/version-5.0.12.512000',
        'Content-Type': 'application/json',
      },
      body,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    return {
      needSms: 'true',
      smsCreditKey: String(json?.creditkey ?? ''),
      smsToken: String(json?.token ?? ''),
      message: String(json?.errorDesc ?? '') || '短信已发送',
    };
  }

  /** 3b. 短信验证码登录（官方：UA=xl-acc-sdk/version-5.0.12.512000，body 带 creditkey/token，无 Cookie） */
  async smsLogin(
    mobile: string,
    smsCode: string,
    creditKey: string,
    smsToken: string,
    deviceId: string,
  ): Promise<Record<string, string>> {
    const body = JSON.stringify({
      ...this.baseLoginBody(deviceId, '8.31.0.9726', '231500', creditKey),
      mobile,
      smsCode,
      token: smsToken,
      register: '0',
    });
    const res = await this.ctx.http(XunleiConstants.SMS_LOGIN_URL, {
      method: 'POST',
      headers: {
        'User-Agent': 'android-ok-http-client/xl-acc-sdk/version-5.0.12.512000',
        'Content-Type': 'application/json',
      },
      body,
    });
    const text = await res.text();
    return this.parseLoginResponse(text ? JSON.parse(text) : {});
  }

  /** 4. 用 v3/smslogin 返回的 sessionID 换取 access_token（官方抓包 POST /v1/auth/signin/token）。 */
  async exchangeToken(
    sessionId: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<[string, string] | null> {
    const body = JSON.stringify({
      client_id: XunleiConstants.APP_CLIENT_ID,
      client_secret: XunleiConstants.APP_CLIENT_SECRET,
      provider: 'access_end_point_token',
      signin_token: sessionId,
    });
    const headers: Record<string, string> = {
      'User-Agent': XunleiConstants.APP_UA,
      Accept: 'application/json;charset=UTF-8',
      'Content-Type': 'application/json',
      'X-Client-Id': XunleiConstants.APP_CLIENT_ID,
      'X-Device-Id': deviceId,
      'X-Client-Version': XunleiConstants.CLIENT_VERSION_HEADER,
    };
    if (captchaToken) headers['X-Captcha-Token'] = captchaToken;
    return runCatchingNull(async () => {
      const res = await this.ctx.http(XunleiConstants.TOKEN_URL, { method: 'POST', headers, body });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      const at = String(json?.access_token || json?.accessToken || '');
      const rt = String(json?.refresh_token || json?.refreshToken || '');
      if (!at) return null;
      // 缓存 user_id（JWT sub），captcha/init 的 meta 需要
      const sub = jwtSub(at);
      if (sub) this.currentUserId = sub;
      this.currentAccessToken = at;
      return [at, rt] as [string, string];
    });
  }

  /** 缓存当前用户 ID（从 access_token JWT 解析），供 captcha/init 的 meta 使用 */
  cacheUserId(accessToken: string): void {
    if (!this.currentUserId) this.currentUserId = jwtSub(accessToken);
  }

  /** 自身 JWT exp（秒）；解析失败返回 0（对齐 XunleiApi.jwtExp，供 repository 判断是否续期） */
  jwtExp(token: string): number {
    return jwtExp(token);
  }

  // ---------- 登录（账号密码 / 短信 / 换 token） ----------
  // 说明：本适配器只覆盖 PlatformAdapter 的解析流程（分享 → 列表 → 转存 → 直链）。
  // 下面的 loginWithPassword / exchangeToken / initCaptcha / refreshToken 是 XunleiApi.kt
  // 登录链路的忠实移植（v3/login → sendsms/smslogin → captcha/init → v1/auth/signin/token），
  // 目前没有调用方：桌面版登录走 main.ts 的「打开登录页抓 Cookie」通用路径。
  // 若后续要接入迅雷专用登录 UI，按 XunleiAccountRepository.kt 的时序直接调用即可。

  /**
   * 用 refresh_token 刷新 access_token（OAuth2 refresh_token）。
   * 导入恢复后旧 token 可能已过期（12h），刷新后立即有效。
   * @return 新 (access_token, refresh_token)；失败返回 null
   */
  async refreshToken(refreshToken: string, deviceId: string): Promise<[string, string] | null> {
    const body =
      'grant_type=refresh_token' +
      `&client_id=${XunleiConstants.APP_CLIENT_ID}` +
      `&client_secret=${XunleiConstants.APP_CLIENT_SECRET}` +
      `&refresh_token=${encodeURIComponent(refreshToken)}`;
    return runCatchingNull(async () => {
      const res = await this.ctx.http(XunleiConstants.REFRESH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Device-Id': deviceId,
        },
        body,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      const at = String(json?.access_token || json?.accessToken || '');
      const rt = String(json?.refresh_token || json?.refreshToken || '');
      if (!at) return null;
      const sub = jwtSub(at);
      if (sub) this.currentUserId = sub;
      this.currentAccessToken = at;
      return [at, rt] as [string, string];
    });
  }

  /** 解析 v3/login / v3/smslogin 响应（保持 Kotlin 的字段名与判定） */
  private parseLoginResponse(json: any): Record<string, string> {
    const errorCode = String(json?.errorCode ?? '');
    if (errorCode === '0' || String(json?.error ?? '') === 'success') {
      return {
        needSms: 'false',
        sessionKey: String(json?.loginKey ?? ''),
        sessionId: String(json?.sessionID ?? ''),
        nickname: String(json?.nickName ?? ''),
        userID: String(json?.userID ?? ''),
        reviewUrl: '',
        message: '登录成功',
      };
    }
    // 触发验证面板（review_panel）→ 需要短信验证
    const error = String(json?.error ?? '');
    const verifyType = String(json?.verifyType ?? '');
    const needSms = error === 'review_panel' || errorCode === '1007' || verifyType !== '';
    return {
      needSms: needSms ? 'true' : 'false',
      sessionKey: '',
      sessionId: '',
      nickname: '',
      userID: '',
      // 短信发不出时可让用户浏览器完成验证（alist 方式）
      reviewUrl: String(json?.reviewurl ?? ''),
      message: String(json?.errorDesc || json?.error_description || ''),
    };
  }

  /** 登录请求公共体（对齐官方 app 抓包字段；peerID/devicesign 用动态生成的设备指纹） */
  private baseLoginBody(
    deviceId: string,
    clientVersion: string,
    sdkVersion: string,
    creditKey = '',
  ): Record<string, string> {
    return {
      protocolVersion: '301',
      // Kotlin: Random.nextLong(10000000, 99999999).toString()（上限 99999999 与 Kotlin 一致，不上到 1e8）
      sequenceNo: String(10_000_000 + Math.floor(Math.random() * (99_999_999 - 10_000_000))),
      platformVersion: '10',
      isCompressed: '0',
      appid: '40',
      clientVersion,
      peerID: XunleiDeviceFingerprint.peerId(), // 动态设备 peerID
      appName: 'ANDROID-com.xunlei.downloadprovider',
      sdkVersion,
      devicesign: XunleiDeviceFingerprint.deviceSign(), // 动态设备指纹（§8 公式）
      netWorkType: 'WIFI',
      providerName: 'NONE',
      deviceModel: 'M2004J7AC',
      deviceName: 'Xiaomi_M2004j7ac',
      OSVersion: '12',
      creditkey: creditKey,
      hl: 'zh-CN',
    };
  }

  // ---------- Pan ----------

  /** 单页文件列表（个人网盘，parent_id 为空=根目录），返回 (文件, 下一页游标 or 空串=末页) */
  private async getFilesPage(
    parentId: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
    pageToken: string,
  ): Promise<[ShareFile[], string]> {
    const filters = encodeURIComponent('{"trashed":{"eq":false}}');
    const url =
      `${XunleiConstants.FILES_URL}` +
      `?parent_id=${parentId}` +
      `&page_token=${encodeURIComponent(pageToken)}` +
      `&limit=100&with_audit=true&filters=${filters}`;
    return this.panCall(
      captchaToken,
      deviceId,
      'GET:/drive/v1/files',
      (t) => this.panRequest(url, accessToken, deviceId, t),
      (data) => {
        const files = this.parseFileArray(data?.files);
        // 解析 next_page_token 作为下一页游标；空串表示已到末页
        return [files, String(data?.next_page_token ?? '')] as [ShareFile[], string];
      },
    );
  }

  /** 文件列表（个人网盘，parent_id 为空=根目录；自动翻页，返回该目录下全部文件） */
  async getFiles(
    parentId: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<ShareFile[] | null> {
    const all: ShareFile[] = [];
    let token = '';
    // 封顶 100 页，防异常死循环
    for (let i = 0; i < XunleiConstants.MAX_FILE_PAGES; i++) {
      const [files, next] = await this.getFilesPage(parentId, accessToken, deviceId, captchaToken, token);
      all.push(...files);
      if (!next) return all.length ? all : null;
      token = next;
    }
    return all.length ? all : null;
  }

  /** 创建文件夹（个人网盘），返回新文件夹 id */
  async createFolder(
    name: string,
    parentId: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<string | null> {
    const body = JSON.stringify({
      kind: 'drive#folder',
      name,
      parent_id: parentId,
      // 官方 proto 要求字符串，数字会 400
      space: '',
    });
    return this.panCall(
      captchaToken,
      deviceId,
      'POST:/drive/v1/files',
      (t) => this.panRequest(XunleiConstants.FILES_URL, accessToken, deviceId, t, body),
      (data) => {
        const id = String(data?.id ?? '');
        return id || null;
      },
    );
  }

  /** 文件详情（返回下载直链 links.application/octet-stream.url） */
  async getFileDetail(
    fileId: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<DownloadLink | null> {
    const url =
      `${XunleiConstants.FILES_URL}/${fileId}?_magic=2021&usage=PLAY&thumbnail_size=SIZE_LARGE` +
      `&with=hdr10&with=subtitle_files&with=task&with=public_share_tag`;
    return this.panCall(
      captchaToken,
      deviceId,
      `GET:/drive/v1/files/${fileId}`,
      (t) => this.panRequest(url, accessToken, deviceId, t),
      (data) => {
        const urlStr = String(
          data?.links?.['application/octet-stream']?.url || data?.web_content_link || '',
        );
        return {
          fid: String(data?.id ?? ''),
          filename: String(data?.name ?? ''),
          downloadUrl: urlStr,
          size: Number(data?.size ?? 0),
        } as DownloadLink;
      },
    );
  }

  /** 分享解析（share_id + 可选 pass_code） */
  async getShare(
    shareId: string,
    passCode: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
    pageToken = '',
  ): Promise<XunleiShareResult | null> {
    const url =
      `${XunleiConstants.SHARE_URL}` +
      `?share_id=${shareId}` +
      `&pass_code=${encodeURIComponent(passCode)}` +
      `&limit=100&page_token=${encodeURIComponent(pageToken)}` +
      `&thumbnail_size=SIZE_SMALL`;
    return this.panCall(
      captchaToken,
      deviceId,
      'GET:/drive/v1/share',
      (t) => this.panRequest(url, accessToken, deviceId, t),
      (data) => {
        // 提取码状态检查：PASS_CODE_EMPTY（没填）/ PASS_CODE_ERROR（错误）/ PASS_CODE_NEED（需要）
        // 这三种情况 files 为空数组且 HTTP 200，若不识别会被误判为「此目录为空」
        switch (String(data?.share_status ?? '')) {
          case 'PASS_CODE_EMPTY':
            throw new PlatformError('请输入提取码');
          case 'PASS_CODE_ERROR':
            throw new PlatformError('提取码错误');
          case 'PASS_CODE_NEED':
            throw new PlatformError('该分享需要提取码');
        }
        return {
          title: String(data?.title ?? ''),
          files: this.parseFileArray(data?.files),
          passCodeToken: String(data?.pass_code_token ?? ''),
          shareId,
          nextPageToken: String(data?.next_page_token ?? ''),
        } as XunleiShareResult;
      },
    );
  }

  /** 分享子目录文件列表（share/detail，parent_id + pass_code_token） */
  async getShareDetail(
    shareId: string,
    parentId: string,
    passCodeToken: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
    pageToken = '',
  ): Promise<XunleiFilePage | null> {
    const url =
      `${XunleiConstants.SHARE_DETAIL_URL}` +
      `?share_id=${shareId}` +
      `&parent_id=${parentId}` +
      `&pass_code_token=${encodeURIComponent(passCodeToken)}` +
      `&limit=100&page_token=${encodeURIComponent(pageToken)}` +
      `&thumbnail_size=SIZE_SMALL`;
    return this.panCall(
      captchaToken,
      deviceId,
      'GET:/drive/v1/share/detail',
      (t) => this.panRequest(url, accessToken, deviceId, t),
      (data) => ({
        files: this.parseFileArray(data?.files),
        nextPageToken: String(data?.next_page_token ?? ''),
      }),
    );
  }

  /** 转存到指定目录（官方同步返回 RESTORE_COMPLETE + trace_file_ids 映射），返回转存后的新文件 id */
  async restore(
    shareId: string,
    passCodeToken: string,
    parentFolderId: string,
    fileIds: string[],
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<string | null> {
    const body = JSON.stringify({
      share_id: shareId,
      pass_code_token: passCodeToken,
      parent_id: parentFolderId,
      ancestor_ids: [],
      file_ids: fileIds,
      specify_parent_id: true,
    });
    return this.panCall(
      captchaToken,
      deviceId,
      'POST:/drive/v1/share/restore',
      (t) => this.panRequest(XunleiConstants.RESTORE_URL, accessToken, deviceId, t, body),
      (data) => {
        // params.trace_file_ids 是 JSON 字符串：{"分享文件id":"转存后新id"}
        const trace = String(data?.params?.trace_file_ids ?? '');
        if (trace) {
          try {
            const map = JSON.parse(trace);
            for (const id of fileIds) {
              const mapped = map?.[id];
              if (typeof mapped === 'string' && mapped) return mapped;
            }
          } catch {
            /* 解析失败落到下面的 file_id 兜底 */
          }
        }
        const direct = String(data?.file_id ?? '');
        return direct || null;
      },
    );
  }

  /** 批量删除文件（转存后的临时文件；直链已自带签名，删除不影响下载） */
  async batchDelete(
    ids: string[],
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<boolean> {
    const body = JSON.stringify({ ids, space: '' });
    return this.panCall(
      captchaToken,
      deviceId,
      'POST:/drive/v1/files:batchDelete',
      (t) => this.panRequest(`${XunleiConstants.FILES_URL}:batchDelete`, accessToken, deviceId, t, body),
      () => true,
    );
  }

  /** 轮询转存任务（Kotlin：最多 15 次 × 1s） */
  async pollTask(
    taskId: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<boolean> {
    const url = `${XunleiConstants.TASKS_URL}/${taskId}?type=share`;
    for (let i = 0; i < XunleiConstants.POLL_TASK_ATTEMPTS; i++) {
      const done = await runCatchingNull(() =>
        this.panCall(
          captchaToken,
          deviceId,
          `GET:/drive/v1/tasks/${taskId}`,
          (t) => this.panRequest(url, accessToken, deviceId, t),
          (data) => {
            const status = String(data?.status || data?.phase || '');
            return status === 'PHASE_TYPE_COMPLETE' || Number(data?.error_code ?? -1) === 0;
          },
        ),
      );
      if (done) return true;
      await sleep(XunleiConstants.POLL_TASK_INTERVAL_MS);
    }
    return false;
  }

  /** 确保「YunX临时转存」目录存在，返回其 id */
  async ensureTempDir(
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<string | null> {
    const root = (await this.getFiles('', accessToken, deviceId, captchaToken)) ?? [];
    const existing = root.find((f) => f.isdir && f.fname === XunleiConstants.TEMP_DIR_NAME)?.fid;
    if (existing) return existing;
    return this.createFolder(XunleiConstants.TEMP_DIR_NAME, '', accessToken, deviceId, captchaToken);
  }

  // ---------- 云盘文件管理 ----------

  /** 网盘空间详情（GET /drive/v1/about：quota.limit / usage） */
  async getQuota(
    accessToken: string,
    deviceId: string,
    captchaToken: string,
  ): Promise<QuotaInfo | null> {
    return runCatchingNull(() =>
      this.panCall(
        captchaToken,
        deviceId,
        'GET:/drive/v1/about',
        (t) => this.panRequest(XunleiConstants.ABOUT_URL, accessToken, deviceId, t),
        (data) => {
          const quota = data?.quota;
          return {
            used: Number(quota?.usage ?? 0),
            total: Number(quota?.limit ?? 0),
            usedInTrash: Number(quota?.usage_in_trash ?? 0),
          } as QuotaInfo;
        },
      ),
    );
  }

  // ---------- 请求构造 ----------

  private parseFileArray(array: any): ShareFile[] {
    if (!Array.isArray(array)) return [];
    return array.map(
      (item): ShareFile => ({
        fid: String(item?.id ?? ''),
        fname: String(item?.name ?? ''),
        fsize: Number(item?.size ?? 0),
        isdir: String(item?.kind ?? '') === 'drive#folder',
        pdirFid: String(item?.parent_id ?? ''),
        fidToken: '',
        modifyTime: String(item?.modified_time ?? ''),
      }),
    );
  }

  /** pan 请求（Bearer + 设备 + captcha 头，抓包确认无 x-signature） */
  private async panRequest(
    url: string,
    accessToken: string,
    deviceId: string,
    captchaToken: string,
    body?: string,
  ): Promise<Response> {
    const headers = xunleiPanHeaders(
      this.currentAccessToken || accessToken,
      deviceId,
      captchaToken,
    );
    return this.ctx.http(url, {
      method: body !== undefined ? 'POST' : 'GET',
      headers,
      body,
    });
  }

  /**
   * pan 请求带验证码自动刷新重试：失败 captcha_invalid → 用旧 token 换新 token → 重试一次（对齐官方）。
   * Kotlin 用 repeat(2) + return@repeat 的「继续下一次迭代」语义，此处用 continue 等价表达。
   */
  private async panCall<T>(
    captchaToken: string,
    deviceId: string,
    action: string,
    build: (token: string) => Promise<Response>,
    parse: (data: any) => T,
  ): Promise<T> {
    let token = this.refreshedCaptcha ?? captchaToken;
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await build(token);
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new PlatformError('响应解析失败');
      }
      if (!res.ok || json?.error) {
        const err = String(json?.error ?? '');
        // access_token 过期（401/unauthenticated）：refresh_token 换新 → 重新 init captcha → 重试
        if ((res.status === 401 || err === 'unauthenticated') && attempt === 0) {
          const refreshed = await this.refreshTokenProvider(deviceId);
          if (refreshed) {
            this.currentAccessToken = refreshed[0];
            const newCaptcha = await this.initPanCaptcha(deviceId, action, token);
            if (newCaptcha) {
              this.refreshedCaptcha = newCaptcha;
              token = newCaptcha;
            }
            continue;
          }
        }
        if (err === 'captcha_invalid' && attempt === 0) {
          // 用正确 action + captcha_sign 重新 init（携带旧 token），拿有效 token 后重试
          const newToken = await this.initPanCaptcha(deviceId, action, token);
          if (newToken) {
            this.refreshedCaptcha = newToken;
            token = newToken;
            continue;
          }
        }
        const msg =
          String(json?.error_description || json?.message || '').trim() || err || '请求失败';
        throw new PlatformError(msg, res.status);
      }
      return parse(json?.data ?? json);
    }
    throw new PlatformError('验证码刷新后仍失败');
  }

  /**
   * 用请求对应 action + 正确 captcha_sign 初始化 captcha（pan 专用，alist 算法已验证）。
   * 算法：raw = client_id+client_version+package_name+device_id+timestamp_ms，10 层 md5(raw+salt)，sign="1."+结果
   */
  private async initPanCaptcha(
    deviceId: string,
    action: string,
    oldToken: string,
  ): Promise<string | null> {
    const ts = Date.now().toString();
    const sign = this.buildCaptchaSign(deviceId, ts);
    const body = JSON.stringify({
      client_id: XunleiConstants.APP_CLIENT_ID,
      action,
      device_id: deviceId,
      redirect_uri: XunleiConstants.REDIRECT_URI,
      meta: {
        client_version: XunleiConstants.APP_CLIENT_VERSION,
        package_name: XunleiConstants.APP_PACKAGE_NAME,
        timestamp: ts,
        captcha_sign: sign,
        // 真实 user_id，空会得到降级 token（POST 类接口拒绝）
        user_id: this.currentUserId,
      },
      captcha_token: oldToken,
    });
    return runCatchingNull(async () => {
      const res = await this.ctx.http(XunleiConstants.CAPTCHA_INIT_URL, {
        method: 'POST',
        headers: {
          'User-Agent': XunleiConstants.APP_UA,
          Accept: 'application/json;charset=UTF-8',
          'Content-Type': 'application/json',
          'X-Client-Id': XunleiConstants.APP_CLIENT_ID,
          'X-Device-Id': deviceId,
          'X-Client-Version': XunleiConstants.CLIENT_VERSION_HEADER,
        },
        body,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      const token = String(json?.captcha_token ?? '');
      return token || null;
    });
  }

  /** captcha_sign：client_id+client_version+package_name+device_id+timestamp_ms → 10 层 md5(raw+salt)，前缀 "1." */
  private buildCaptchaSign(deviceId: string, tsMs: string): string {
    let h =
      XunleiConstants.APP_CLIENT_ID +
      XunleiConstants.APP_CLIENT_VERSION +
      XunleiConstants.APP_PACKAGE_NAME +
      deviceId +
      tsMs;
    for (const salt of XunleiConstants.CAPTCHA_SALTS) {
      h = md5Hex(h + salt);
    }
    return `1.${h}`;
  }
}

/** 迅雷网盘适配器：分享解析 → 转存到临时目录 → 文件详情取直链（直链自带签名） */
export const xunleiAdapter: PlatformAdapter = {
  platform: 'XUNLEI',
  label: '迅雷网盘',
  /** 迅雷 pan 接口全需 Bearer access_token（share 解析也是带认证的请求） */
  requiresAuth: true,
  /** XunleiResolveRepository.token() 缺少 token 直接抛「请先登录迅雷网盘」 */
  canListAnonymous: false,

  isLoggedIn(credential) {
    // Kotlin：accessToken 为空即未登录（ResolveViewModel 用 currentCredential 判空后报「请先登录」）；
    // credential 需可解析出 access_token（裸 JWT 或多字段 JSON）
    return parseXunleiCredential(credential) !== null;
  },

  async createSession(link, pwd, credential, ctx): Promise<ShareSession> {
    const api = new XunleiApi(ctx);
    const auth = await resolveAuth(api, credential, ctx);
    const effectivePwd = pwd?.trim() ? pwd.trim() : '';
    // Kotlin: passCodes[shareId] = effectivePwd —— 提取码是会话级状态，
    // 顶层 listFiles 仍要走 share（带提取码），故这里记住它
    rememberXunleiPassCode(link, effectivePwd);
    const result = await api.getShare(
      link,
      effectivePwd,
      auth.accessToken,
      auth.deviceId,
      auth.captchaToken,
    );
    if (!result) throw new PlatformError('未获取到分享信息');
    return { shareId: link, stoken: result.passCodeToken, title: result.title };
  },

  /**
   * 文件列表（对齐 XunleiResolveRepository.listFiles）：
   * 顶部目录用 share（带提取码），子目录用 share/detail（parent_id + pass_code_token）；
   * 翻页游标 next_page_token，空串表示末页，封顶 100 页。
   */
  async listFiles(session, dirFid, credential, ctx): Promise<ShareFile[]> {
    const api = new XunleiApi(ctx);
    const auth = await resolveAuth(api, credential, ctx);
    // 会话 stoken 即迅雷的 pass_code_token；提取码来自 createSession 记录（passCodes）
    const passCode = getXunleiPassCode(session.shareId);
    const files: ShareFile[] = [];
    let pageToken = '';
    let pages = 0;
    do {
      if (!dirFid || dirFid === '0') {
        const page = await api.getShare(
          session.shareId,
          passCode,
          auth.accessToken,
          auth.deviceId,
          auth.captchaToken,
          pageToken,
        );
        if (!page) throw new PlatformError('未获取到文件列表');
        files.push(...page.files);
        pageToken = page.nextPageToken;
      } else {
        const page = await api.getShareDetail(
          session.shareId,
          dirFid,
          session.stoken,
          auth.accessToken,
          auth.deviceId,
          auth.captchaToken,
          pageToken,
        );
        if (!page) throw new PlatformError('未获取到文件列表');
        files.push(...page.files);
        pageToken = page.nextPageToken;
      }
      pages++;
    } while (pageToken && pages < XunleiConstants.MAX_FILE_PAGES);
    return files;
  },

  /**
   * 迅雷取直链（对齐 XunleiResolveRepository.getShareDownloadLink）：
   * ensureTempDir → restore（官方同步转存，返回 trace_file_ids 新 id） → getFileDetail 取直链
   * → 立即 batchDelete 临时转存文件（直链自带签名，删除不影响下载；失败不阻断）。
   */
  async getShareDownloadLink(session, file, credential, ctx): Promise<DownloadLink> {
    const api = new XunleiApi(ctx);
    const auth = await resolveAuth(api, credential, ctx);

    const dirFid = await api.ensureTempDir(auth.accessToken, auth.deviceId, auth.captchaToken);
    if (!dirFid) throw new PlatformError('创建临时目录失败');

    // 官方同步转存：restore 返回 trace_file_ids 映射，直接得到转存后的新文件 id（无需轮询）
    const savedFid = await api.restore(
      session.shareId,
      session.stoken,
      dirFid,
      [file.fid],
      auth.accessToken,
      auth.deviceId,
      auth.captchaToken,
    );
    if (!savedFid) throw new PlatformError('转存失败');

    const link = await api.getFileDetail(savedFid, auth.accessToken, auth.deviceId, auth.captchaToken);
    if (!link) throw new PlatformError('获取下载链接失败');

    // 拿到直链后立即删除临时转存的文件（对齐官方 batchDelete；失败不阻断下载）
    await runCatchingNull(() =>
      api.batchDelete([savedFid], auth.accessToken, auth.deviceId, auth.captchaToken),
    );

    return {
      ...link,
      filename: link.filename || file.fname,
      // 迅雷直链 URL 自带签名，无需 Cookie；但必须用官方 app UA，
      // 浏览器 UA 会触发 CDN 降级（200 整文件）（对齐 ResolveViewModel.enqueueDownload）。
      headers: { 'User-Agent': XunleiConstants.APP_UA },
    };
  },

  async getQuota(credential, ctx): Promise<QuotaInfo | null> {
    try {
      const api = new XunleiApi(ctx);
      const auth = await resolveAuth(api, credential, ctx);
      return api.getQuota(auth.accessToken, auth.deviceId, auth.captchaToken);
    } catch {
      return null;
    }
  },

  async fetchNickname(credential): Promise<string | null> {
    // 迅雷昵称只在 v3/login 响应里返回，桌面版未持久化；凭证本身不含昵称
    return null;
  },
};

/**
 * 凭据 → 运行时认证信息。
 * 桌面版 credential 需自描述（accessToken/refreshToken/deviceId/captchaToken，见 parseXunleiCredential）；
 * 缺失的运行时字段按 Kotlin 语义惰性补齐：
 *   - deviceId：无则用 XunleiDeviceFingerprint 动态生成（Kotlin XunleiApi.newDeviceId 同义）；
 *   - captchaToken：无则用当前用户 JWT sub 作为 meta.username 调 captcha/init，
 *     action 取列表接口的 "GET:/drive/v1/share"（与 Kotlin 首次 pan 调用的 action 一致）。
 */
interface XunleiAuth extends XunleiCredential {
  /** 是否本次刚刷新过 token（调用方据此回写凭据） */
  refreshed: boolean;
}

/** 会话内缓存：shareId → 提取码（对齐 Kotlin XunleiResolveRepository.passCodes） */
const passCodeCache = new Map<string, string>();

/**
 * 由适配器流程调用（createSession / listFiles / getShareDownloadLink / getQuota），
 * 每次重新解析凭据；token 剩余寿命不足 60s 时用 refresh_token 自动续期，
 * 续期成功会通过 ctx.saveCookie 回写（对齐 Kotlin XunleiAccountRepository.updateTokens 落库）。
 */
async function resolveAuth(
  api: XunleiApi,
  credential: string,
  ctx: ResolveContext,
): Promise<XunleiAuth> {
  const parsed = parseXunleiCredential(credential);
  if (!parsed) throw new PlatformError('请先登录迅雷网盘');

  let refreshed = false;
  // token 即将过期（<60s）或已过期 → 用 refresh_token 自动刷新（对齐 ensureFreshToken）
  const exp = api.jwtExp(parsed.accessToken);
  if (exp > 0 && exp - Date.now() / 1000 <= XunleiConstants.TOKEN_REFRESH_MARGIN_SEC) {
    const next = parsed.refreshToken
      ? await api.refreshToken(parsed.refreshToken, parsed.deviceId)
      : null;
    // 刷新失败（refresh_token 被轮换/过期）→ 抛明确错误引导重新登录（对齐 Kotlin）
    if (!next) throw new PlatformError('迅雷登录已过期，请重新登录');
    parsed.accessToken = next[0];
    parsed.refreshToken = next[1] || parsed.refreshToken;
    refreshed = true;
  }

  api.cacheUserId(parsed.accessToken);

  const deviceId = parsed.deviceId || XunleiDeviceFingerprint.deviceId();

  let captchaToken = parsed.captchaToken;
  if (!captchaToken) {
    // Kotlin 时序：smslogin → captcha/init → signin/token；pan 请求前若缺 token 同样先 init
    captchaToken =
      (await api.initCaptcha(deviceId, jwtSub(parsed.accessToken), 'GET:/drive/v1/share')) ?? '';
  }

  if (refreshed) {
    // 回写续期后的凭据（deviceId/captchaToken 保持不变，对齐 Kotlin updateTokens）
    ctx.saveCookie?.(
      serializeXunleiCredential({ ...parsed, deviceId, captchaToken }),
    );
  }

  return { ...parsed, deviceId, captchaToken, refreshed };
}

/** 记录 shareId → 提取码（createSession 时调用，供 listFiles 顶层解析复用） */
export function rememberXunleiPassCode(shareId: string, pwd: string | null | undefined): void {
  passCodeCache.set(shareId, (pwd ?? '').trim());
}

/** 读取记录的提取码 */
export function getXunleiPassCode(shareId: string): string {
  return passCodeCache.get(shareId) ?? '';
}
