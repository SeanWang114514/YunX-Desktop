/*
 * 登录流程端到端验证（真实 main.ts handler，不打桩）。
 *
 * 断言用户报的两个问题的修复：
 *  1) 打开登录窗口后不会自动关闭 —— 等待远超原先 4 秒轮询周期后窗口仍在；
 *  2) 保存必须显式调用 auth:saveLoginCookies；
 *  3) 关窗不等同失败：仍能从持久化分区取到 Cookie。
 *
 * 做法：直接 require 编译后的真实主进程入口（它会自行注册全部 IPC handler），
 * 再用一个隐藏窗口通过真实 IPC 通道调用，等价于界面点击。
 */

const { app, BrowserWindow, session } = require('electron');
const path = require('node:path');

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHIM = path.join(__dirname, 'p.js');

/** 通过真实 IPC 调用主进程 handler（等价于渲染层 api.xxx()） */
async function invoke(channel, ...args) {
  const w = new BrowserWindow({
    show: false,
    webPreferences: { preload: SHIM, contextIsolation: true, sandbox: false },
  });
  await w.loadURL('about:blank');
  const res = await w.webContents
    .executeJavaScript(`window.__invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`)
    .catch((e) => ({ ok: false, error: 'exec:' + e.message }));
  w.destroy();
  return res;
}

/** 找到登录子窗口（排除测试用的隐藏窗口） */
function findLoginWindow() {
  return BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.getTitle().includes('登录'),
  );
}

// 主进程入口会自行注册 handler；这里只等它就绪
require(path.join(__dirname, '..', 'dist', 'main', 'main.js'));

app.whenReady().then(async () => {
  await sleep(1200);
  try {
    // 1) 打开登录窗口
    let r = await invoke('auth:openLogin', 'BAIDU', 'about:blank');
    check('auth:openLogin 返回 ok', r && r.ok, JSON.stringify(r));
    check('返回值表示「窗口已打开」而非「登录已完成」', r && r.data === 'opened', JSON.stringify(r && r.data));

    const loginWin = findLoginWindow();
    check('登录窗口已创建', !!loginWin, loginWin ? loginWin.getTitle() : '未找到');

    // 2) 关键回归：等 10 秒（远超原先 4 秒自动轮询），窗口必须仍在
    await sleep(10000);
    const stillOpen = !!loginWin && !loginWin.isDestroyed();
    check('等待 10 秒后登录窗口未被自动关闭', stillOpen);
    check('等待 10 秒后窗口仍可聚焦（未进入销毁流程）',
      stillOpen && !loginWin.webContents.isDestroyed());

    // 3) 模拟用户已登录：往该分区写入 Cookie
    const ses = session.fromPartition('persist:login-BAIDU');
    await ses.cookies.set({
      url: 'https://pan.baidu.com/',
      name: 'BDUSS',
      value: 'FAKE_BDUSS_VALUE_FOR_TEST',
      domain: '.baidu.com',
    });
    await sleep(400);

    // 4) 显式保存
    r = await invoke('auth:saveLoginCookies', 'BAIDU');
    check('auth:saveLoginCookies 能取到 Cookie', r && r.ok, JSON.stringify(r).slice(0, 150));
    check('保存返回 Cookie 数量 ≥ 1', r && r.ok && r.data && r.data.cookieCount >= 1,
      r && r.data ? `count=${r.data.cookieCount}` : 'n/a');
    check('凭据包含 BDUSS', r && r.ok && /BDUSS=/.test(r.data.credential || ''),
      r && r.ok && r.data ? r.data.credential.slice(0, 50) : '');

    // 5) 关闭窗口后再保存（走持久化分区回退）
    await invoke('auth:closeLogin');
    await sleep(700);
    check('auth:closeLogin 后登录窗口销毁', !findLoginWindow());
    r = await invoke('auth:saveLoginCookies', 'BAIDU');
    check('关窗后仍可保存（持久化分区回退）', r && r.ok, JSON.stringify(r).slice(0, 110));

    // 6) 从未登录的平台应给可读错误，而非崩溃
    r = await invoke('auth:saveLoginCookies', 'PAN123');
    check('无 Cookie 时返回可读错误',
      r && !r.ok && typeof r.error === 'string' && r.error.length > 0, r && r.error);

    // 7) 重新打开同一平台应复用而非报错
    r = await invoke('auth:openLogin', 'BAIDU', 'about:blank');
    check('可重新打开登录窗口', r && r.ok, JSON.stringify(r));
    await invoke('auth:closeLogin');

    console.log('\n===== SUMMARY =====');
    const failed = results.filter((x) => !x.ok);
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
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

