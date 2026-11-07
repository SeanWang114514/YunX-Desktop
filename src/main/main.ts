/*
 * YunX Desktop (云析桌面版) —— 主进程入口。
 */

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, session } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { CredentialStore } from './store/credentialStore.js';
import { ResolveService } from './resolve/resolveService.js';
import { TaskManager } from './download/taskManager.js';
import { UploadManager } from './upload/uploadManager.js';
import { createBaiduAuthorizeUrl, parseBaiduOAuthCallback, exchangeBaiduCode, refreshBaiduToken } from './upload/baiduOAuth.js';
import { ALL_ADAPTERS, getAdapter } from './platforms/index.js';
import { LogCollector } from './util/logCollector.js';
import type { SharePlatform, ShareFile, DownloadLink } from '../shared/types';
import { PLATFORM_LABELS } from '../shared/linkParser.js';

let mainWindow: BrowserWindow | null = null;
let store: CredentialStore;
let resolveService: ResolveService;
let taskManager: TaskManager;
let uploadManager: UploadManager;
let logger: LogCollector;

/** 百度 OAuth 授权窗口与一次性 state */
let baiduOAuthWindow: BrowserWindow | null = null;
let pendingBaiduOAuthState = '';

/** 登录窗口（WebView 式 Cookie 获取） */
let loginWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged;
/** 仅当显式设置 YUNX_DEVTOOLS=1 时打开开发者工具（默认不干扰界面） */
const showDevTools = process.env.YUNX_DEVTOOLS === '1';
/**
 * 调试模式：YUNX_DEBUG_UI=<js表达式> 时，窗口加载完成后在渲染层执行该表达式，
 * 把结果打印到主进程 stdout。用于自动化验证真实界面（无需 DevTools 交互）。
 */
const debugUiExpr = process.env.YUNX_DEBUG_UI;

function defaultDownloadDir(): string {
  const dir = join(app.getPath('downloads'), 'YunX');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: '云析 YunX 桌面版',
    backgroundColor: '#f9f9ff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const indexHtml = join(__dirname, '../renderer/index.html');
  if (existsSync(indexHtml)) {
    void mainWindow.loadFile(indexHtml);
  } else {
    void mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<h1>渲染层未构建</h1><p>请先运行 npm run build</p>',
    ));
  }

  if (showDevTools) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // 自动化验证钩子：在真实渲染层执行表达式并回传结果
  if (debugUiExpr) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const out = await mainWindow!.webContents.executeJavaScript(debugUiExpr, true);
          console.log('__DEBUG_UI_RESULT__' + JSON.stringify(out));
        } catch (e: any) {
          console.log('__DEBUG_UI_ERROR__' + String(e?.message ?? e));
        }
      }, 1200);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 注册 IPC */
