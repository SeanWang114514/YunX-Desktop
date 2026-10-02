/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 C139Api.kt + C139ResolveRepository.kt。
 * 完全使用 Node 内置 fetch（undici），不需要额外 HTTP 依赖。
 *
 * 分享解析（7.13+）：share-kd-njs.yun.139.com
 *   - 列目录 getOutLinkInfoV6（pCaID:"root"/父 coID，passwd 提取码）—— **匿名调用**
 *   - 下载 dlFromOutLinkV3（coIDLst.item:[coID] → data.redrUrl OBS 直链，900s）
 * 请求/响应均经 AES-CBC 加密：base64(IV(16B) ‖ AES_CBC(KEY=PVGDwmcvfs1uV3d1, IV, 明文))；
 * mcloud-sign 按「明文 body」计算，加密只是传输包装。
 */

import type { DownloadLink, ShareFile, ShareSession } from '../../../shared/types';
import {
  C139Constants,
  extractAccountFull,
  extractAuthorization,
  isValidCookie,
} from './constants';
import type { PlatformAdapter, ResolveContext } from '../types';
import { PlatformError } from '../types';
import {
  aesCbcDecryptFromBase64,
  aesCbcEncryptBase64,
  base64Encode,
  formatDateTime,
  javaUrlEncodeSpaceAsPct20,
  md5Hex,
  md5Upper,
} from '../../util/crypto';

/**
 * 把 139 的服务端错误码翻译成中文提示。
 * 9530 = 缺少设备/渠道上下文头（分享接口必带，缺任一即报）；9188 = 提取码错误。
 */
function friendlyError(msg: string, code: string): string {
  if (code === C139Constants.ERR_WRONG_PASSWORD) {
    return msg && !/^\d+$/.test(msg) ? msg : '分享提取码错误，请在链接后附带正确提取码后重试';
  }
  if (code === C139Constants.ERR_MISSING_DEVICE_HEADERS) {
    return msg && !/^\d+$/.test(msg)
      ? msg
      : '请求被 139 网关拒绝（9530）：缺少设备/渠道上下文头，请更新客户端后重试';
  }
  return msg;
}

class C139Api {
  constructor(private ctx: ResolveContext) {}

  // ---------- mcloud-sign 签名（§4） ----------

  /**
   * §4.2 calSign：
   * 明文 body → encodeURIComponent → 单字符 ASCII 升序 → base64 →
   * md5(base64) + md5("ts:rand") → md5 → 大写。
   * ⚠️ 签名必须基于与实际发送一致的「明文 JSON」字符串（字段顺序、无空格）。
   */
  calSign(bodyJson: string, ts: string, rand: string): string {
    const encoded = javaUrlEncodeSpaceAsPct20(bodyJson);
    const sorted = encoded.split('').sort().join('');
    const b64 = base64Encode(sorted);
    const res = md5Hex(b64) + md5Hex(`${ts}:${rand}`);
    return md5Upper(res);
  }

  /** 生成 mcloud-sign 头值：`<ts>,<rand>,<sign>`；ts 为本地时间 "yyyy-MM-dd HH:mm:ss"，rand 16 位字母数字 */
  signHeader(bodyJson: string): string {
    const ts = formatDateTime(new Date());
    const pool = C139Constants.RAND_POOL;
    let rand = '';
    for (let i = 0; i < 16; i++) rand += pool[Math.floor(Math.random() * pool.length)];
    return `${ts},${rand},${this.calSign(bodyJson, ts, rand)}`;
  }

  // ---------- 请求构造与响应解析 ----------

  /** 分享接口公共请求头（匿名/鉴权两条路径共用） */
  private shareHeaders(): Record<string, string> {
    return {
      // 必须带 hcy-cool-flag: 1（网关解密开关，缺它业务层拿不到明文 → 9530）
      'hcy-cool-flag': '1',
      'x-deviceinfo': C139Constants.SHARE_X_DEVICEINFO,
      'x-huawei-channelsrc': C139Constants.SHARE_X_HUAWEI_CHANNELSRC,
      'x-mm-source': C139Constants.SHARE_X_MM_SOURCE,
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': C139Constants.SHARE_MOBILE_UA,
      Origin: C139Constants.ORIGIN,
      Referer: C139Constants.REFERER,
      Accept: 'application/json, text/plain, */*',
    };
  }

