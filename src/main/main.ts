/*
 * YunX Desktop (云析桌面版) —— 主进程入口。
 */

import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { CredentialStore } from './store/credentialStore';
import { ResolveService } from './resolve/resolveService';
import { TaskManager } from './download/taskManager';
import { ALL_ADAPTERS, getAdapter } from './platforms';
import { LogCollector } from './util/logCollector';
import type { SharePlatform, ShareFile, DownloadLink } from '../shared/types';
import { PLATFORM_LABELS } from '../shared/linkParser';

let mainWindow: BrowserWindow | null = null;
let store: CredentialStore;
let resolveService: ResolveService;
let taskManager: TaskManager;
let logger: LogCollector;

/** 登录窗口（WebView 式 Cookie 获取） */
let loginWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged;
/** 仅当显式设置 YUNX_DEVTOOLS=1 时打开开发者工具（默认不干扰界面） */
const showDevTools = process.env.YUNX_DEVTOOLS === '1';

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
    backgroundColor: '#0f1115',
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
   * 打开平台登录页，用户登录后从会话中提取 Cookie。
   * 这是 Android 版 WebView Cookie 登录的桌面等价实现。
   */
  ipcMain.handle('auth:openLogin', async (_e, platform: SharePlatform, url: string) => {
    return new Promise((resolve) => {
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
      loginWindow = new BrowserWindow({
        width: 1000,
        height: 720,
        title: `登录 ${PLATFORM_LABELS[platform]}`,
        parent: mainWindow ?? undefined,
        webPreferences: { partition: `persist:login-${platform}` },
      });
      void loginWindow.loadURL(url);

      const finish = async () => {
        if (!loginWindow || loginWindow.isDestroyed()) return;
        try {
          const cookies = await loginWindow.webContents.session.cookies.get({});
          const cookieStr = cookies
            .filter((c) => c.domain && c.domain.includes(platformDomainHint(platform)))
            .map((c) => `${c.name}=${c.value}`)
            .join('; ');
          if (!cookieStr) {
            resolve({ ok: false, error: '未获取到登录 Cookie，请确认已登录成功' });
            return;
          }
          store.saveCredential(platform, cookieStr);
          resolve({ ok: true, data: cookieStr });
        } catch (e: any) {
          resolve({ ok: false, error: e?.message ?? String(e) });
        } finally {
          loginWindow?.close();
          loginWindow = null;
        }
      };

      // 自动检测登录成功后提取 Cookie
      const checkTimer = setInterval(() => {
        void finish().then(() => clearInterval(checkTimer));
      }, 4000);

      loginWindow.on('closed', () => {
        clearInterval(checkTimer);
        resolve({ ok: false, error: '登录窗口已关闭' });
        loginWindow = null;
      });
    });
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

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