function registerIpc(): void {
  // ---------- 平台信息 ----------
  ipcMain.handle('platform:list', () =>
    ALL_ADAPTERS.map((a) => ({
      platform: a.platform,
      label: a.label,
      requiresAuth: a.requiresAuth,
      canListAnonymous: !!a.canListAnonymous,
      loggedIn: a.isLoggedIn(store.getCredential(a.platform)),
      nickname: store.getSetting<string>(`nickname_${a.platform}`, ''),
    })),
  );

  // ---------- 解析 ----------
  ipcMain.handle('resolve:parse', async (_e, text: string, pwd?: string) => {
    try {
      const result = await resolveService.resolve(text, pwd);
      return { ok: true, data: result };
    } catch (e: any) {
      logger.error(`解析失败: ${e?.message}`);
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle(
    'resolve:listDir',
    async (_e, platform: SharePlatform, shareId: string, dirFid: string, text?: string) => {
      try {
        const files = await resolveService.listDir(platform, shareId, dirFid, text);
        return { ok: true, data: files };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  );

  ipcMain.handle(
    'resolve:getLink',
    async (_e, platform: SharePlatform, shareId: string, file: ShareFile, text?: string) => {
      try {
        const link = await resolveService.getDownloadLink(platform, shareId, file, text);
        return { ok: true, data: link };
      } catch (e: any) {
        logger.error(`取直链失败: ${e?.message}`);
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  );

  // ---------- 下载 ----------
  ipcMain.handle(
    'download:add',
    async (
      _e,
      platform: SharePlatform,
      shareId: string,
      file: ShareFile,
      link: DownloadLink,
      saveDir?: string,
      text?: string,
    ) => {
      try {
        const dir = saveDir || store.getSetting<string>('downloadDir', defaultDownloadDir());
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const task = taskManager.create({
          platform,
          fid: file.fid,
          fileName: link.filename || file.fname,
          url: link.downloadUrl,
          dirPath: dir,
          size: link.size || file.fsize,
          cleanupDirFid: link.cleanupDirFid ?? null,
          headers: link.headers ?? {},
        });
        taskManager.start(task.id).catch((err) => logger.error(`启动下载失败: ${err?.message}`));
        return { ok: true, data: task };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  );

  ipcMain.handle('download:list', () => taskManager.list());
  ipcMain.handle('download:pause', async (_e, id: string) => {
    await taskManager.pause(id);
    return { ok: true };
  });
  ipcMain.handle('download:resume', (_e, id: string) => {
    taskManager.start(id).catch((err) => logger.error(`继续下载失败: ${err?.message}`));
    return { ok: true };
  });
  ipcMain.handle('download:remove', async (_e, id: string) => {
    await taskManager.remove(id);
    return { ok: true };
  });
  ipcMain.handle('download:openFolder', async (_e, id: string) => {
    const t = taskManager.get(id);
    if (t) await shell.openPath(t.dirPath);
    return { ok: true };
  });
  ipcMain.handle('download:openFile', async (_e, id: string) => {
    const t = taskManager.get(id);
    if (t) await shell.openPath(join(t.dirPath, t.fileName));
    return { ok: true };
  });

  // ---------- 设置 ----------
  ipcMain.handle('settings:get', (_e, key: string, fallback: unknown) =>
    store.getSetting(key, fallback),
  );
  ipcMain.handle('settings:set', (_e, key: string, value: unknown) => {
    store.setSetting(key, value);
    return { ok: true };
  });
  ipcMain.handle('settings:pickDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory', 'createDirectory'],
      title: '选择下载保存目录',
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false };
    return { ok: true, data: res.filePaths[0] };
  });

  // ---------- 本地文件上传 ----------
  ipcMain.handle('upload:pickFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要上传的文件',
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, data: [] };
    try {
      const files = await uploadManager.grantFiles(res.filePaths);
      return { ok: true, data: files };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e), data: [] };
    }
  });
  ipcMain.handle('upload:grantDroppedFile', async (_e, filePath: unknown) => {
    try {
      if (typeof filePath !== 'string' || !filePath.trim() || filePath.length > 4096) throw new Error('拖放文件路径无效');
      const [file] = await uploadManager.grantFiles([filePath]);
      return { ok: true, data: file };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
  ipcMain.handle('upload:list', () => uploadManager.list());
  ipcMain.handle('upload:add', async (_e, files: unknown, platform: unknown) => {
    try {
      if (!Array.isArray(files) || files.length < 1 || files.length > 100) {
        throw new Error('一次只能选择 1-100 个文件');
      }
      const normalized = files.map((item) => {
        if (!item || typeof item !== 'object') throw new Error('上传文件参数无效');
        const value = item as { fileToken?: unknown; fileName?: unknown };
        const fileToken = typeof value.fileToken === 'string' ? value.fileToken.trim() : '';
        const fileName = value.fileName == null ? undefined : String(value.fileName);
        if (!fileToken || fileToken.length > 128) throw new Error('文件选择凭证无效');
        if (fileName !== undefined && fileName.length > 240) throw new Error('目标文件名过长');
        return { fileToken, fileName };
      });
      const tasks = await uploadManager.createFromGrants(normalized, String(platform) as SharePlatform);
      return { ok: true, data: tasks };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
  ipcMain.handle('upload:cancel', (_e, id: string) => { uploadManager.cancel(id); return { ok: true }; });
  ipcMain.handle('upload:remove', (_e, id: string) => { uploadManager.remove(id); return { ok: true }; });

  ipcMain.handle('auth:baiduOAuthStatus', () => {
    const record = store.canUseSecureOAuth() ? store.getBaiduOAuth() : null;
    return {
      secureStorage: store.canUseSecureOAuth(),
      configured: !!record?.config.appKey,
      authorized: !!record?.tokens?.accessToken,
      appName: record?.config.appName,
    };
  });
  ipcMain.handle('auth:saveBaiduOAuthConfig', (_e, config: any) => {
    try {
      if (!store.canUseSecureOAuth()) throw new Error('系统安全存储不可用，无法保存百度 OAuth 密钥');
      const normalized = {
        appKey: String(config?.appKey ?? '').trim(),
        appSecret: String(config?.appSecret ?? '').trim(),
        appName: String(config?.appName ?? '').trim(),
        redirectUri: String(config?.redirectUri ?? 'oob').trim() || 'oob',
      };
      if (!normalized.appKey || normalized.appKey.length > 256 || !normalized.appSecret || normalized.appSecret.length > 512 || !/^[A-Za-z0-9_-]{1,64}$/.test(normalized.appName)) {
        throw new Error('AppKey、Secret 或应用名称格式无效');
      }
      if (normalized.redirectUri !== 'oob') throw new Error('当前版本仅支持百度 OAuth OOB 回调 redirect_uri=oob');
      store.saveBaiduOAuth(normalized);
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });
  ipcMain.handle('auth:startBaiduOAuth', async () => {
    try {
      const record = store.getBaiduOAuth();
      if (!store.canUseSecureOAuth() || !record) throw new Error('请先配置百度开放平台 AppKey/Secret，并确保系统安全存储可用');
      if (record.config.redirectUri !== 'oob') throw new Error('当前版本仅支持百度 OAuth OOB 回调 redirect_uri=oob');
      if (baiduOAuthWindow && !baiduOAuthWindow.isDestroyed()) baiduOAuthWindow.close();
      const auth = createBaiduAuthorizeUrl({ ...record.config, redirectUri: record.config.redirectUri || 'oob' });
      const oauthRevision = store.getBaiduOAuthRevision();
      pendingBaiduOAuthState = auth.state;
      baiduOAuthWindow = new BrowserWindow({ width: 960, height: 720, title: '授权百度网盘上传', parent: mainWindow ?? undefined, webPreferences: { contextIsolation: true, nodeIntegration: false } });
      const oauthWindow = baiduOAuthWindow;
      const capture = async (target: string) => {
        if (!target.startsWith('http://openapi.baidu.com/oauth/2.0/login_success')) return;
        if (oauthWindow !== baiduOAuthWindow) return;
        try {
          const code = parseBaiduOAuthCallback(target, auth.state);
          if (pendingBaiduOAuthState === auth.state) pendingBaiduOAuthState = '';
          const tokens = await exchangeBaiduCode(record.config, code);
          if (!store.saveBaiduOAuthIfCurrent(record.config, tokens, oauthRevision)) {
            throw new Error('百度 OAuth 配置已在授权期间变更，请重新授权');
          }
          oauthWindow.close();
          mainWindow?.webContents.send('auth:baiduOAuthChanged');
        } catch (error: any) {
          logger.error(`百度 OAuth 授权失败: ${error?.message}`);
        }
      };
      oauthWindow.webContents.on('will-redirect', (event, url) => {
        if (url.startsWith('http://openapi.baidu.com/oauth/2.0/login_success')) { event.preventDefault(); void capture(url); }
      });
      oauthWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith('http://openapi.baidu.com/oauth/2.0/login_success')) { event.preventDefault(); void capture(url); }
      });
      oauthWindow.on('closed', () => {
        if (baiduOAuthWindow !== oauthWindow) return;
        baiduOAuthWindow = null;
        pendingBaiduOAuthState = '';
      });
      await oauthWindow.loadURL(auth.url);
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });
  ipcMain.handle('auth:clearBaiduOAuth', () => { store.clearBaiduOAuth(); mainWindow?.webContents.send('auth:baiduOAuthChanged'); return { ok: true }; });

  // ---------- 登录 ----------
  ipcMain.handle('auth:list', () => store.listAuth());
  ipcMain.handle('auth:setCookie', (_e, platform: SharePlatform, credential: string) => {
    store.saveCredential(platform, credential);
    return { ok: true };
  });
  ipcMain.handle('auth:clear', (_e, platform: SharePlatform) => {
    store.clearCredential(platform);
    return { ok: true };
  });
  ipcMain.handle('auth:verify', async (_e, platform: SharePlatform, credential: string) => {
    try {
      const adapter = getAdapter(platform);
      if (!adapter.fetchNickname) return { ok: true, data: null };
      const nick = await adapter.fetchNickname(credential, {
        http: (url, opts) => fetch(url, opts),
      });
      return { ok: true, data: nick };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /**
   * 打开平台登录页。
   *
   * 与原 Android 版 WebView 登录的差异（重要）：
   *  - 窗口**不会自动关闭**：用户可能要点扫码、短信验证、二次确认，自动关窗会在登录
   *    完成前打断。改为由用户点界面上的「保存登录信息」按钮触发保存，或直接关窗。
   *  - 定时轮询只用于**提示**"检测到登录态，可以保存了"，绝不写库、绝不关窗。
   *  - 关窗不再等同于失败：若此时会话里已有可用 Cookie，照样保存成功。
   */
  ipcMain.handle('auth:openLogin', async (_e, platform: SharePlatform, url: string) => {
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus();
      return { ok: true, data: 'already-open' };
    }

    const host = platformDomainHint(platform);
    loginWindow = new BrowserWindow({
      width: 1080,
      height: 760,
      title: `登录 ${PLATFORM_LABELS[platform]}`,
      parent: mainWindow ?? undefined,
      autoHideMenuBar: true,
      webPreferences: { partition: `persist:login-${platform}` },
    });
    void loginWindow.loadURL(url);

    // 轮询仅做"可以保存了"的提示，不写库、不关窗
    const checkTimer = setInterval(async () => {
      if (!loginWindow || loginWindow.isDestroyed()) return;
      try {
        const cookies = await loginWindow.webContents.session.cookies.get({ domain: host });
        const has = cookies.some((c) => c.value && c.value.length > 8);
        if (has) mainWindow?.webContents.send('auth:loginDetected', platform);
      } catch {
        /* 忽略：仅提示用途 */
      }
    }, 3000);

    loginWindow.on('closed', () => {
      clearInterval(checkTimer);
      loginWindow = null;
      mainWindow?.webContents.send('auth:loginWindowClosed', platform);
    });

    return { ok: true, data: 'opened' };
  });

  /**
   * 从登录窗口的会话中提取 Cookie 并保存。
   * 由界面上的「保存登录信息」按钮调用。
   */
  ipcMain.handle('auth:saveLoginCookies', async (_e, platform: SharePlatform) => {
    try {
      // 优先用当前打开的登录窗口；用户已关窗时回退到该平台的持久化分区
      const ses =
        loginWindow && !loginWindow.isDestroyed()
          ? loginWindow.webContents.session
          : session.fromPartition(`persist:login-${platform}`);

      const host = platformDomainHint(platform);
      // 先按平台域名过滤；若为空再放宽到全部（部分平台 Cookie 挂在 .baidu.com 等上级域）
      let cookies = await ses.cookies.get({ domain: host });
      if (cookies.length === 0) cookies = await ses.cookies.get({});

      const cookieStr = cookies
        .filter((c) => c.value)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

      if (!cookieStr) {
        return {
          ok: false,
          error: `未找到 ${PLATFORM_LABELS[platform]} 的 Cookie，请确认已在登录窗口完成登录`,
        };
      }

      store.saveCredential(platform, cookieStr);
      const cookieCount = cookieStr.split('; ').length;
      return { ok: true, data: { cookieCount, credential: cookieStr } };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  /** 关闭登录窗口（用户主动） */
  ipcMain.handle('auth:closeLogin', () => {
    if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    loginWindow = null;
    return { ok: true };
  });

  /** 在登录窗口内重新加载（登录页偶发白屏时用） */
  ipcMain.handle('auth:reloadLogin', (_e, url?: string) => {
    if (!loginWindow || loginWindow.isDestroyed()) return { ok: false, error: '登录窗口未打开' };
    if (url) void loginWindow.loadURL(url);
    else loginWindow.webContents.reload();
    return { ok: true };
  });

  /**
   * 迅雷账号密码登录。
   * 迅雷的凭据是 4 个字段（accessToken/refreshToken/deviceId/captchaToken），
   * 无法用 Cookie 表示，因此单独走这条链路，序列化成自描述 JSON 存入 credential。
   * 移植自 Kotlin XunleiApi 的 v3/login → captcha/init → v1/auth/signin/token 流程。
   */
  ipcMain.handle('auth:xunleiLogin', async (_e, username: string, password: string) => {
    try {
      const { XunleiApi, serializeXunleiCredential } = await import('./platforms/xunlei/api.js');
      const { XunleiDeviceFingerprint } = await import('./platforms/xunlei/constants.js');
      const ctx = {
        http: (url: string, opts?: any) => fetch(url, opts),
      };
      const api = new XunleiApi(ctx as any);
      const deviceId = XunleiDeviceFingerprint.init().deviceId;
      // 1) 账号密码登录
      const loginRes = await api.loginWithPassword(username, password, deviceId);
      const refreshToken = loginRes.refresh_token ?? loginRes.refreshToken ?? '';
      const userId = loginRes.user_id ?? loginRes.userId ?? '';
      const sessionId = loginRes.sessionID ?? loginRes.sessionId ?? '';

      // 2) 初始化验证码令牌（meta.username 用登录返回的 user_id）
      let captchaToken = '';
      if (userId) {
        captchaToken =
          (await api.initCaptcha(deviceId, userId, 'POST:/auth/signin/token')) ?? '';
      }

      // 3) 用 sessionID 换取 access_token
      let accessToken = loginRes.access_token ?? loginRes.accessToken ?? '';
      if (!accessToken && sessionId) {
        const tk = await api.exchangeToken(sessionId, deviceId, captchaToken);
        accessToken = tk?.[0] ?? '';
      }
      if (!accessToken) {
        return { ok: false, error: '登录失败：未获取到访问令牌（账号或密码错误？）' };
      }

      const credential = serializeXunleiCredential({
        accessToken,
        refreshToken,
        deviceId,
        captchaToken,
      });
      store.saveCredential('XUNLEI', credential, loginRes.nickname || '');
      return { ok: true, data: credential };
    } catch (e: any) {
      logger?.error(`迅雷登录失败: ${e?.message}`);
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  // ---------- 系统 ----------
  ipcMain.handle('sys:readClipboard', () => clipboard.readText());  ipcMain.handle('sys:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    userData: app.getPath('userData'),
  }));
}

/** Cookie 域名匹配提示 */
function platformDomainHint(platform: SharePlatform): string {
  const hints: Record<SharePlatform, string> = {
    QUARK: 'quark.cn',
    UC: 'uc.cn',
    BAIDU: 'baidu.com',
    C139: '139.com',
    XUNLEI: 'xunlei.com',
    PAN123: '123pan',
  };
  return hints[platform] ?? '';
}

app.whenReady().then(() => {
  store = new CredentialStore();
  logger = new LogCollector(join(app.getPath('userData'), 'logs'));
  resolveService = new ResolveService({ store, log: (m) => logger.info(m) });
  taskManager = new TaskManager({
    tempRoot: join(app.getPath('userData'), 'parts'),
    concurrency: store.getSetting<number>('concurrency', 16),
  });

  uploadManager = new UploadManager({
    secureOAuth: () => store.canUseSecureOAuth(),
    getBaiduOAuth: () => {
      const record = store.getBaiduOAuth();
      if (!record) return null;
      return { config: { appName: record.config.appName }, tokens: record.tokens };
    },
    refreshBaiduOAuth: async () => {
      const record = store.getBaiduOAuth();
      if (!record?.tokens?.refreshToken) return null;
      const revision = store.getBaiduOAuthRevision();
      const tokens = await refreshBaiduToken(record.config, record.tokens.refreshToken);
      // 刷新期间用户可能已清除或重新配置 OAuth：代际变化时丢弃结果，避免复活已清除的凭据
      if (!store.saveBaiduOAuthIfCurrent(record.config, tokens, revision)) {
        throw new Error('百度 OAuth 配置已在刷新期间变更，请重新授权');
      }
      return { config: { appName: record.config.appName }, tokens };
    },
  });

  // 转发任务事件到渲染进程
  taskManager.on('progress', (t) => mainWindow?.webContents.send('download:progress', t));
  taskManager.on('done', async (t) => {
    mainWindow?.webContents.send('download:done', t);
    // 下载完成 → 清理平台临时转存目录
    if (t.cleanupDirFid) {
      await resolveService.cleanupTempDir(t.platform, t.cleanupDirFid);
    }
  });
  taskManager.on('error', (t) => mainWindow?.webContents.send('download:error', t));
  uploadManager.on('progress', (t) => mainWindow?.webContents.send('upload:progress', t));
  uploadManager.on('done', (t) => mainWindow?.webContents.send('upload:done', t));
  uploadManager.on('error', (t) => mainWindow?.webContents.send('upload:error', t));

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