  /**
   * 分享 POST：body 加密发送，响应解密（兼容网关透传明文）。
   * @param authorization 为空则不带 Authorization 头（列表端点为匿名调用）
   * @param withSign 是否计算 mcloud-sign（仅 dlFromOutLinkV3 需要，按明文 body 算）
   */
  private async sharePost(
    url: string,
    plainBody: string,
    opts: { authorization?: string | null; withSign?: boolean } = {},
  ): Promise<any> {
    const headers = this.shareHeaders();
    if (opts.authorization && opts.authorization.trim()) {
      headers.Authorization = opts.authorization;
    }
    if (opts.withSign) {
      // 明文 body 只序列化一次，签名与加密共用同一字符串
      headers['mcloud-sign'] = this.signHeader(plainBody);
    }

    const { text, status } = await this.postRaw(url, headers, aesCbcEncryptBase64(plainBody, C139Constants.SHARE_AES_KEY));
    if (!text) throw new PlatformError(`请求失败：响应为空（${status}）`, status);
    // 响应体应为加密 base64（§14）；网关透传明文时兜底
    return this.parseMaybeEncrypted(text, status);
  }

  /** 发起 POST 请求并返回原始响应文本（走 ctx.http 以便测试注入与统一超时） */
  private async postRaw(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ text: string; status: number }> {
    try {
      const res = await this.ctx.http(url, { method: 'POST', headers, body });
      return { text: await res.text(), status: res.status };
    } catch (e: any) {
      throw new PlatformError(`网络请求失败：${e?.message ?? e}`);
    }
  }

  /** 先尝试 AES 解密后解析，任何失败回退明文 JSON 解析 */
  private parseMaybeEncrypted(text: string, status: number): any {
    try {
      return JSON.parse(aesCbcDecryptFromBase64(text.trim(), C139Constants.SHARE_AES_KEY));
    } catch {
      /* 解密失败 → 明文透传兜底 */
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new PlatformError('响应解析失败', status);
    }
  }

  /** 校验 resultCode / success，失败抛中文错误 */
  private checkShare(json: any, fallback: string): void {
    const resultCode = C139Api.optString(json, 'resultCode');
    const desc = C139Api.optString(json, 'desc');
    if (resultCode && resultCode !== '0') {
      const code = Number(resultCode);
      throw new PlatformError(
        friendlyError(desc, resultCode) || `${fallback}（${resultCode}）`,
        Number.isFinite(code) ? code : undefined,
      );
    }
    if (json?.success === false) {
      throw new PlatformError(desc || fallback);
    }
  }

  // ---------- 分享解析（§15，7.13+ 加密） ----------

  /**
   * 分享标题 + 明文提取码：getOutLinkGeneral（匿名）。
   * 139 会在该接口明文回吐提取码（官方 Web 同样自动填），用于自动填入、避免下载因缺密码报 9188。
   * Kotlin 侧分别调用了 getOutLinkTitle / getOutLinkPassword 两次，这里合并为一次（行为等价）。
   */
  async getOutLinkGeneral(
    linkId: string,
  ): Promise<{ title: string | null; passwd: string | null }> {
    const plain = JSON.stringify({
      getOutLinkGeneralReq: { linkID: linkId, isPasswd: 1, account: '' },
    });
    const json = await this.sharePost(C139Constants.SHARE_GENERAL_URL, plain);
    // Kotlin：resultCode 非空且非 "0"，或 success==false → 直接返回 null（不抛错）
    const resultCode = C139Api.optString(json, 'resultCode');
    if (resultCode && resultCode !== '0') return { title: null, passwd: null };
    if (json?.success === false) return { title: null, passwd: null };

    const arr = json?.data?.getOutLinkGeneralResp?.outLinkGeneral;
    if (!Array.isArray(arr) || arr.length === 0) return { title: null, passwd: null };
    const first = arr[0];
    const lkName = C139Api.optString(first, 'lkName');
    const passwd = C139Api.optString(first, 'passwd');
    return {
      title: lkName.trim() ? lkName : null,
      passwd: passwd.trim() ? passwd : null,
    };
  }

