/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 本文件移植自 CYQawa/YunX（AGPL-3.0）的 ShareLinkParser.kt。
 * 本程序是自由软件：你可以依据 GNU Affero 通用公共许可证（AGPL-3.0）的条款
 * 重新发布和/或修改它。详见 <https://www.gnu.org/licenses/>。
 */

/** 网盘平台 */
export type SharePlatform = 'QUARK' | 'UC' | 'XUNLEI' | 'BAIDU' | 'C139' | 'PAN123';

export const PLATFORM_LABELS: Record<SharePlatform, string> = {
  QUARK: '夸克网盘',
  UC: 'UC 网盘',
  XUNLEI: '迅雷网盘',
  BAIDU: '百度网盘',
  C139: '139 网盘',
  PAN123: '123 云盘',
};

/** 分享链接解析结果 */
export interface ParsedShare {
  shareId: string;
  pwd: string | null;
  platform: SharePlatform;
  /** 原始链接（部分平台直链获取需要） */
  rawUrl?: string;
}

const URL_RE = /https?:\/\/[^\s]+/;const QUARK_RE = /pan\.quark\.cn\/s\/([A-Za-z0-9]+)/i;
const UC_RE = /drive\.uc\.cn\/s\/([A-Za-z0-9]+)/i;
const XUNLEI_RE = /pan\.xunlei\.com\/s\/([A-Za-z0-9_-]+)/i;
const BAIDU_RE = /pan\.baidu\.com\/s\/(1[A-Za-z0-9_-]+)/i;
const C139_RE = /yun\.139\.com\/shareweb\/.*?\/w\/i\/([A-Za-z0-9_-]+)/i;
const PAN123_RE = /123(?:865|pan)\.(?:com|cn)\/s\/([A-Za-z0-9]+-[A-Za-z0-9]+)/i;
const PAN123_SUB_RE = /share\.123pan\.cn\/123pan\/([A-Za-z0-9-]+)/i;
const PAN123_SRR_RE = /api\/srr\?sk=([A-Za-z0-9-]+)/i;
const PWD_IN_URL_RE = /[?&]pwd=([A-Za-z0-9]+)/;
// 提取码：「提取码：xxxx」/「提取码 xxxx」/「提取码:xxxx」均支持（冒号可省略）
const PWD_IN_TEXT_RE = /(?:提取码|访问码|密码|提取碼|密碼)[：:\s]*([A-Za-z0-9]{4,8})/;

const TRAILING = new Set(['。', '，', ',', '；', ';', ')', ']', '}', '"', "'"]);

/**
 * 截断 URL：除去结尾标点，并在遇到中文标点/汉字时提前截断。
 * 原 Kotlin 只做 trimEnd（结尾标点），但分享文案里常见
 * 「https://pan.baidu.com/s/1XyZ123，提取码 x9y8」这种无空格紧贴中文的写法，
 * 若不在此截断，URL 会吞掉后面的「，提取码」，导致提取码无法回填。
 */
function cleanUrl(raw: string): string {
  // 先按中文标点/汉字/全角空格切断（这些不可能出现在 URL 合法字符中）
  const cut = raw.search(/[，。；！？、（）【】《》“”‘’\u4e00-\u9fff\u3000]/);
  let s = cut >= 0 ? raw.slice(0, cut) : raw;
  // 再去掉结尾的 ASCII 标点
  let end = s.length;
  while (end > 0 && TRAILING.has(s[end - 1])) end--;
  return s.slice(0, end);
}

/**
 * 从分享链接或整段分享文案中提取 share_id 与提取码。
 * 支持按平台顺序：夸克 → UC → 迅雷 → 百度 → 139 → 123（3 种形态）。
 */
export function parseShareLink(text: string): ParsedShare | null {
  if (!text) return null;
  const match = URL_RE.exec(text.trim());
  if (!match) return null;
  const url = cleanUrl(match[0]);

  const pwdFromUrl = (): string | null => {
    const m = PWD_IN_URL_RE.exec(url);
    return m ? m[1] : null;
  };
  const pwdFromText = (): string | null => {
    const m = PWD_IN_TEXT_RE.exec(text);
    return m ? m[1] : null;
  };
  // 与 Kotlin 版一致：优先取 URL 中的 pwd，其次从整段文案中匹配提取码
  const pwd = (): string | null => pwdFromUrl() ?? pwdFromText();

  let m: RegExpExecArray | null;

  if ((m = QUARK_RE.exec(url))) {
    return { shareId: m[1], pwd: pwd(), platform: 'QUARK', rawUrl: url };
  }
  if ((m = UC_RE.exec(url))) {
    return { shareId: m[1], pwd: pwd(), platform: 'UC', rawUrl: url };
  }
  if ((m = XUNLEI_RE.exec(url))) {
    return { shareId: m[1], pwd: pwd(), platform: 'XUNLEI', rawUrl: url };
  }
  if ((m = BAIDU_RE.exec(url))) {
    // 百度 surl 不包含开头的 "1"（verify/list 接口用 1 后面的部分）
    const surl = m[1].replace(/^1/, '');
    return { shareId: surl, pwd: pwd(), platform: 'BAIDU', rawUrl: url };
  }
  if ((m = C139_RE.exec(url))) {
    return { shareId: m[1], pwd: pwd(), platform: 'C139', rawUrl: url };
  }
  if ((m = PAN123_RE.exec(url))) {
    return { shareId: m[1], pwd: pwd(), platform: 'PAN123', rawUrl: url };
  }
  if ((m = PAN123_SUB_RE.exec(url))) {
    return { shareId: m[1], pwd: pwd(), platform: 'PAN123', rawUrl: url };
  }
  if ((m = PAN123_SRR_RE.exec(url))) {
    return { shareId: m[1], pwd: pwd(), platform: 'PAN123', rawUrl: url };
  }
  return null;
}
