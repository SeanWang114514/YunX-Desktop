/*
 * YunX Desktop (云析桌面版)
 * Copyright (C) 2026  YunX Desktop Port
 *
 * 移植自 CYQawa/YunX（AGPL-3.0）的 XunleiConstants.kt + XunleiDeviceFingerprint.kt。
 * 迅雷网盘常量（依据抓包 + 迅雷网盘API文档，两者互相印证），值全部逐字引用。
 */

import { app } from 'electron';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 登录 / 验证码 / Token 主机 */
const AUTH_BASE = 'https://xluser-ssl.xunlei.com';
/** 文件 / 分享 / 下载主机 */
const PAN_BASE = 'https://api-pan.xunlei.com';

export const XunleiConstants = {
  AUTH_BASE,
  PAN_BASE,

  /** Web 端公开凭据（文档推荐，可正常换 Token） */
  CLIENT_ID: 'Xp6pAdwyJv9sQuoN',
  CLIENT_SECRET: 'standard_a@api#',

  /** App 端凭据（官方 app 抓包，/v1/auth/signin/token 换 token 用） */
  APP_CLIENT_ID: 'Xp6vsxz_7IYVw2BB',
  APP_CLIENT_SECRET: 'Xp6vsy4tN9toTVdMSpomVdXpRmES',

  /** Android 端身份（captcha_sign 计算用，alist 验证与 MoePal 抓包一致） */
  APP_CLIENT_VERSION: '8.31.0.9726',
  APP_PACKAGE_NAME: 'com.xunlei.downloadprovider',

  /** Android 端 captcha 盐（10 个，alist 源码确认，活体验证通过） */
  CAPTCHA_SALTS: [
    '9uJNVj/wLmdwKrJaVj/omlQ',
    'Oz64Lp0GigmChHMf/6TNfxx7O9PyopcczMsnf',
    'Eb+L7Ce+Ej48u',
    'jKY0',
    'ASr0zCl6v8W4aidjPK5KHd1Lq3t+vBFf41dqv5+fnOd',
    'wQlozdg6r1qxh0eRmt3QgNXOvSZO6q/GXK',
    'gmirk+ciAvIgA/cxUUCema47jr/YToixTT+Q6O',
    '5IiCoM9B1/788ntB',
    'P07JH0h6qoM6TSUAK2aL9T5s2QBVeY9JWvalf',
    '+oK0AN',
  ],

  /** App UA（官方 app 抓包） */
  APP_UA:
    'ANDROID-com.xunlei.downloadprovider/8.31.0.9726 netWorkType/5G appid/40 ' +
    'deviceName/Xiaomi_M2004j7ac deviceModel/M2004J7AC OSVersion/12 protocolVersion/301 ' +
    'platformVersion/10 sdkVersion/512000 Oauth2Client/0.9 (Linux 4_14_186-perf-gddfs8vbb238b) (JAVA 0)',

  /** 浏览器 UA（Web 端 pan 请求） */
  WEB_UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',

  // ---------- 设备标识（fallback 官方指纹，正常情况下由 XunleiDeviceFingerprint 动态生成） ----------
  // devicesign 后半段为迅雷 SDK 生成的设备指纹，动态生成算法见 XunleiDeviceFingerprint（§8 公式）。
  // 以下官方抓包值仅作为「指纹未初始化/异常路径」的兜底，避免请求缺字段崩溃。

  /** 设备 ID（x-device-id / captcha device_id / devicesign 前半；fallback） */
  DEVICE_ID: '78a70629a2b17d0b4302317ffa94807a',

  /** 登录请求 peerID（fallback） */
  PEER_ID: '92df4c42e0926ff55f1c605ebe4c3754',

  /** 设备指纹 div101.设备ID+SDK指纹（fallback） */
  DEVICE_SIGN: 'div101.78a70629a2b17d0b4302317ffa94807a31491e163e795b39e798ed33ae58858b',

  // ---------- 登录端点 ----------

  /** 验证码盾初始化 */
  CAPTCHA_INIT_URL: `${AUTH_BASE}/v1/shield/captcha/init`,

  /** 账号密码登录（xluser 会话） */
  LOGIN_URL: `${AUTH_BASE}/xluser.core.login/v3/login`,

  /** 发送短信验证码 */
  SEND_SMS_URL: `${AUTH_BASE}/xluser.core.login/v3/sendsms`,

  /** 短信验证码登录 */
  SMS_LOGIN_URL: `${AUTH_BASE}/xluser.core.login/v3/smslogin`,

  /** 换取 access_token（官方 app 抓包：POST /v1/auth/signin/token，body 带 signin_token=sessionID） */
  TOKEN_URL: `${AUTH_BASE}/v1/auth/signin/token`,

  /** 刷新 access_token（OAuth2 refresh_token；导入恢复后 token 过期自动续期） */
  REFRESH_URL: `${AUTH_BASE}/v1/auth/token`,

  // ---------- Pan 端点 ----------

  /** 文件列表 / 详情 / 建目录 */
  FILES_URL: `${PAN_BASE}/drive/v1/files`,

  /** 分享解析（GET ?share_id=&pass_code=&limit=&page_token=&thumbnail_size=） */
  SHARE_URL: `${PAN_BASE}/drive/v1/share`,

  /** 分享子目录文件列表（GET ?share_id=&parent_id=&pass_code_token=&limit=&page_token=&thumbnail_size=） */
  SHARE_DETAIL_URL: `${PAN_BASE}/drive/v1/share/detail`,

  /** 转存（POST） */
  RESTORE_URL: `${PAN_BASE}/drive/v1/share/restore`,

  /** 异步任务轮询（GET /tasks/{taskId}?type=share） */
  TASKS_URL: `${PAN_BASE}/drive/v1/tasks`,

  /** 转存目标目录名 */
  TEMP_DIR_NAME: 'YunX临时转存',

  /** 移动文件（batchMove：ids + to.parent_id） */
  MOVE_URL: `${PAN_BASE}/drive/v1/files:batchMove`,

  /** 删除文件（batchTrash：ids + space） */
  TRASH_URL: `${PAN_BASE}/drive/v1/files:batchTrash`,

  /** 创建分享（POST /drive/v1/share，file_ids + title + expiration_days） */
  SHARE_CREATE_URL: `${PAN_BASE}/drive/v1/share`,

  /** 网盘空间详情（XunleiApi.getQuota 内联：GET /drive/v1/about；非 XunleiConstants 常量，逐字保留） */
  ABOUT_URL: `${PAN_BASE}/drive/v1/about`,

  // ---------- XunleiApi 内联的字面量（Kotlin 里不是常量，为避免各处漂移集中在此） ----------

  /** pan 请求统一 X-Client-Version（panRequest / panRequestM / initCaptcha 头） */
  CLIENT_VERSION_HEADER: '8.31.0.9726',
  /** captcha/init 与 signin/token 的 redirect_uri（逐字） */
  REDIRECT_URI: 'xlaccsdk01://xunlei.com/callback?state=harbor',
  /** 官方 pan 请求的 Origin / Referer */
  PAN_ORIGIN: 'https://pan.xunlei.com',
  PAN_REFERER: 'https://pan.xunlei.com/',

  /** deviceSign 公式常量 */
  FP_PACKAGE_NAME: 'com.xunlei.downloadprovider',
  FP_APPID: '40',
  FP_APP_KEY: '34a062aaa22f906fca4fefe9fb3a3021',
  FP_HEX: '0123456789abcdef',

  // ---------- 轮询参数（Kotlin 循环次数/间隔逐字） ----------

  /** pollTask：最多 15 次 × 1s */
  POLL_TASK_ATTEMPTS: 15,
  POLL_TASK_INTERVAL_MS: 1000,
  /** getFiles 自动翻页：封顶 100 页，防异常死循环 */
  MAX_FILE_PAGES: 100,
  /** ensureFreshToken：JWT 剩余寿命 < 60s 即刷新 */
  TOKEN_REFRESH_MARGIN_SEC: 60,
};