  /**
   * 分享列目录：getOutLinkInfoV6 —— 官方为「匿名」调用：
   * 不带 authorization、不带 mcloud-sign、不带 mcloud-* 头；body account 固定空串；
   * 带完整字段（caSrt/coSrt/srtDr/bNum/eNum），否则 9530；passwd 填错返回 9188。
   * ⚠️ 139 把【子文件夹】放在 caLst、【文件】放在 coLst（coType==2 也可能是文件夹）。
   *    只读 coLst 会导致「顶层是文件夹 / 顶层只挂子文件夹」的分享显示为空，
   *    因此两者必须都解析并合并（文件夹在前）。
   * @param pcaId 根目录传 "root"（不能为空），子目录传父级 caID（或 coType==2 的 coID）
   * @param passwd 提取码（无则空串）
   */
  async getShareFiles(
    linkId: string,
    pcaId: string,
    passwd: string,
    begin = 1,
    end = 200,
  ): Promise<ShareFile[]> {
    const plain = JSON.stringify({
      getOutLinkInfoReq: {
        account: '', // 列表端点 account 必须为空串，且本调用不带鉴权头
        linkID: linkId,
        passwd,
        caSrt: 1, // 目录排序：按创建时间
        coSrt: 1, // 文件排序：按创建时间
        srtDr: 0, // 排序方向：降序
        bNum: begin,
        pCaID: pcaId,
        eNum: end,
      },
    });
    const json = await this.sharePost(C139Constants.SHARE_LIST_URL, plain);
    this.checkShare(json, '获取文件列表失败');
    const data = json?.data;
    if (!data) return [];

    const result: ShareFile[] = [];

    // 1) 子文件夹列表 caLst（缺失它 → 含子文件夹的分享显示为空）
    const caLst = data.caLst;
    if (Array.isArray(caLst)) {
      for (const item of caLst) {
        if (!item || typeof item !== 'object') continue;
        result.push({
          fid: C139Api.optString(item, 'caID'),
          fname: C139Api.optString(item, 'caName'),
          fsize: 0,
          isdir: true,
          pdirFid: pcaId,
          fidToken: '',
          modifyTime: C139Api.optString(item, 'udTime') || C139Api.optString(item, 'ctTime'),
        });
      }
    }

    // 2) 文件列表 coLst（含 coType==2 的文件夹）
    const coLst = data.coLst;
    if (Array.isArray(coLst)) {
      for (const item of coLst) {
        if (!item || typeof item !== 'object') continue;
        // isdir = optBoolean("isdir", optInt("coType", 1) == 2)
        const isdir =
          typeof item.isdir === 'boolean'
            ? item.isdir
            : Number(item.coType ?? 1) === 2;
        result.push({
          fid: C139Api.optString(item, 'coID'),
          fname: C139Api.optString(item, 'coName'),
          fsize: Number(item.coSize ?? 0),
          isdir,
          pdirFid: pcaId,
          fidToken: '',
          modifyTime: C139Api.optString(item, 'udTime') || C139Api.optString(item, 'ctTime'),
        });
      }
    }

    // 空目录返回空列表，UI 显示「此目录为空」（保持原语义）
    return result;
  }

  /**
   * 分享下载：dlFromOutLinkV3 → data.redrUrl（OBS S3 签名直链，900s 有效）。
   * 这是唯一计算 mcloud-sign 的分享调用（按明文 body 算）。
   * @param coId 列目录得到的 coID
   * @param account 完整手机号（从 Cookie 提取）
   * @param authorization 可选，Cookie 里有才带
   */
  async getShareLink(
    coId: string,
    linkId: string,
    account: string,
    authorization: string | null,
  ): Promise<DownloadLink> {
    const plain = JSON.stringify({
      dlFromOutLinkReqV3: {
        account,
        linkID: linkId,
        coIDLst: { item: [coId] },
        commonAccountInfo: { account, accountType: 1 },
      },
    });
    const json = await this.sharePost(C139Constants.SHARE_LINK_URL, plain, {
      authorization,
      withSign: true,
    });
    this.checkShare(json, '获取下载链接失败');
    const data = json?.data;
    if (!data) throw new PlatformError('获取下载链接失败：未返回数据');
    const url = C139Api.optString(data, 'redrUrl');
    if (!url.trim()) throw new PlatformError('获取下载链接失败：未返回直链');

    const fileName = C139Api.optString(data, 'fileName');
    const coName = C139Api.optString(data, 'coName');
    const size = data.coSize ?? data.size ?? 0;
    return {
      fid: coId,
      filename: fileName || coName || coId,
      downloadUrl: url,
      size: Number(size ?? 0),
      // OBS 预签名直链，仅需 PC UA（无 Cookie、无 Referer）
      headers: { 'User-Agent': C139Constants.PC_UA },
    };
  }

