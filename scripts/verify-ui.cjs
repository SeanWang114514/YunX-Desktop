/*
 * YunX Desktop —— 渲染层 UI 冒烟测试。
 * 在真实 Electron 窗口里加载构建产物，直接驱动 DOM，
 * 验证四个 tab 均能渲染、无未捕获异常、IPC 桥可用。
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const INDEX = path.join(__dirname, '..', 'dist', 'renderer', 'index.html');

// 用假数据响应渲染层会调用的 IPC（真实 handler 在 main.ts，这里只验证 UI 行为）
const PLATFORMS = [
  { platform: 'QUARK', label: '夸克网盘', requiresAuth: true, canListAnonymous: false, loggedIn: true, nickname: '测试用户' },
  { platform: 'UC', label: 'UC 网盘', requiresAuth: true, canListAnonymous: false, loggedIn: false, nickname: '' },
  { platform: 'XUNLEI', label: '迅雷网盘', requiresAuth: true, canListAnonymous: false, loggedIn: false, nickname: '' },
  { platform: 'BAIDU', label: '百度网盘', requiresAuth: true, canListAnonymous: true, loggedIn: false, nickname: '' },
  { platform: 'C139', label: '139 网盘', requiresAuth: true, canListAnonymous: true, loggedIn: false, nickname: '' },
  { platform: 'PAN123', label: '123 云盘', requiresAuth: true, canListAnonymous: true, loggedIn: false, nickname: '' },
];

ipcMain.handle('platform:list', () => PLATFORMS);
ipcMain.handle('download:list', () => [
  {
    id: 'task-1',
    platform: 'QUARK',
    fid: 'f1',
    fileName: '测试视频.mp4',
    url: 'http://example.com/x',
    dirPath: 'C:\\Downloads',
    totalBytes: 100 * 1024 * 1024,
    downloadedBytes: 42 * 1024 * 1024,
    status: 'RUNNING',
    chunks: 16,
    speedBps: 3 * 1024 * 1024,
    createdAt: Date.now(),
  },
  {
    id: 'task-2',
    platform: 'BAIDU',
    fid: 'f2',
    fileName: '已完成.zip',
    url: 'http://example.com/y',
    dirPath: 'C:\\Downloads',
    totalBytes: 10 * 1024 * 1024,
    downloadedBytes: 10 * 1024 * 1024,
    status: 'COMPLETED',
    chunks: 3,
    speedBps: 0,
    createdAt: Date.now(),
  },
]);
ipcMain.handle('settings:get', (_e, key, fb) => (key === 'concurrency' ? 16 : fb));
ipcMain.handle('settings:set', () => ({ ok: true }));
// 解析：正常返回业务错误；输入 'boom' 时故意抛异常，验证渲染层容错
ipcMain.handle('resolve:parse', (_e, text) => {
  if (text === 'boom') throw new Error('模拟主进程崩溃');
  return { ok: false, error: '无法识别分享链接。支持的平台：夸克 / UC / 迅雷 / 百度 / 139 / 123 云盘' };
});
ipcMain.handle('sys:readClipboard', () => 'https://pan.quark.cn/s/abc123 提取码: a1b2');
ipcMain.handle('sys:info', () => ({ version: '1.0.0' }));
ipcMain.handle('auth:setCookie', () => ({ ok: true }));
ipcMain.handle('auth:clear', () => ({ ok: true }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    // level 3 = error
    if (level >= 3) errors.push(message);
  });

  await win.loadFile(INDEX);
  await new Promise((r) => setTimeout(r, 1500));

  try {
    // 1) 初始渲染
    const initial = await win.webContents.executeJavaScript(`(() => {
      const app = document.getElementById('app');
      return {
        hasApp: !!app,
        text: app ? app.innerText : '',
        tabs: [...document.querySelectorAll('[data-tab]')].map(t => t.dataset.tab),
        title: document.querySelector('.logo')?.textContent || '',
      };
    })()`);
    check('渲染层挂载了 #app', initial.hasApp);
    check('标题显示「云析 YunX」', initial.title.includes('云析'), initial.title);
    check('四个 tab 均存在', JSON.stringify(initial.tabs) === JSON.stringify(['resolve', 'download', 'accounts', 'settings']), initial.tabs.join(','));
    check('解析页显示粘贴提示', initial.text.includes('粘贴分享链接'));
    check('解析页列出支持平台',
      initial.text.includes('夸克') && initial.text.includes('123 云盘'),
      (initial.text.match(/支持[^\n]*/) || ['none'])[0]);

    // 2) 切到下载页
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="download"]').click()`);
    await new Promise((r) => setTimeout(r, 800));
    const dl = await win.webContents.executeJavaScript(`document.getElementById('app').innerText`);
    check('下载页渲染任务名', dl.includes('测试视频.mp4'));
    check('下载页显示进度百分比', dl.indexOf('%') >= 0, (dl.match(/[0-9.]+%/) || ['none'])[0]);
    check('下载页显示分片数', dl.includes('16 分片'), (dl.match(/[0-9]+ 分片/) || ['none'])[0]);
    const speedHit = dl.indexOf('MB/s') >= 0 || dl.indexOf('KB/s') >= 0;
    check('下载页显示速度', speedHit, (dl.match(/[0-9.]+ (MB|KB)\/s/) || ['none'])[0]);
    check('下载页显示状态徽章', dl.includes('下载中') && dl.includes('已完成'));

    // 3) 切到账号页
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="accounts"]').click()`);
    await new Promise((r) => setTimeout(r, 800));
    const ac = await win.webContents.executeJavaScript(`document.getElementById('app').innerText`);
    check('账号页列出全部 6 个平台',
      ['夸克网盘','UC 网盘','迅雷网盘','百度网盘','139 网盘','123 云盘'].every(p => ac.includes(p)),
      ac.includes('迅雷网盘') ? 'ok' : 'missing');
    check('账号页显示已登录徽章', ac.includes('已登录'));
    check('账号页显示昵称', ac.includes('测试用户'));
    check('账号页显示未登录徽章', ac.includes('未登录'));
    check('匿名平台提示可浏览', ac.includes('未登录也可浏览分享列表'));
    check('迅雷使用账号登录按钮', ac.includes('账号登录'));

    // 4) 切到设置页
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="settings"]').click()`);
    await new Promise((r) => setTimeout(r, 800));
    const st = await win.webContents.executeJavaScript(`document.getElementById('app').innerText`);
    check('设置页渲染并发数设置', st.includes('分片并发数'));
    check('设置页渲染下载目录设置', st.includes('下载保存目录'));
    check('设置页显示关于信息', st.includes('AGPL-3.0'));

    // 5) 解析错误路径：handler 返回业务错误 → 界面应显示错误且不卡在 loading
    await win.webContents.executeJavaScript(`document.querySelector('[data-tab="resolve"]').click()`);
    await new Promise((r) => setTimeout(r, 400));
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.getElementById('link-input');
      ta.value = 'https://pan.quark.cn/s/abc123';
      ta.dispatchEvent(new Event('input'));
      document.getElementById('btn-parse').click();
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const afterErr = await win.webContents.executeJavaScript(`document.getElementById('app').innerText`);
    check('解析失败时显示错误提示', afterErr.includes('无法识别分享链接'), (afterErr.match(/无法识别[^\n]*/) || ['none'])[0]);
    check('解析失败后 loading 已复位（按钮恢复可用）',
      await win.webContents.executeJavaScript(`!document.getElementById('btn-parse').disabled`));
    check('解析失败后界面未崩溃',
      await win.webContents.executeJavaScript(`!!document.getElementById('app') && document.getElementById('app').innerText.length > 0`));

    // 6) IPC handler 抛异常时（未注册/异常）界面不应产生未处理 rejection
    const errsBefore = errors.length;
    await win.webContents.executeJavaScript(`(() => {
      const ta = document.getElementById('link-input');
      ta.value = 'boom';
      ta.dispatchEvent(new Event('input'));
      document.getElementById('btn-parse').click();
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    const errsAfter = errors.length;
    check('IPC 抛异常时不产生未处理 rejection', errsAfter === errsBefore,
      errors.slice(errsBefore).slice(0, 2).join(' | '));
    check('IPC 抛异常后 loading 仍复位',
      await win.webContents.executeJavaScript(`!document.getElementById('btn-parse').disabled`));

    console.log('\\n===== SUMMARY =====');
    const failed = results.filter((r) => !r.ok);
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
      console.log('FAILED:');
      failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? ' :: ' + f.detail : '')));
      app.exit(1);
      return;
    }
    app.exit(0);
  } catch (e) {
    console.error('harness error:', e);
    app.exit(2);
  }
});