/** 迅雷设备标识（deviceId / peerId / deviceSign） */
export interface XunleiDeviceIdentity {
  deviceId: string;
  peerId: string;
  deviceSign: string;
}

/**
 * 迅雷设备指纹管理器（动态生成 + 持久化）。
 * 移植自 XunleiDeviceFingerprint.kt：
 * - 每台设备首次启动生成唯一 deviceId/peerId/devicesign，此后永久复用（进程重启不变）；
 * - devicesign 按 §8 公式：div101.{deviceId}{md5(sha1(deviceId + package + appid + appkey))}；
 * - 未初始化（异常路径）时回退到 XunleiConstants 官方抓包指纹，保证行为不崩。
 *
 * 目的：开源分发后每台设备独立指纹，避免所有用户共享一个官方指纹被迅雷风控识别/连带封禁。
 * Android 版把三个值落 SharedPreferences；桌面版等价物为 userData 目录下的 JSON 文件
 * （凭据本身仍由 CredentialStore/safeStorage 加密保存，此处只存非敏感的指纹字段）。
 */
export class XunleiDeviceFingerprint {
  private static readonly FILE = 'xunlei-device-fp.json';

  private static identity: XunleiDeviceIdentity | null = null;

  /** 进程内只初始化一次（对齐 Kotlin 的 initialized 幂等语义） */
  static init(): XunleiDeviceIdentity {
    if (this.identity) return this.identity;

    let file = '';
    try {
      file = join(app.getPath('userData'), this.FILE);
    } catch {
      // app 未就绪等异常路径：直接回退官方指纹（对齐 Kotlin 绝不崩的约定）
      this.identity = {
        deviceId: XunleiConstants.DEVICE_ID,
        peerId: XunleiConstants.PEER_ID,
        deviceSign: XunleiConstants.DEVICE_SIGN,
      };
      return this.identity;
    }

    try {
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        const savedId = typeof raw?.device_id === 'string' ? raw.device_id : '';
        if (savedId) {
          // Kotlin: peerId/deviceSign 缺省时回退官方抓包值（prefs.getString(KEY, fallback)!!）
          this.identity = {
            deviceId: savedId,
            peerId: typeof raw?.peer_id === 'string' && raw.peer_id
              ? raw.peer_id
              : XunleiConstants.PEER_ID,
            deviceSign: typeof raw?.device_sign === 'string' && raw.device_sign
              ? raw.device_sign
              : XunleiConstants.DEVICE_SIGN,
          };
          return this.identity;
        }
      }
    } catch {
      /* 文件损坏 → 走首次生成分支 */
    }

