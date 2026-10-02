/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 UCApi.kt + UCResolveRepository.kt。
 * 完全使用 Node 内置 fetch（undici），不需要额外 HTTP 依赖。
 */

import type { DownloadLink, QuotaInfo, ShareFile, ShareSession } from '../../../shared/types';
import { UCConstants, UCCookieUtil } from './constants';
import type { PlatformAdapter, ResolveContext } from '../types';
import { PlatformError } from '../types';

/** 带响应 Cookie 回写能力的请求结果 */
interface JsonResult {
  json: any;
  setCookies: string[];
}

/**
 * UC 转码播放流结果（对应 Kotlin model 的 PlayLink；shared/types.ts 未定义，故本地声明）。
 * isHls 为真时 DownloadLink 需带 isHls 标记，交给下载层按 HLS 分片处理。
 */
interface PlayLink {
  url: string;
  resolution: string;
  format: string;
  isHls: boolean;
}

/** 常见视频扩展名（分享视频走 play 转码流绕过会员墙；play 需个人云盘 fid，先转存临时目录） */
const UC_VIDEO_EXTS = new Set([
  'mp4',
  'mkv',
  'mov',
  'avi',
  'webm',
  'flv',
  'ts',
  'm3u8',
  'wmv',
  'rmvb',
]);

/** 与 UCResolveRepository.isVideo 一致：取最后一个 '.' 之后的小写扩展名 */
function isVideo(name: string): boolean {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return UC_VIDEO_EXTS.has(ext);
}

