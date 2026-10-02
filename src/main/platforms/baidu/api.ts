/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 BaiduApi.kt + BaiduResolveRepository.kt。
 * 完全使用 Node 内置 fetch（undici），不需要额外 HTTP 依赖。
 *
 * 链路（逐字对齐 Kotlin）：
 *   share/verify（仅当有提取码）→ xpan/share?method=list（分页）→ 确保临时转存目录
 *   → share/transfer → locatedownload → 立即删除临时转存（先清理后返回）。
 */

import type { DownloadLink, QuotaInfo, ShareFile, ShareSession } from '../../../shared/types';
import { BaiduConstants, BAIDU_TEMP_DIR, baiduErrnoMessage } from './constants';
import type { PlatformAdapter, ResolveContext } from '../types';
import { PlatformError } from '../types';
import { hasCookie, mergeSetCookies, cookieOrEmpty } from '../../net/cookieJar';
import type { CookieLike } from '../../net/cookieJar';
import { javaUrlEncode } from '../../util/crypto';

/** 分享列表响应（xpan/share?method=list） */
interface BaiduShareList {
  title: string;
  /** 数值 share_id，转存必需 */
  shareId: string;
  /** 分享者 uk，转存必需 */
  uk: string;
  files: ShareFile[];
}

/** 转存结果：新 fs_id + 新完整路径（locatedownload 用路径） */
interface BaiduTransferResult {
  fsId: string;
  path: string;
}

/** Java URLEncoder.encode(value, "UTF-8") 语义（空格 → '+'） */
function urlEncode(value: string): string {
  return javaUrlEncode(value);
}

class BaiduApi {
  /** bdstoken 缓存（登录态内长期有效） */
  private cachedBdstoken: string | null = null;

  constructor(private ctx: ResolveContext) {}