  /** 安全取字符串：对齐 org.json optString（缺失/null → ""，不是 "null"） */
  private static optString(obj: any, key: string): string {
    const v = obj?.[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : String(v);
  }
}

/** 139 网盘（和彩云）适配器：匿名列目录（AES）→ 账号 + mcloud-sign 取直链（无转存、无清理） */
export const c139Adapter: PlatformAdapter = {
  platform: 'C139',
  label: '139 网盘',
  /** 取下载直链需要账号信息（body 内嵌完整手机号），但分享列表可匿名浏览 */
  requiresAuth: true,
  canListAnonymous: true,

  isLoggedIn(credential) {
    return isValidCookie(credential);
  },

  async createSession(link, pwd, credential, ctx): Promise<ShareSession> {
    const api = new C139Api(ctx);
    actions: {
      // 取直链时 body 需要完整手机号（账号），没账号直接拒绝，避免走到下载才失败
      if (!extractAccountFull(credential)) {
        throw new PlatformError('登录态缺少账号信息，请重新登录');
      }
      break actions;
    }
    // 139 分享无 token：shareId 即 linkID，stoken 暂存提取码
    // 密码优先级：用户手输 > 139 getOutLinkGeneral 明文回吐的 passwd（避免下载因缺密码报 9188）
    const general = await api.getOutLinkGeneral(link);
    const passwd = pwd?.trim() ? pwd.trim() : (general.passwd ?? '');
    const title = general.title && general.title.trim() ? general.title : link;
    return { shareId: link, stoken: passwd, title };
  },

  async listFiles(session, dirFid, _credential, ctx): Promise<ShareFile[]> {
    const api = new C139Api(ctx);
    // 列表端点为匿名调用：无需 authorization / account，Api 内部走匿名请求
    // pCaID 根目录必须传 "root"（空串会报 pCaID不能为空），子目录传父 caID / coID
    const pcaId =
      dirFid === '0' || !dirFid.trim() ? C139Constants.ROOT_PCAID : dirFid;
    // 偏移分页：bNum 从 1 开始、步长 200、eNum = bNum + 199；整批恰好 200 条才继续
    const all: ShareFile[] = [];
    let begin = 1;
    for (;;) {
      const batch = await api.getShareFiles(
        session.shareId,
        pcaId,
        session.stoken,
        begin,
        begin + C139Constants.PAGE_SIZE - 1,
      );
      all.push(...batch);
      begin += C139Constants.PAGE_SIZE;
      if (batch.length !== C139Constants.PAGE_SIZE) break;
      if (begin > C139Constants.MAX_BEGIN) break;
    }
    return all;
  },

  async getShareDownloadLink(session, file, credential, ctx): Promise<DownloadLink> {
    const api = new C139Api(ctx);
    const account = extractAccountFull(credential);
    if (!account) throw new PlatformError('登录态缺少账号信息，请重新登录');
    // authorization 可选：Cookie 里没有也能取链（body 内嵌 account）
    const authorization = extractAuthorization(credential);
    const link = await api.getShareLink(file.fid, session.shareId, account, authorization);
    // 文件名用列表里的 coName（dlFromOutLinkV3 响应不含文件名，否则会 fallback 成 coID 乱码）
    link.filename = file.fname.trim() ? file.fname : link.filename;
    return link;
  },
};

export { C139Api };