    // 首次启动：生成唯一设备指纹并持久化
    const newId = this.randomHex(32);
    const newPeer = this.randomHex(32);
    const newSign = this.buildDeviceSign(newId);
    try {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({ device_id: newId, peer_id: newPeer, device_sign: newSign }, null, 2),
        'utf8',
      );
    } catch (e) {
      // 写盘失败不阻断：本次进程内仍使用新生成的指纹
      console.error('[xunlei] 设备指纹持久化失败', e);
    }
    this.identity = { deviceId: newId, peerId: newPeer, deviceSign: newSign };
    return this.identity;
  }

  static deviceId(): string {
    return this.init().deviceId;
  }

  static peerId(): string {
    return this.init().peerId;
  }

  static deviceSign(): string {
    return this.init().deviceSign;
  }

  /** devicesign：div101.{deviceId}{md5(sha1(deviceId + package_name + appid + app_key))} */
  private static buildDeviceSign(id: string): string {
    const base = id + XunleiConstants.FP_PACKAGE_NAME + XunleiConstants.FP_APPID + XunleiConstants.FP_APP_KEY;
    const sha1 = createHash('sha1').update(base, 'utf8').digest('hex');
    const md5 = createHash('md5').update(sha1, 'utf8').digest('hex');
    return `div101.${id}${md5}`;
  }

  /** 32 位小写 hex（对齐 Kotlin Random.nextInt(16) 逐位取值 + HEX 表） */
  private static randomHex(len: number): string {
    const table = XunleiConstants.FP_HEX;
    const bytes = randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += table[bytes[i] % 16];
    return out;
  }
}

/** 构造 pan 请求头（Bearer + 设备 + captcha，抓包确认无 x-signature，对应 panRequest/panRequestM）
 *  captchaToken 为空时不带 X-Captcha-Token（对齐 Kotlin if (captchaToken.isNotBlank())） */
export function xunleiPanHeaders(
  accessToken: string,
  deviceId: string,
  captchaToken: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': XunleiConstants.WEB_UA,
    Authorization: `Bearer ${accessToken}`,
    'X-Device-Id': deviceId,
    'X-Client-Version': XunleiConstants.CLIENT_VERSION_HEADER,
    'Content-Type': 'application/json',
    Origin: XunleiConstants.PAN_ORIGIN,
    Referer: XunleiConstants.PAN_REFERER,
  };
  if (captchaToken) headers['X-Captcha-Token'] = captchaToken;
  return headers;
}