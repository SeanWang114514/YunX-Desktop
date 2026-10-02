/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 QuarkApi.kt + QuarkResolveRepository.kt。
 * 完全使用 Node 内置 fetch（undici），不需要额外 HTTP 依赖。
 */

import type { DownloadLink, QuotaInfo, ShareFile, ShareSession } from '../../../shared/types';
import { QuarkConstants, QuarkCookieUtil } from './constants';
import type { PlatformAdapter, ResolveContext } from '../types';
import { PlatformError } from '../types';
import { withCookies } from '../../net/cookieJar';
import { sleep } from '../../util/async';

/** 带响应 Cookie 回写能力的请求结果 */
interface JsonResult {
  json: any;
  setCookies: string[];
}

class QuarkApi {
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
      'User-Agent': QuarkConstants.API_USER_AGENT,
      ...(init.extraHeaders ?? {}),
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await this.ctx.http(url, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: init.body,
    });

    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      const merged = QuarkCookieUtil.mergeFromSetCookies(cookie, setCookies);
      if (merged !== cookie) this.ctx.saveCookie?.(merged);
    }

    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new PlatformError('响应解析失败', res.status);
    }
    return { json, setCookies };
  }

  /** 解析 data 字段；status != 200 时透传服务端 message */
  private parseData<T>(json: any, parser: (data: any) => T): T {
    if (json?.status !== 200) {
      const code = typeof json?.code === 'number' ? json.code : undefined;
      // 失败响应可能没有 status，用 code===0 兜底判定成功
      if (!(code === 0 && json?.data)) {
        throw new PlatformError(json?.message || '请求失败', code);
      }
    }
    if (!json?.data) throw new PlatformError('响应缺少 data');
    return parser(json.data);
  }

  async fetchNickname(cookie: string): Promise<string | null> {
    try {
      const { json } = await this.request(QuarkConstants.ACCOUNT_INFO_URL, cookie);
      if (json?.success === true) {
        const nick = json?.data?.nickname;
        return typeof nick === 'string' && nick.trim() ? nick : null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 4.1 获取分享 Token */
  async getShareToken(shareId: string, pwd: string | null, cookie: string) {
    const body = JSON.stringify({
      pwd_id: shareId,
      passcode: pwd ?? '',
      support_visit_limit_private_share: true,
    });
    const { json } = await this.request(QuarkConstants.SHARE_TOKEN_URL, cookie, { body });
    return this.parseData(json, (data) => ({
      stoken: String(data.stoken ?? ''),
      title: String(data.title ?? ''),
      firstFid: String(data.first_fid ?? ''),
    }));
  }

  /** 4.2 获取分享文件列表（sharepage/detail） */
  async getShareFiles(
    shareId: string,
    stoken: string,
    pdirFid: string,
    cookie: string,
    page = 1,
    size = 100,
  ): Promise<ShareFile[]> {
    const url =
      `${QuarkConstants.SHARE_DETAIL_URL}` +
      `&pwd_id=${encodeURIComponent(shareId)}` +
      `&stoken=${encodeURIComponent(stoken)}` +
      `&pdir_fid=${encodeURIComponent(pdirFid)}` +
      `&ver=2&force=0` +
      `&_page=${page}&_size=${size}` +
      `&_fetch_banner=0&_fetch_share=0&fetch_relate_conversation=0&_fetch_total=1` +
      `&_sort=file_type:asc,file_name:asc`;

    const { json } = await this.request(url, cookie, {
      extraHeaders: {
        Origin: QuarkConstants.ORIGIN,
        Referer: QuarkConstants.DOWNLOAD_REFERER,
      },
    });
    return this.parseData(json, (data) => {
      const arr: any[] = Array.isArray(data?.list) ? data.list : [];
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

  /** 个人网盘文件列表（用于查找/确认临时目录） */
  async getFileList(pdirFid: string, cookie: string, page = 1, size = 100): Promise<ShareFile[]> {
    const url = `${QuarkConstants.FILE_URL}&pdir_fid=${pdirFid}&page=${page}&size=${size}`;
    const { json } = await this.request(url, cookie);
    return this.parseData(json, (data) => {
      const arr: any[] = Array.isArray(data?.list) ? data.list : [];
      return arr.map(
        (item): ShareFile => ({
          fid: String(item?.fid ?? ''),
          fname: String(item?.file_name || item?.fname || ''),
          fsize: Number(item?.size ?? item?.fsize ?? 0),
          isdir: Boolean(item?.dir) || Number(item?.isdir) === 1,
          pdirFid: String(item?.pdir_fid ?? ''),
          fidToken: String(item?.fid_token ?? ''),
          modifyTime: String(item?.modify_time ?? ''),
        }),
      );
    });
  }

  /** 个人网盘文件列表（排序接口，自动翻页） */
  async listCloudFiles(pdirFid: string, cookie: string, size = 100): Promise<ShareFile[]> {
    const all: ShareFile[] = [];
    let p = 1;
    // 封顶 100 页，防止异常死循环
    while (p <= 100) {
      const url =
        `${QuarkConstants.CLOUD_FILE_SORT_URL}&uc_param_str=` +
        `&pdir_fid=${pdirFid}&_page=${p}&_size=${size}` +
        `&_fetch_total=1&_fetch_sub_dirs=0` +
        `&_sort=file_type:asc,updated_at:desc` +
        `&fetch_all_file=1&fetch_risk_file_name=1`;
      const { json } = await this.request(url, cookie, {
        extraHeaders: { Origin: QuarkConstants.ORIGIN, Referer: QuarkConstants.DOWNLOAD_REFERER },
      });
      const page1 = this.parseData(json, (data) => {
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
      all.push(...page1);
      if (page1.length < size) break;
      p++;
    }
    return all;
  }

  /** 创建目录，返回新目录 fid */
  async createFolder(name: string, parentFid: string, cookie: string): Promise<string> {
    const body = JSON.stringify({
      pdir_fid: parentFid,
      file_name: name,
      dir_path: '',
      dir_init_lock: false,
    });
    const { json } = await this.request(QuarkConstants.FILE_URL, cookie, { body });
    return this.parseData(json, (data) => String(data?.fid ?? ''));
  }

  /** 5. 转存分享文件到指定目录，返回异步任务 id */
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
    const { json } = await this.request(QuarkConstants.SAVE_URL, cookie, { body });
    return this.parseData(json, (data) => {
      const t = String(data?.task_id ?? '');
      return t || null;
    });
  }

  /** 轮询异步转存任务，返回转存后的新 fid */
  async pollTask(taskId: string, cookie: string, attempts = 10, intervalMs = 1000): Promise<string | null> {
    const url = `${QuarkConstants.TASK_URL}&task_id=${encodeURIComponent(taskId)}&retry_index=0`;
    for (let i = 0; i < attempts; i++) {
      try {
        const { json } = await this.request(url, cookie);
        if (json?.status === 200 && json?.data) {
          const data = json.data;
          const finished =
            Number(data.finished_at ?? 0) > 0 ||
            Number(data.status ?? 0) === 2 ||
            Number(data.task_status ?? 0) === 2;
          if (finished) {
            const fid = data?.save_as?.save_as_top_fids?.[0];
            if (typeof fid === 'string' && fid) return fid;
          }
        }
      } catch {
        /* 轮询期间的单次失败忽略，继续重试 */
      }
      await sleep(intervalMs);
    }
    return null;
  }

  /** 6.1 获取下载直链 */
  async getDownloadLink(fid: string, cookie: string): Promise<DownloadLink> {
    const body = JSON.stringify({ fids: [fid] });
    const { json } = await this.request(QuarkConstants.DOWNLOAD_URL, cookie, { body });

    const status = Number(json?.status ?? 0);
    const code = Number(json?.code ?? 0);
    if (status !== 200 && code !== 0) {
      throw new PlatformError(json?.message || '获取下载链接失败', code || undefined);
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
      // 夸克下载直链有防盗链，必须带 Referer
      headers: {
        Referer: QuarkConstants.DOWNLOAD_REFERER,
        'User-Agent': QuarkConstants.USER_AGENT,
      },
    };
  }

  /** 6.2 删除文件（清理临时转存） */
  async deleteFile(fid: string, cookie: string): Promise<string | null> {
    const body = JSON.stringify({ action_type: 2, filelist: [fid], exclude_fids: [] });
    const { json } = await this.request(QuarkConstants.DELETE_URL, cookie, { body });
    return this.parseData(json, (data) => {
      const t = String(data?.task_id ?? '');
      return t || null;
    });
  }

  /** 刷新会话 Cookie（剥离 __puus 后请求 /config，服务端重新下发） */
  async refreshSession(cookie: string): Promise<string | null> {
    try {
      const res = await this.ctx.http(QuarkConstants.CONFIG_URL, {
        headers: {
          Cookie: QuarkCookieUtil.withoutPuus(cookie),
          'User-Agent': QuarkConstants.API_USER_AGENT,
          Referer: QuarkConstants.DOWNLOAD_REFERER,
        },
      });
      const setCookies = res.headers.getSetCookie?.() ?? [];
      const merged = QuarkCookieUtil.mergeFromSetCookies(cookie, setCookies);
      if (merged !== cookie) this.ctx.saveCookie?.(merged);
      return merged;
    } catch {
      return null;
    }
  }

  /** 网盘空间详情 */
  async getQuota(cookie: string): Promise<QuotaInfo | null> {
    try {
      const { json } = await this.request(QuarkConstants.MEMBER_URL, cookie);
      const data = json?.data;
      if (!data) return null;
      return {
        used: Number(data.use_capacity ?? 0),
        total: Number(data.total_capacity ?? 0),
      };
    } catch {
      return null;
    }
  }
}

/** 夸克适配器：token → 列表 → 转存临时目录 → 下载直链 */
export const quarkAdapter: PlatformAdapter = {
  platform: 'QUARK',
  label: '夸克网盘',
  /** 夸克分享解析与转存必须登录（Cookie 需含 __pus / __puus） */
  requiresAuth: true,

  isLoggedIn(credential) {
    return QuarkConstants.isValidCookie(credential);
  },

  async createSession(link, pwd, credential, ctx): Promise<ShareSession> {
    const api = new QuarkApi(ctx);
    // 链接解析已在 resolve 层完成，这里直接用 shareId
    const token = await api.getShareToken(link, pwd ?? null, credential);
    if (!token.stoken) throw new PlatformError('未获取到分享凭证（可能提取码错误或分享已失效）');
    return { shareId: link, stoken: token.stoken, title: token.title };
  },

  async listFiles(session, dirFid, credential, ctx): Promise<ShareFile[]> {
    const api = new QuarkApi(ctx);
    const all: ShareFile[] = [];
    let page = 1;
    while (page <= 100) {
      const batch = await api.getShareFiles(session.shareId, session.stoken, dirFid, credential, page, 100);
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  },

  /**
   * 取分享文件直链（含夸克去重修复）：
   * 1) 每次转存落到「YunX临时转存」下的唯一子目录 tr_<时间戳>_<随机>，
   *    使 sharepage/save 去重键 to_pdir_fid 每次不同 → 永远生成新 fid，
   *    避免「二次转存返回已删除 fid → download 404 code:21001」。
   * 2) 取链成功后不立即删，把临时子目录 fid 交给下载完成回调清理。
   */
  async getShareDownloadLink(session, file, credential, ctx): Promise<DownloadLink> {
    const api = new QuarkApi(ctx);

    // 确保「YunX临时转存」目录存在
    const rootFiles = await api.getFileList(QuarkConstants.DEFAULT_PDIR_FID, credential);
    let baseDir = rootFiles.find((f) => f.isdir && f.fname === QuarkConstants.TEMP_DIR_NAME)?.fid;
    if (!baseDir) {
      baseDir = await api.createFolder(
        QuarkConstants.TEMP_DIR_NAME,
        QuarkConstants.DEFAULT_PDIR_FID,
        credential,
      );
      if (!baseDir) throw new PlatformError('创建临时目录失败');
    }

    // 唯一临时子目录：to_pdir_fid 每次不同 → 绕开夸克去重
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

    const link = await api.getDownloadLink(savedFid, credential);
    // 不在此删除！下载完成后再删整个子目录
    link.cleanupDirFid = subDirFid;
    return link;
  },

  async cleanupTempDir(dirFid, credential, ctx): Promise<void> {
    try {
      const api = new QuarkApi(ctx);
      await api.deleteFile(dirFid, credential);
    } catch {
      /* 清理失败不阻断主流程 */
    }
  },

  async getQuota(credential, ctx): Promise<QuotaInfo | null> {
    return new QuarkApi(ctx).getQuota(credential);
  },

  async fetchNickname(credential, ctx): Promise<string | null> {
    return new QuarkApi(ctx).fetchNickname(credential);
  },
};

export { QuarkApi };
export const quarkCookieUtil = QuarkCookieUtil;
export { withCookies };