  /**
   * 统一请求入口：走 ctx.http（而非模块级 httpJson），
   * 以便测试注入、统一超时/代理，并把响应 Set-Cookie 回写登录态。
   */
  private async req(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ json: any; text: string; status: number; setCookies: string[] }> {
    const res = await this.ctx.http(url, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.headers,
      body: opts.body,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    // 百度会在响应中续期 BDUSS/STOKEN，及时回写避免登录态过期
    if (setCookies.length > 0 && this.ctx.saveCookie) {
      const cookieHeader = opts.headers?.Cookie;
      if (cookieHeader) {
        const merged = mergeSetCookies(cookieHeader, setCookies);
        if (merged !== cookieHeader) this.ctx.saveCookie(merged);
      }
    }
    return { json, text, status: res.status, setCookies };
  }

  /** 每个适配器调用持有独立实例，这里保持与 Kotlin 一致的进程内缓存语义 */
  async getBdstoken(cookie: CookieLike): Promise<string | null> {
    if (this.cachedBdstoken?.trim()) return this.cachedBdstoken;
    const result = await this.templateVariable(cookie, BaiduConstants.FIELDS_BDSTOKEN);
    const token = result ? String(result.bdstoken ?? '').trim() : '';
    if (!token) return null;
    this.cachedBdstoken = token;
    return token;
  }

  /** 获取昵称（gettemplatevariable 的 username 字段）；失败返回 null */
  async fetchNickname(cookie: CookieLike): Promise<string | null> {
    const result = await this.templateVariable(cookie, BaiduConstants.FIELDS_USERNAME);
    const name = result ? String(result.username ?? '').trim() : '';
    return name || null;
  }

  /** gettemplatevariable：errno==0 且 result 存在才算成功，任何异常 → null（非致命） */
  private async templateVariable(cookie: CookieLike, fields: string): Promise<any | null> {
    const url =
      `${BaiduConstants.TEMPLATE_VARIABLE_URL}` +
      `?clienttype=0&app_id=${BaiduConstants.APP_ID}&web=1` +
      `&fields=${urlEncode(fields)}`;
    try {
      const { json } = await this.req(url, {
        method: 'GET',
        headers: { Cookie: cookieOrEmpty(cookie), 'User-Agent': BaiduConstants.UA_WEB },
      });
      if (!json || Number(json.errno ?? -1) !== 0) return null;
      return json.result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 验证提取码：POST /share/verify，返回 randsk（URL 编码形式，直接作为 sekey 使用）。
   * Body 原样为 `pwd=<urlEncode(pwd)>&vcode_str=&vcode=`（空的 vcode_str/vcode 是字面量）。
   */
  async verifyShare(surl: string, pwd: string, cookie: CookieLike): Promise<string> {
    const url = `${BaiduConstants.SHARE_VERIFY_URL}?surl=${urlEncode(surl)}`;
    const { json } = await this.req(url, {
      method: 'POST',
      headers: {
        Cookie: cookieOrEmpty(cookie),
        'User-Agent': BaiduConstants.UA_WEB,
        Referer: `${BaiduConstants.SHARE_REFERER}${surl}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `pwd=${urlEncode(pwd)}&vcode_str=&vcode=`,
    });
    this.checkErrno(json, '验证提取码失败');
    const randsk = String(json?.randsk ?? '').trim();
    if (!randsk) throw new PlatformError('未返回分享密钥');
    return randsk;
  }

  /**
   * 列出分享文件：GET xpan/share?method=list。
   * 修复（文档《百度网盘解析问题修复》）：
   *  - 顶层 root=1，子目录 root=0（root=1 下百度忽略 dir → 子文件夹进不去）；
   *  - 子目录（root=0）必须携带 BDCLND cookie（= verify 返回的 randsk），否则 errno=2；
   *  - sekey 为空（公共分享）时省略 &sekey= 参数；
   *  - 无 sekey 却 errno!=0 → 实为加密分享，抛"该分享需要提取码"。
   * @param dir 分享内目录路径，根目录传 "/"（子目录传 "/folder"）
   */
  async listShare(
    surl: string,
    sekey: string,
    dir: string,
    cookie: CookieLike,
    page = 1,
  ): Promise<BaiduShareList> {
    // 根目录判定：''、'/'、'0' 都视为根。
    // '0' 是其它平台的 fid 约定（夸克/UC 用 '0' 表示根），上层 listFiles 会统一下发 '0'，
    // 必须在这里归一化——否则 '0' 会被当成名为 "0" 的子目录，root=0 触发 errno=2。
    const d = dir.trim();
    const isRoot = d === '' || d === '/' || d === '0';
    const root = isRoot ? '1' : '0';
    const sekeyPart = sekey.trim() ? `&sekey=${sekey}` : '';
    const url =
      `${BaiduConstants.SHARE_LIST_URL}` +
      `&shorturl=${surl}&page=${page}&num=${BaiduConstants.PAGE_SIZE}&root=${root}` +
      `&dir=${urlEncode(isRoot ? '/' : d)}` +
      sekeyPart;
    // 子目录(root=0)必须携带 BDCLND（= verify 的 randsk），否则 errno=2；顶层(root=1)无需
    // credential 可能为 null（匿名浏览），hasCookie 已容忍 null
    const authCookie =
      sekey.trim() && !hasCookie(cookie, 'BDCLND')
        ? `${cookieOrEmpty(cookie)}; BDCLND=${sekey}`
        : cookieOrEmpty(cookie);

    const { json } = await this.req(url, {
      method: 'GET',
      headers: {
        Cookie: authCookie,
        'User-Agent': BaiduConstants.UA_WEB,
        Referer: `${BaiduConstants.SHARE_REFERER}${surl}`,
      },
    });

    const errno = Number(json?.errno ?? -1);
    if (errno !== 0) {
      // 无 sekey 却失败 → 实为加密分享，提示用户索取提取码
      if (!sekey.trim()) throw new PlatformError('该分享需要提取码', errno);
      this.checkErrno(json, '获取分享文件列表失败');
    }

    const arr: any[] = Array.isArray(json?.list) ? json.list : [];
    const files = arr.map((item): ShareFile => {
      // 分享列表的 isdir 是**字符串** "1"；个人网盘列表是 int 1 —— 两种都兼容
      const isdir = String(item?.isdir ?? '') === '1' || Number(item?.isdir) === 1;
      const path = String(item?.path ?? '');
      return {
        // 目录用 path 作 fid（导航传参），文件用 fs_id（转存传参）
        fid: isdir ? path : String(item?.fs_id ?? ''),
        fname: String(item?.server_filename ?? ''),
        fsize: Number(item?.size ?? 0),
        isdir,
        pdirFid: path,
        fidToken: '',
        modifyTime: String(item?.server_mtime ?? ''),
      };
    });

    return {
      title: String(json?.title ?? ''),
      shareId: String(json?.share_id ?? ''),
      uk: String(json?.uk ?? ''),
      files,
    };
  }

  /** 确保临时转存目录存在：已存在则复用，不存在则创建，创建失败回退根目录（鲁棒性） */
  async ensureTempDir(cookie: CookieLike): Promise<string> {
    try {
      const exists = (await this.listDir('/', cookie)).includes(BAIDU_TEMP_DIR);
      const ok = exists || (await this.createDir(BAIDU_TEMP_DIR, cookie));
      return ok ? BAIDU_TEMP_DIR : BaiduConstants.ROOT_DIR;
    } catch {
      return BaiduConstants.ROOT_DIR;
    }
  }

  /** 列出个人网盘目录（检查临时转存目录是否存在），返回子项 path 集合 */
  async listDir(dir: string, cookie: CookieLike): Promise<string[]> {
    const url =
      `${BaiduConstants.CLOUD_LIST_URL}` +
      `?clienttype=0&app_id=${BaiduConstants.APP_ID}&web=1&order=time&desc=1` +
      `&dir=${urlEncode(dir)}&num=${BaiduConstants.PAGE_SIZE}&page=1`;
    try {
      const { json } = await this.req(url, {
        method: 'GET',
        headers: { Cookie: cookieOrEmpty(cookie), 'User-Agent': BaiduConstants.UA_NETDISK },
      });
      if (!json || Number(json.errno ?? -1) !== 0) return [];
      const arr: any[] = Array.isArray(json.list) ? json.list : [];
      return arr.map((item) => String(item?.path ?? ''));
    } catch {
      return [];
    }
  }

  /** 创建目录（个人网盘路径），返回是否成功 */
  async createDir(path: string, cookie: CookieLike): Promise<boolean> {
    const bdstoken = await this.getBdstoken(cookie);
    if (!bdstoken) return false;
    // body 字面量含空的 size 与写死的 block_list=%5B%5D（对齐抓包）
    const body = `path=${urlEncode(path)}&isdir=1&size&block_list=%5B%5D&method=post&dataType=json`;
    const url =
      `${BaiduConstants.CREATE_DIR_URL}?a=commit&channel=chunlei&web=1` +
      `&app_id=${BaiduConstants.APP_ID}&clienttype=0&bdstoken=${bdstoken}`;
    try {
      const { json } = await this.req(url, {
        method: 'POST',
        headers: {
          Cookie: cookieOrEmpty(cookie),
          'User-Agent': BaiduConstants.UA_NETDISK,
          Referer: BaiduConstants.DISK_REFERER,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body,
      });
      return Number(json?.errno ?? -1) === 0;
    } catch {
      return false;
    }
  }

  /** 转存分享文件到指定目录（同步返回结果） */
  async transfer(
    shareId: string,
    uk: string,
    sekey: string,
    fsId: string,
    toDir: string,
    cookie: CookieLike,
  ): Promise<BaiduTransferResult> {
    const bdstoken = await this.getBdstoken(cookie);
    if (!bdstoken) throw new PlatformError('获取 bdstoken 失败，请重新登录');
    const url =
      `${BaiduConstants.SHARE_TRANSFER_URL}?shareid=${shareId}&from=${uk}` +
      `&channel=chunlei&sekey=${sekey}&ondup=newcopy&web=1&app_id=${BaiduConstants.APP_ID}` +
      `&bdstoken=${bdstoken}&clienttype=0`;
    const body = `fsidlist=%5B%22${fsId}%22%5D&path=${urlEncode(toDir)}`;
    // verify 响应会 Set-Cookie: BDCLND=<randsk>，transfer 必须携带（分享验证标识），
    // 缺失会 errno=2；BDCLND 值即 sekey（randsk），手动补齐
    const authCookie = hasCookie(cookie, 'BDCLND')
      ? cookieOrEmpty(cookie)
      : `${cookieOrEmpty(cookie)}; BDCLND=${sekey}`;

    const { json } = await this.req(url, {
      method: 'POST',
      headers: {
        Cookie: authCookie,
        'User-Agent': BaiduConstants.UA_WEB,
        Origin: BaiduConstants.ORIGIN,
        // 注意：Referer 恰好是 https://pan.baidu.com/s/，不带 surl
        Referer: BaiduConstants.SHARE_REFERER,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
    });
    this.checkErrno(json, '转存失败');

    const first = json?.extra?.list?.[0];
    const fsIdNew = String(first?.to_fs_id ?? '').trim();
    if (!fsIdNew) throw new PlatformError('转存失败：未返回新文件');
    const pathNew = String(first?.to ?? '').trim() || `${toDir}/`;
    return { fsId: fsIdNew, path: pathNew };
  }

  /**
   * 获取高速下载直链（官方 locatedownload 接口，对齐 MoePal 抓包）：
   * POST d.pcs.baidu.com/rest/2.0/pcs/file?method=locatedownload&path=<转存后完整路径>，body 为字面量 "0"。
   * 响应 urls[] 按 rank 返回多个候选 CDN 直链（自带 sign/expires，无需计算）：
   *  - rank1 常为 d2-ant.baidu.com（encrypt=1 加密通道，内容需 AES-CTR 解密，且部分网络 TLS 握手失败）
   *  - rank2+ 为 appallNN.baidupcs.com（encrypt=0 明文通道，可直接 Range 下载）
   * 仅需 BDUSS 登录态 + 手机 UA；psign 为写死常量，rand/devuid 复用抓包常量即可。
   */
  async locateDownload(path: string, cookie: CookieLike): Promise<string> {
    const time = Math.floor(Date.now() / 1000);
    const url =
      `${BaiduConstants.LOCATE_DOWNLOAD_URL}` +
      `?method=locatedownload` +
      `&app_id=${BaiduConstants.APP_ID}` +
      `&clienttype=17&ver=4.0` +
      `&ant=1&check_blue=1&es=1&esl=1&apn_id=1_-1` +
      `&freeisp=0&queryfree=0&use=1&dtype=1&eck=1&ehps=1` +
      `&err_ver=1.0&network_type=WIFI&channel=0` +
      `&path=${urlEncode(path)}` +
      `&time=${time}` +
      `&rand=${BaiduConstants.LOCATE_RAND}` +
      `&devuid=${BaiduConstants.LOCATE_DEVUID}` +
      `&cuid=${BaiduConstants.LOCATE_CUID}` +
      `&deviceid=${BaiduConstants.LOCATE_DEVICEID}` +
      `&psign=${BaiduConstants.LOCATE_PSIGN}` +
      `&version=${BaiduConstants.LOCATE_VERSION}&version_app=${BaiduConstants.LOCATE_VERSION_APP}&vip=0`;

    const { json } = await this.req(url, {
      method: 'POST',
      headers: {
        Cookie: cookieOrEmpty(cookie),
        'User-Agent': BaiduConstants.UA_NETDISK,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '0',
    });
    this.checkErrno(json, '获取高速下载链接失败');

    // 直链候选选择：优先 encrypt=0（明文，无需解密）的 https 直链（appall01/02）；
    // rank1 的 d2-ant 为 encrypt=1 加密通道（需 AES-CTR 解密且部分网络 TLS 握手失败），直接排除；
    // 全部为加密通道时退回第一个 https 候选（仍有尝试价值），最后兜底第一个候选。
    const raw: any[] = Array.isArray(json?.urls) ? json.urls : [];
    const candidates = raw
      .map((it) => ({ url: String(it?.url ?? ''), encrypt: Number(it?.encrypt ?? 1) }))
      .filter((it) => it.url.trim() !== '');
    const plain = candidates
      .filter((it) => it.encrypt === 0)
      .sort((a, b) => Number(!a.url.startsWith('https')) - Number(!b.url.startsWith('https')));
    const directUrl =
      plain[0]?.url ??
      candidates.find((it) => it.url.startsWith('https'))?.url ??
      candidates[0]?.url;
    if (!directUrl) throw new PlatformError('未返回下载链接');
    return directUrl;
  }

  /** 删除个人网盘文件（转存后清理），按完整路径删除 */
  async deleteFile(path: string, cookie: CookieLike): Promise<boolean> {
    const bdstoken = await this.getBdstoken(cookie);
    if (!bdstoken) return false;
    const body = `filelist=${urlEncode(`["${path}"]`)}`;
    const url =
      `${BaiduConstants.FILE_MANAGER_URL}?async=2&onnest=fail&opera=delete` +
      `&bdstoken=${bdstoken}&newVerify=1&clienttype=0&app_id=${BaiduConstants.APP_ID}&web=1`;
    try {
      const { json } = await this.req(url, {
        method: 'POST',
        headers: {
          Cookie: cookieOrEmpty(cookie),
          'User-Agent': BaiduConstants.UA_NETDISK,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body,
      });
      return Number(json?.errno ?? -1) === 0;
    } catch {
      return false;
    }
  }

  /** 网盘空间详情（yun.baidu.com/api/quota：total / used） */
  async getQuota(cookie: CookieLike): Promise<QuotaInfo | null> {
    const url =
      `${BaiduConstants.QUOTA_URL}?clienttype=0&app_id=${BaiduConstants.APP_ID}` +
      `&web=1&channel=chunlei&version=${Date.now()}`;
    try {
      const { json } = await this.req(url, {
        method: 'GET',
        headers: {
          Cookie: cookieOrEmpty(cookie),
          'User-Agent': BaiduConstants.UA_NETDISK,
          'X-Requested-With': 'XMLHttpRequest',
          Referer: BaiduConstants.DISK_REFERER,
        },
      });
      if (!json || Number(json.errno ?? -1) !== 0) return null;
      return { used: Number(json.used ?? 0), total: Number(json.total ?? 0) };
    } catch {
      return null;
    }
  }

  /** 统一 errno 判定：常见 errno=-12 提取码错误 / 403 分享已失效 / 31066 文件不存在 */
  private checkErrno(json: any, fallback: string): void {
    const errno = Number(json?.errno ?? -1);
    if (errno === 0) return;
    const msg = baiduErrnoMessage(errno, json?.err_msg, json?.show_msg, fallback);
    throw new PlatformError(msg, errno);
  }
}

/**
 * 删除转存文件（失败不阻断）；转存在临时目录时，删完文件后尝试删空目录。
 * 对齐 Kotlin BaiduResolveRepository.deleteTransferred（两处 runCatching 均吞掉异常）。
 */
async function deleteTransferred(api: BaiduApi, path: string, credential: CookieLike): Promise<void> {
  try {
    await api.deleteFile(path, credential);
  } catch {
    /* 清理失败不阻断主流程 */
  }
  if (path.startsWith(`${BAIDU_TEMP_DIR}/`)) {
    try {
      await api.deleteFile(BAIDU_TEMP_DIR, credential);
    } catch {
      /* 清理失败不阻断主流程 */
    }
  }
}

/** 百度适配器：verify → xpan/share 列表 → 转存临时目录 → locatedownload → 立即清理 */
export const baiduAdapter: PlatformAdapter = {
  platform: 'BAIDU',
  label: '百度网盘',
  /** 转存 / locatedownload 必须登录（Cookie 需含 BDUSS） */
  requiresAuth: true,
  /** 公共分享（无提取码）可匿名列出文件，仅取直链需要登录 */
  canListAnonymous: true,

  isLoggedIn(credential) {
    return hasCookie(credential, 'BDUSS');
  },

  async createSession(link, pwd, credential, ctx): Promise<ShareSession> {
    const api = new BaiduApi(ctx);
    const surl = link;
    // 修复：公共分享（pwd 为空）不强制提取码——跳过 verify，sekey 置空，
    // listShare 将不带 sekey 直接列出（抓包实证：公共分享无需 sekey/Cookie 即 errno=0）
    const effectivePwd = pwd?.trim() ? pwd : null;
    const sekey = effectivePwd ? await api.verifyShare(surl, effectivePwd, credential) : '';
    ctx.log?.(effectivePwd ? '提取码校验通过' : '公共分享，跳过提取码校验');
    // ShareSession.stoken 在百度链路里承载 sekey（randsk），title 由列表接口补全
    return { shareId: surl, stoken: sekey, title: '' };
  },

  async listFiles(session, dirFid, credential, ctx): Promise<ShareFile[]> {
    const api = new BaiduApi(ctx);
    const sekey = session.stoken;
    // 顶层 dirFid 为空/"/"；子目录 dirFid 为目录 path（如 /folder）
    const all: ShareFile[] = [];
    let page = 1;
    let result: BaiduShareList;
    do {
      result = await api.listShare(session.shareId, sekey, dirFid, credential, page);
      all.push(...result.files);
      page++;
      // 整页 100 条才继续翻页；封顶 100 页防止异常死循环
    } while (result.files.length === BaiduConstants.PAGE_SIZE && page <= BaiduConstants.MAX_PAGE);
    return all;
  },

  /**
   * 取分享文件直链：
   * ensureTempDir（失败回退根目录）→ share/transfer → locatedownload →
   * **取链成功后立即删除临时转存**（appall 直链自带 sign/expires，不依赖转存文件存活；
   * 删除失败不阻断主流程）。cleanupDirFid 不设置，清理已在链内完成。
   */
  async getShareDownloadLink(session, file, credential, ctx): Promise<DownloadLink> {
    const api = new BaiduApi(ctx);
    // share_id / uk 由列表接口返回；此处无条件重列一次根目录兜底（对齐 requireShareInfo）
    const info = await api.listShare(session.shareId, session.stoken, '/', credential, 1);
    const shareId = info.shareId;
    const uk = info.uk;
    if (!shareId || !uk) throw new PlatformError('未能获取分享信息（share_id/uk）');

    const toDir = await api.ensureTempDir(credential);
    const transferred = await api.transfer(
      shareId,
      uk,
      session.stoken,
      file.fid,
      toDir,
      credential,
    );

    // locatedownload 按转存后的完整路径取链，返回 appallNN.baidupcs.com CDN 直链
    const dlink = await api.locateDownload(transferred.path, credential);

    // appall 直链不依赖转存文件存活：取链成功后立即删除临时转存，网盘不留残留（失败不阻断）
    await deleteTransferred(api, transferred.path, credential);

    return {
      fid: transferred.fsId,
      filename: file.fname,
      downloadUrl: dlink,
      size: file.fsize,
      // 百度 CDN 直链下载必须携带 BDUSS Cookie + 手机端 UA
      headers: {
        Cookie: credential,
        'User-Agent': BaiduConstants.UA_NETDISK,
      },
    };
  },

  async getQuota(credential, ctx): Promise<QuotaInfo | null> {
    return new BaiduApi(ctx).getQuota(credential);
  },

  async fetchNickname(credential, ctx): Promise<string | null> {
    return new BaiduApi(ctx).fetchNickname(credential);
  },
};

export { BaiduApi, urlEncode };