/** Kotlin 的 runCatching { ... }.getOrNull()：忽略异常返回 null（"尽力而为"的探测调用） */
async function runCatchingNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export class UCApi {
  constructor(private ctx: ResolveContext) {}

  /**
   * 发起请求并回写 __puus/__pus。
   * 对齐 Kotlin 版 mergeCookieFromResponse：响应若下发新 cookie，立即回调保存。
   */
  private async request(
    url: string,
    cookie: string,
    init: { method?: string; body?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<JsonResult> {
    const headers: Record<string, string> = {
      Cookie: cookie,
      'User-Agent': UCConstants.USER_AGENT,
      ...(init.extraHeaders ?? {}),
    };
    if (init.body !== undefined && !headers['Content-Type']) {
      // Kotlin postJson：Content-Type: application/json
      headers['Content-Type'] = 'application/json';
    }

    const res = await this.ctx.http(url, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body,
    });

    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      const merged = UCCookieUtil.mergeFromSetCookies(cookie, setCookies);
      if (merged !== cookie) this.ctx.saveCookie?.(merged);
    }

    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // Kotlin：runCatching { JSONObject(body) }.getOrElse { throw QuarkApiException("响应解析失败") }
      throw new PlatformError('响应解析失败', res.status);
    }
    return { json, setCookies };
  }

  /** 对齐 Kotlin parseData：status != 200 透传服务端 message，data 缺失则报错 */
  private parseData<T>(json: any, parser: (data: any) => T): T {
    if (Number(json?.status) !== 200) {
      const msg = String(json?.message ?? '').trim();
      throw new PlatformError(msg || '请求失败');
    }
    if (!json?.data) throw new PlatformError('响应缺少 data');
    return parser(json.data);
  }

  // ---------- 账号 ----------

  /** 获取昵称（success=true 时取 data.nickname；失败一律 null，不抛错） */
  async fetchNickname(cookie: string): Promise<string | null> {
    try {
      const { json } = await this.request(UCConstants.ACCOUNT_INFO_URL, cookie);
      if (json?.success === true) {
        const nick = json?.data?.nickname;
        return typeof nick === 'string' && nick.trim() ? nick : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ---------- 分享解析 ----------

  /** 获取分享 Token（官方抓包：body 为 pwd_id/passcode/share_for_transfer） */
  async getShareToken(shareId: string, pwd: string | null, cookie: string) {
    const body = JSON.stringify({
      pwd_id: shareId,
      passcode: pwd ?? '',
      share_for_transfer: true,
    });
    const { json } = await this.request(UCConstants.SHARE_TOKEN_URL, cookie, { body });
    return this.parseData(json, (data) => ({
      stoken: String(data?.stoken ?? ''),
      title: String(data?.title ?? ''),
      firstFid: String(data?.first_fid ?? ''),
    }));
  }

  /**
   * 获取转存分享文件列表（transfer_share/detail，官方下载流程）。
   * GET + query 携带 stoken → 返回的 share_fid_token 与 stoken 绑定，download 才能通过校验。
   */
  async getTransferShareFiles(
    shareId: string,
    stoken: string,
    pdirFid: string,
    cookie: string,
    page = 1,
    size = 50,
  ): Promise<ShareFile[]> {
    const url =
      `${UCConstants.TRANSFER_SHARE_DETAIL_URL}` +
      `&pwd_id=${shareId}` +
      `&pdir_fid=${pdirFid}` +
      `&fetch_file_list=1` +
      `&passcode=` +
      `&_page=${page}` +
      `&_size=${size}` +
      `&_fetch_total=1` +
      `&_fetch_task=1` +
      `&_fetch_share=1` +
      `&_sort=` +
      `&stoken=${encodeURIComponent(stoken)}`;
    const { json } = await this.request(url, cookie, {
      extraHeaders: {
        Origin: 'https://fast.uc.cn',
        Referer: 'https://fast.uc.cn/',
      },
    });
    return this.parseData(json, (data) => {
      // 兼容 data.list 或 data.detail_info.list 两种结构
      const arr: any[] = Array.isArray(data?.list)
        ? data.list
        : Array.isArray(data?.detail_info?.list)
          ? data.detail_info.list
          : [];
      return arr.map(
        (item): ShareFile => ({
          fid: String(item?.fid ?? ''),
          fname: String(item?.file_name ?? ''),
          fsize: Number(item?.size ?? 0),
          isdir: Boolean(item?.dir),
          pdirFid: String(item?.pdir_fid ?? ''),
          fidToken: String(item?.share_fid_token ?? ''),
          modifyTime: String(item?.updated_at ?? ''),
        }),
      );
    });
  }

  /**
   * 获取分享文件列表（sharepage/v2/detail，UC 官方为 POST + JSON body）。
   * 官方抓包：body 携带 pwd_id/passcode/page/size/fetch_banner 等，不携带 stoken；
   * 进入子目录时 body 追加 pdir_fid。
   */
  async getShareFiles(
    shareId: string,
    pwd: string | null,
    pdirFid: string,
    cookie: string,
    page = 1,
    size = 50,
  ): Promise<ShareFile[]> {
    const payload: Record<string, any> = {
      pwd_id: shareId,
      passcode: pwd ?? '',
      force: 0,
      page,
      size,
      fetch_banner: 1,
      fetch_share: 1,
      fetch_total: 1,
      sort: 'file_type:asc,file_name:asc',
      banner_platform: 'other',
      web_platform: 'windows',
      fetch_error_background: 1,
    };
    // 子目录时追加 pdir_fid（根目录官方不传）
    if (pdirFid && pdirFid !== UCConstants.DEFAULT_PDIR_FID) payload.pdir_fid = pdirFid;

    const { json } = await this.request(
      `${UCConstants.SHARE_DETAIL_URL}&ve=2.5.20`,
      cookie,
      {
        body: JSON.stringify(payload),
        extraHeaders: {
          Origin: 'https://drive.uc.cn',
          Referer: 'https://drive.uc.cn/',
          'Content-Type': 'application/json;charset=UTF-8',
        },
      },
    );
    return this.parseData(json, (data) => {
      // UC v2/detail：文件列表在 data.detail_info.list（不是 data.list）
      const arr: any[] = Array.isArray(data?.detail_info?.list) ? data.detail_info.list : [];
      return arr.map(
        (item): ShareFile => ({
          fid: String(item?.fid ?? ''),
          fname: String(item?.file_name ?? ''),
          fsize: Number(item?.size ?? 0),
          isdir: Boolean(item?.dir),
          pdirFid: String(item?.pdir_fid ?? ''),
          fidToken: String(item?.share_fid_token ?? ''),
          modifyTime: String(item?.updated_at ?? ''),
        }),
      );
    });
  }

  // ---------- 个人网盘 / 转存 ----------

  /** 个人网盘文件列表（用于查找/确认临时目录） */
  async getFileList(pdirFid: string, cookie: string, page = 1, size = 100): Promise<ShareFile[]> {
    const url = `${UCConstants.FILE_URL}&pdir_fid=${pdirFid}&page=${page}&size=${size}`;
    const { json } = await this.request(url, cookie);
    return this.parseData(json, (data) => {
      const arr: any[] = Array.isArray(data?.list) ? data.list : [];
      return arr.map(
        (item): ShareFile => ({
          fid: String(item?.fid ?? ''),
          fname: String(item?.file_name || item?.fname || ''),
          // Kotlin: if (item.has("size")) item.optLong("size") else item.optLong("fsize")
          fsize: Number(item?.size !== undefined ? item.size : (item?.fsize ?? 0)),
          isdir: Boolean(item?.dir) || Number(item?.isdir) === 1,
          pdirFid: String(item?.pdir_fid ?? ''),
          fidToken: String(item?.fid_token ?? ''),
          modifyTime: String(item?.modify_time ?? ''),
        }),
      );
    });
  }

  /** 创建目录，返回新目录 fid */
  async createFolder(name: string, parentFid: string, cookie: string): Promise<string> {
    const body = JSON.stringify({
      pdir_fid: parentFid,
      file_name: name,
      dir_path: '',
      dir_init_lock: false,
    });
    const { json } = await this.request(UCConstants.FILE_URL, cookie, { body });
    return this.parseData(json, (data) => String(data?.fid ?? ''));
  }

  /** 转存分享文件到指定目录，返回异步任务 id */
  async saveShareFile(
    shareId: string,
    stoken: string,
    pdirFid: string,
    fid: string,
    fidToken: string,
    toPdirFid: string,
    cookie: string,
  ): Promise<string | null> {
    const body = JSON.stringify({
      pwd_id: shareId,
      stoken,
      pdir_fid: pdirFid,
      to_pdir_fid: toPdirFid,
      fid_list: [fid],
      fid_token_list: [fidToken],
      scene: 'link',
    });
    const { json } = await this.request(UCConstants.SAVE_URL, cookie, { body });
    return this.parseData(json, (data) => {
      const t = String(data?.task_id ?? '');
      return t || null;
    });
  }

  /** 轮询异步转存任务（Kotlin：最多 10 次 × 1s），返回转存后的新 fid */
  async pollTask(taskId: string, cookie: string, attempts = 10, intervalMs = 1000): Promise<string | null> {
    const url = `${UCConstants.TASK_URL}&task_id=${encodeURIComponent(taskId)}&retry_index=0`;
    for (let i = 0; i < attempts; i++) {
      // Kotlin 用 runCatching { ... }.getOrNull()：单次失败忽略，继续重试
      const savedFid = await runCatchingNull(async () => {
        const { json } = await this.request(url, cookie);
        if (Number(json?.status) !== 200) return null;
        const data = json?.data;
        if (!data) return null;
        const finished =
          Number(data.finished_at ?? 0) > 0 ||
          Number(data.status ?? 0) === 2 ||
          Number(data.task_status ?? 0) === 2;
        if (!finished) return null;
        const fid = data?.save_as?.save_as_top_fids?.[0];
        return typeof fid === 'string' && fid ? fid : null;
      });
      if (savedFid) return savedFid;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  // ---------- 下载直链 ----------

  /**
   * 刷新会话 Cookie（对应 AList refreshPuus，修复与夸克同源的 #830 类缺陷）：
   * 剥离 __puus 后请求任意接口（/config），服务端会在 Set-Cookie 中重新下发 __puus/__pus。
   * @return 合并了最新 __puus/__pus 的 Cookie；失败返回 null（调用方应回退原 Cookie）。
   */
  async refreshSession(cookie: string): Promise<string | null> {
    return runCatchingNull(async () => {
      const res = await this.ctx.http(UCConstants.CONFIG_URL, {
        headers: {
          Cookie: UCCookieUtil.withoutPuus(cookie),
          'User-Agent': UCConstants.USER_AGENT,
          Referer: UCConstants.DOWNLOAD_REFERER,
        },
      });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      const merged = UCCookieUtil.mergeFromSetCookies(cookie, setCookies);
      if (merged !== cookie) this.ctx.saveCookie?.(merged);
      return merged;
    });
  }

  /**
   * UC 官方下载流程（抓包）：不需要先转存！
   * POST file/download?entry=ft&fr=pc&pr=UCBrowser
   * body: {"fids":[分享fid],"pwd_id":短码,"stoken":token接口返回,"fids_token":[分享fid_token]}
   */
  async getShareDownloadLink(
    fid: string,
    fidToken: string,
    stoken: string,
    pwdId: string,
    cookie: string,
  ): Promise<DownloadLink> {
    const body = JSON.stringify({
      fids: [fid],
      pwd_id: pwdId,
      stoken,
      fids_token: [fidToken],
    });
    const { json } = await this.request(UCConstants.DOWNLOAD_URL, cookie, { body });
    // Kotlin 此处只判 status != 200（与 getDownloadLink 的 && 判断略有差异，逐字对齐）
    if (Number(json?.status) !== 200) {
      throw new PlatformError(String(json?.message ?? '').trim() || '获取下载链接失败');
    }
    const item = Array.isArray(json?.data) ? json.data[0] : null;
    if (!item) throw new PlatformError('未返回下载链接');
    return {
      fid: String(item?.fid ?? ''),
      filename: String(item?.file_name || item?.filename || ''),
      downloadUrl: String(item?.download_url ?? ''),
      size: Number(item?.size ?? 0),
    };
  }

  /** 个人云盘文件取直链（转存后的新 fid 走这条；对齐 Kotlin getDownloadLink） */
  async getDownloadLink(fid: string, cookie: string): Promise<DownloadLink> {
    const body = JSON.stringify({ fids: [fid] });
    const { json } = await this.request(UCConstants.DOWNLOAD_URL, cookie, { body });

    const status = Number(json?.status ?? 0);
    const code = Number(json?.code ?? 0);
    if (status !== 200 && code !== 0) {
      throw new PlatformError(String(json?.message ?? '').trim() || '获取下载链接失败', code || undefined);
    }
    const arr = json?.data;
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new PlatformError('未返回下载链接');
    }
    const item = arr[0];
    return {
      fid: String(item?.fid ?? fid),
      filename: String(item?.file_name || item?.filename || ''),
      downloadUrl: String(item?.download_url ?? ''),
      size: Number(item?.size ?? 0),
    };
  }

  /**
   * 分享视频预览（原画直链，绕过非会员视频下载被换成宣传片的问题）。
   * GET share/sharepage/video_preview?pwd_id/stoken/fid/fid_token →
   * data.play_info.url（原画 OSS 直链，走播放回调 checkplay 不换片）+ size（原画大小，可校验）。
   * 仅对分享态视频有意义；链接约 3 小时有效（x-ttl=10800）。
   */
  async getVideoPreview(
    pwdId: string,
    stoken: string,
    fid: string,
    fidToken: string,
    cookie: string,
  ): Promise<DownloadLink | null> {
    const url =
      `${UCConstants.VIDEO_PREVIEW_URL}` +
      `?pr=UCBrowser&fr=h5` +
      `&pwd_id=${encodeURIComponent(pwdId)}` +
      `&stoken=${encodeURIComponent(stoken)}` +
      `&fid=${encodeURIComponent(fid)}` +
      `&fid_token=${encodeURIComponent(fidToken)}`;
    return runCatchingNull(async () => {
      const { json } = await this.request(url, cookie, {
        extraHeaders: {
          Origin: UCConstants.WEB_ORIGIN,
          Referer: UCConstants.DOWNLOAD_REFERER,
          'Content-Type': 'application/json',
        },
      });
      if (Number(json?.status) !== 200 && Number(json?.code) !== 0) return null;
      const data = json?.data;
      if (!data) return null;
      const playInfo = data?.play_info;
      if (!playInfo) return null;
      const directUrl = String(playInfo?.url ?? '');
      if (!directUrl) return null;
      return {
        fid,
        filename: '',
        downloadUrl: directUrl,
        size: Number(playInfo?.size ?? 0),
      } as DownloadLink;
    });
  }

  /**
   * UC 转码播放流（绕过非会员视频下载被换成宣传片的问题）。
   * POST file/v2/play/project → data.video_list[].video_info.url（m3u8/fmp4）。
   * 仅对视频有意义；返回首个非空播放地址 + 其清晰度。
   * 先试带 pr/fr 的主路径；失败则用裸路径重试（Alist getTranscodingLink 方式，对 UC 也可通）。
   */
  async getPlayLink(fid: string, cookie: string): Promise<PlayLink | null> {
    return (
      (await this.playProject(UCConstants.PLAY_URL, fid, cookie)) ??
      (await this.playProject(`${UCConstants.API_BASE}/1/clouddrive/file/v2/play/project`, fid, cookie))
    );
  }

  private async playProject(url: string, fid: string, cookie: string): Promise<PlayLink | null> {
    const body = JSON.stringify({
      fid,
      resolutions: 'low,normal,high,super,2k,4k',
      supports: 'fmp4_av,m3u8,dolby_vision',
    });
    return runCatchingNull(async () => {
      const { json } = await this.request(url, cookie, {
        body,
        extraHeaders: {
          'Content-Type': 'application/json;charset=UTF-8',
          Origin: UCConstants.WEB_ORIGIN,
          Referer: UCConstants.DOWNLOAD_REFERER,
        },
      });
      if (Number(json?.status) !== 200 && Number(json?.code) !== 0) return null;
      const list: any[] = Array.isArray(json?.data?.video_list) ? json.data.video_list : [];
      for (const entry of list) {
        const info = entry?.video_info;
        if (!info) continue;
        const u = String(info?.url ?? '');
        if (!u) continue;
        const format = String(info?.format ?? '');
        return {
          url: u,
          resolution: String(info?.resolution ?? ''),
          format,
          isHls: u.includes('.m3u8') || format.toLowerCase().includes('m3u8'),
        } as PlayLink;
      }
      return null;
    });
  }

  /** 删除文件（抓包：action_type=2 + filelist + exclude_fids）；返回 task_id */
  async deleteFile(fid: string, cookie: string): Promise<string | null> {
    const body = JSON.stringify({ action_type: 2, filelist: [fid], exclude_fids: [] });
    const { json } = await this.request(UCConstants.DELETE_URL, cookie, { body });
    return this.parseData(json, (data) => {
      const t = String(data?.task_id ?? '');
      return t || null;
    });
  }

  /** 云盘文件列表（抓包 /1/clouddrive/file/sort，pdir_fid=0 根目录）
   *  自动翻页：单页满 size 继续，封顶 100 页防异常死循环；默认单页 100（接口支持）。
   */
  async listCloudFiles(pdirFid: string, cookie: string, page = 1, size = 100): Promise<ShareFile[]> {
    const all: ShareFile[] = [];
    let p = page;
    while (true) {
      const url =
        `${UCConstants.CLOUD_FILE_SORT_URL}` +
        `&pdir_fid=${pdirFid}` +
        `&_page=${p}` +
        `&_size=${size}` +
        `&_fetch_total=1` +
        `&_fetch_sub_dirs=0` +
        `&_sort=file_type%3Aasc%2Cupdated_at%3Adesc`;
      const { json } = await this.request(url, cookie, {
        extraHeaders: {
          Origin: 'https://drive.uc.cn',
          Referer: 'https://drive.uc.cn/',
        },
      });
      const files = this.parseData(json, (data) => {
        const arr: any[] = Array.isArray(data?.list) ? data.list : [];
        return arr.map(
          (item): ShareFile => ({
            fid: String(item?.fid ?? ''),
            fname: String(item?.file_name || item?.fname || ''),
            fsize: Number(item?.size ?? 0),
            isdir: Boolean(item?.dir),
            pdirFid: String(item?.pdir_fid ?? ''),
            fidToken: '',
            modifyTime: String(item?.updated_at ?? ''),
          }),
        );
      });
      all.push(...files);
      // 本页未满 size → 已是最后一页；封顶 100 页防止异常死循环
      if (files.length < size || p >= 100) break;
      p++;
    }
    return all;
  }

  /** 网盘空间详情（/1/clouddrive/member：total_capacity / use_capacity，CLOUD_UA） */
  async getQuota(cookie: string): Promise<QuotaInfo | null> {
    return runCatchingNull(async () => {
      const { json } = await this.request(UCConstants.MEMBER_URL, cookie, {
        extraHeaders: {
          'User-Agent': UCConstants.CLOUD_UA,
          Origin: 'https://drive.uc.cn',
          Referer: 'https://drive.uc.cn/',
        },
      });
      const data = json?.data;
      if (!data) return null;
      return {
        used: Number(data.use_capacity ?? 0),
        total: Number(data.total_capacity ?? 0),
      } as QuotaInfo;
    });
  }
}

/** UC 网盘适配器：token → 列表（transfer_share/detail） → 直链（视频优先原画/转码流） */
export const ucAdapter: PlatformAdapter = {
  platform: 'UC',
  label: 'UC 网盘',
  /** UC 分享解析与转存必须登录（Cookie 需含 __pus / __puus） */
  requiresAuth: true,
  /** UCResolveRepository 全程携带 Cookie，列表接口不匿名开放 */
  canListAnonymous: false,

  isLoggedIn(credential) {
    return UCConstants.isValidCookie(credential);
  },

  async createSession(link, pwd, credential, ctx): Promise<ShareSession> {
    const api = new UCApi(ctx);
    // 链接解析已在 resolve 层完成，这里直接用 shareId
    const token = await api.getShareToken(link, pwd ?? null, credential);
    if (!token.stoken) throw new PlatformError('未获取到分享凭证（可能提取码错误或分享已失效）');
    return { shareId: link, stoken: token.stoken, title: token.title };
  },

  async listFiles(session, dirFid, credential, ctx): Promise<ShareFile[]> {
    const api = new UCApi(ctx);
    // 必须用 transfer_share/detail（带 stoken），返回的 share_fid_token 与 stoken 绑定
    const all: ShareFile[] = [];
    let page = 1;
    let batch: ShareFile[];
    do {
      batch = await api.getTransferShareFiles(
        session.shareId,
        session.stoken,
        dirFid,
        credential,
        page,
        50,
      );
      all.push(...batch);
      page++;
    } while (batch.length === 50 && page <= 100);
    return all;
  },

  /**
   * UC 取分享文件直链（对齐 UCResolveRepository.getShareDownloadLink）：
   * 1) 官方分享通道无需转存：直接用分享 fid + fid_token + stoken + pwd_id 调 download?entry=ft；
   * 2) 视频优先走分享态 video_preview 取**原画**直链（走播放回调 checkplay，不换片，
   *    绕过非会员视频下载被替换成宣传片）；
   * 3) video_preview 不可用时（非会员/接口失败）回退转码播放流 play/project：
   *    先转存到「YunX临时转存」下的唯一子目录拿个人云盘 fid → play 取 m3u8/fmp4 →
   *    按 isHls 标记返回；该路径产生临时转存，cleanupDirFid 交给下载完成后清理。
   */
  async getShareDownloadLink(session, file, credential, ctx): Promise<DownloadLink> {
    const api = new UCApi(ctx);

    const withHeaders = (link: DownloadLink): DownloadLink => ({
      ...link,
      // UC：OSS 直链按 Referer 档位限速（缺 Referer 被 Callback 限到 ~100 KB/s），
      // 补官方 Web 客户端同款 Referer/Origin + Cookie/UA 即满速（对齐 ResolveViewModel.enqueueDownload）。
      headers: {
        Cookie: credential,
        'User-Agent': UCConstants.USER_AGENT,
        Referer: UCConstants.DOWNLOAD_REFERER,
        Origin: UCConstants.WEB_ORIGIN,
      },
    });

    // 视频：优先用分享态 video_preview 取原画直链
    if (isVideo(file.fname)) {
      const preview = await api.getVideoPreview(
        session.shareId,
        session.stoken,
        file.fid,
        file.fidToken,
        credential,
      );
      if (preview) {
        return withHeaders({
          fid: file.fid,
          filename: file.fname,
          downloadUrl: preview.downloadUrl,
          size: preview.size,
          isHls: false,
        });
      }
    }

    // 官方分享通道直链
    const direct = await api.getShareDownloadLink(
      file.fid,
      file.fidToken,
      session.stoken,
      session.shareId,
      credential,
    );
    if (direct.downloadUrl) return withHeaders(direct);

    // 回退：转码播放流（需先转存到个人云盘，play 只认个人云盘 fid）
    if (isVideo(file.fname)) {
      const baseDirFiles = await api.getFileList(UCConstants.DEFAULT_PDIR_FID, credential);
      let baseDir = baseDirFiles.find(
        (f) => f.isdir && f.fname === UCConstants.TEMP_DIR_NAME,
      )?.fid;
      if (!baseDir) {
        baseDir = await api.createFolder(
          UCConstants.TEMP_DIR_NAME,
          UCConstants.DEFAULT_PDIR_FID,
          credential,
        );
        if (!baseDir) throw new PlatformError('创建临时目录失败');
      }

      // 唯一临时子目录：避免多次转存命中同一目录导致的重名/去重问题
      const subDirName = `tr_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
      const subDirFid = await api.createFolder(subDirName, baseDir, credential);
      if (!subDirFid) throw new PlatformError('创建临时转存目录失败');

      const taskId = await api.saveShareFile(
        session.shareId,
        session.stoken,
        file.pdirFid,
        file.fid,
        file.fidToken,
        subDirFid,
        credential,
      );
      if (!taskId) throw new PlatformError('转存失败');

      const savedFid = await api.pollTask(taskId, credential);
      if (!savedFid) throw new PlatformError('转存超时，请稍后重试');

      // play 主路径失败时用裸路径重试（Alist getTranscodingLink 方式）
      const play = await api.getPlayLink(savedFid, credential);
      if (play) {
        return withHeaders({
          fid: file.fid,
          filename: file.fname,
          downloadUrl: play.url,
          size: file.fsize,
          // m3u8/fmp4 转码流：通知下载层按 HLS 处理
          isHls: play.isHls,
          // 不在此删除！下载完成后再删整个子目录
          cleanupDirFid: subDirFid,
        });
      }

      // play 也拿不到 → 清掉刚建的临时目录，避免云端残留，再回落个人云盘直链
      await runCatchingNull(() => api.deleteFile(subDirFid, credential));

      const cloud = await api.getDownloadLink(savedFid, credential);
      if (cloud.downloadUrl) {
        return withHeaders({ ...cloud, cleanupDirFid: subDirFid });
      }
    }

    throw new PlatformError('未返回下载链接');
  },

  async cleanupTempDir(dirFid, credential, ctx): Promise<void> {
    try {
      const api = new UCApi(ctx);
      // 删除临时子目录（连同其中的转存文件）；失败不阻断主流程
      await api.deleteFile(dirFid, credential);
    } catch {
      /* 清理失败不阻断主流程 */
    }
  },

  async getQuota(credential, ctx): Promise<QuotaInfo | null> {
    return new UCApi(ctx).getQuota(credential);
  },

  async fetchNickname(credential, ctx): Promise<string | null> {
    return new UCApi(ctx).fetchNickname(credential);
  },
};

export { UCCookieUtil };
export const ucCookieUtil = UCCookieUtil;
export { isVideo as ucIsVideo };
