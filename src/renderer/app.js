/*
 * YunX Desktop (云析桌面版) —— 渲染进程界面。
 * 无框架实现，直接操作 DOM，保持构建轻量。
 */

const api = window.yunx;

/* ---------- 状态 ---------- */
const state = {
  tab: 'resolve',
  platforms: [],
  resolve: {
    text: '',
    pwd: '',
    loading: false,
    error: '',
    result: null,
    /** 目录栈：用于面包屑与返回 */
    stack: [],
  },
  tasks: [],
  settings: { downloadDir: '', concurrency: 16 },
  /**
   * 登录窗口状态。窗口不会自动关闭，用户需要显式点「保存登录信息」。
   * detected: 已在窗口会话里检测到登录 Cookie（仅提示）
   * saved:    已成功写入凭据
   */
  login: { platform: '', detected: false, saved: false },
  toast: '',
};

/* ---------- 工具 ---------- */
function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '';
  return `${fmtSize(bps)}/s`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function statusBadge(status) {
  const map = {
    PENDING: ['等待中', ''],
    RUNNING: ['下载中', 'run'],
    PAUSED: ['已暂停', 'warn'],
    COMPLETED: ['已完成', 'ok'],
    FAILED: ['失败', 'err'],
    CANCELLED: ['已取消', ''],
  };
  const [label, cls] = map[status] || [status, ''];
  return `<span class="badge ${cls}">${label}</span>`;
}

function toast(msg, kind = 'info') {
  state.toast = { msg, kind };
  render();
  setTimeout(() => {
    state.toast = '';
    render();
  }, 4000);
}

/**
 * IPC 调用安全包装。
 * 主进程 handler 正常会返回 {ok:false,error}，但若 handler 本身抛错
 * （未注册 / 序列化失败 / 进程异常），await 会 reject。
 * 不捕获就会变成未处理的 promise rejection，界面会永远卡在 loading。
 */
async function safeCall(fn, fallbackMsg = '操作失败') {
  try {
    return await fn();
  } catch (e) {
    const msg = (e && e.message ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*/, '');
    return { ok: false, error: `${fallbackMsg}：${msg}` };
  }
}

/* ---------- 操作 ---------- */
async function loadPlatforms() {
  const r = await safeCall(() => api.platform.list(), '获取平台列表失败');
  state.platforms = Array.isArray(r) ? r : [];
}

async function doParse() {
  const text = state.resolve.text.trim();
  if (!text) {
    state.resolve.error = '请先粘贴分享链接';
    render();
    return;
  }
  state.resolve.loading = true;
  state.resolve.error = '';
  state.resolve.result = null;
  render();

  const res = await safeCall(
    () => api.resolve.parse(text, state.resolve.pwd || undefined),
    '解析失败',
  );
  state.resolve.loading = false;
  if (res.ok) {
    state.resolve.result = res.data;
    state.resolve.stack = [{ fid: '0', name: '根目录', files: res.data.files }];
  } else {
    state.resolve.error = res.error || '解析失败';
  }
  render();
}

async function enterDir(file) {
  const r = state.resolve;
  if (!r.result) return;
  r.loading = true;
  render();
  const res = await safeCall(
    () => api.resolve.listDir(r.result.platform, r.result.shareId, file.fid, r.text),
    '打开文件夹失败',
  );
  r.loading = false;
  if (res.ok) {
    r.stack.push({ fid: file.fid, name: file.fname, files: res.data });
  } else {
    r.error = res.error;
  }
  render();
}

function gotoBreadcrumb(index) {
  state.resolve.stack = state.resolve.stack.slice(0, index + 1);
  render();
}

async function downloadFile(file) {
  const r = state.resolve;
  if (!r.result) return;
  toast(`正在获取直链：${file.fname}`);
  const linkRes = await safeCall(
    () => api.resolve.getLink(r.result.platform, r.result.shareId, file, r.text),
    '取链失败',
  );
  if (!linkRes.ok) {
    toast(`取链失败：${linkRes.error}`, 'error');
    return;
  }
  const addRes = await safeCall(
    () =>
      api.download.add(
        r.result.platform,
        r.result.shareId,
        file,
        linkRes.data,
        state.settings.downloadDir || undefined,
        r.text,
      ),
    '添加下载失败',
  );
  if (addRes.ok) {
    toast(`已加入下载：${file.fname}`, 'success');
    state.tab = 'download';
    render();
  } else {
    toast(`添加失败：${addRes.error}`, 'error');
  }
}

async function refreshTasks() {
  const r = await safeCall(() => api.download.list(), '获取任务列表失败');
  state.tasks = Array.isArray(r) ? r : state.tasks;
}

async function loadSettings() {
  const dir = await safeCall(() => api.settings.get('downloadDir', ''), '读取设置失败');
  state.settings.downloadDir = typeof dir === 'string' ? dir : '';
  const conc = await safeCall(() => api.settings.get('concurrency', 16), '读取设置失败');
  state.settings.concurrency = typeof conc === 'number' ? conc : 16;
}

/* ---------- 渲染：解析页 ---------- */
function renderResolve() {
  const r = state.resolve;
  let html = '<div class="panel">';

  html += `
    <div class="card">
      <div class="card-title">🔗 粘贴分享链接</div>
      <div class="field">
        <textarea id="link-input" placeholder="粘贴分享链接或整段分享文案（含提取码）">${esc(r.text)}</textarea>
        <div class="hint">支持夸克 / UC / 迅雷 / 百度 / 139 / 123 云盘 · 自动识别提取码 · 可粘贴带“提取码: xxxx”的整段文案</div>
      </div>
      <div class="row">
        <div class="field" style="flex:0 0 180px;margin-bottom:0">
          <label>提取码（可选）</label>
          <input type="text" id="pwd-input" value="${esc(r.pwd)}" placeholder="自动识别" />
        </div>
        <div style="flex:0 0 auto">
          <button class="primary" id="btn-parse" ${r.loading ? 'disabled' : ''}>
            ${r.loading ? '<span class="spinner"></span> 解析中…' : '开始解析'}
          </button>
        </div>
        <div style="flex:0 0 auto">
          <button id="btn-paste">读取剪贴板</button>
        </div>
      </div>
    </div>
  `;

  if (r.error) html += `<div class="alert error">⚠ ${esc(r.error)}</div>`;

  if (r.loading && !r.result) {
    html += `<div class="empty"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><div style="margin-top:14px">正在解析…</div></div>`;
  }

  if (r.result) {
    const cur = r.stack[r.stack.length - 1];
    html += `<div class="card">`;
    html += `<div class="card-title">📁 ${esc(r.result.title)} <span class="badge">${esc(r.result.shareId)}</span></div>`;

    if (r.stack.length > 1) {
      html += '<div class="breadcrumb">';
      r.stack.forEach((lvl, i) => {
        if (i > 0) html += '<span style="cursor:default">/</span>';
        html += `<span data-crumb="${i}">${esc(lvl.name)}</span>`;
      });
      html += '</div>';
    }

    if (!cur || cur.files.length === 0) {
      html += `<div class="empty">该目录为空</div>`;
    } else {
      html += '<div class="file-list">';
      for (const f of cur.files) {
        const icon = f.isdir ? '📁' : '📄';
        html += `
          <div class="file-row">
            <span class="file-icon">${icon}</span>
            <span class="file-name ${f.isdir ? 'dir' : ''}" data-dir='${f.isdir ? esc(JSON.stringify(f)) : ''}'
                  data-file='${f.isdir ? '' : esc(JSON.stringify(f))}'>${esc(f.fname)}</span>
            <span class="file-meta">${f.isdir ? '文件夹' : fmtSize(f.fsize)}</span>
            ${
              f.isdir
                ? ''
                : `<button class="small primary" data-dl='${esc(JSON.stringify(f))}'>下载</button>`
            }
          </div>`;
      }
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

/* ---------- 渲染：下载页 ---------- */
function renderDownload() {
  let html = '<div class="panel">';

  if (state.tasks.length === 0) {
    html += `<div class="empty"><div class="empty-icon">📥</div><div>暂无下载任务</div><div class="hint">到「解析」页粘贴分享链接开始下载</div></div>`;
  } else {
    for (const t of state.tasks) {
      const pct =
        t.totalBytes > 0 ? Math.min(100, (t.downloadedBytes / t.totalBytes) * 100) : 0;
      const fillCls =
        t.status === 'COMPLETED' ? 'done' : t.status === 'FAILED' ? 'error' : '';
      const canPause = t.status === 'RUNNING';
      const canResume = t.status === 'PAUSED' || t.status === 'FAILED';
      const canOpen = t.status === 'COMPLETED';

      html += `
        <div class="task">
          <div class="task-head">
            <span class="task-name" title="${esc(t.fileName)}">${esc(t.fileName)}</span>
            ${statusBadge(t.status)}
            <div class="task-actions">
              ${canPause ? `<button class="small" data-pause="${t.id}">暂停</button>` : ''}
              ${canResume ? `<button class="small" data-resume="${t.id}">继续</button>` : ''}
              ${canOpen ? `<button class="small" data-open="${t.id}">打开</button>` : ''}
              ${canOpen ? `<button class="small" data-folder="${t.id}">目录</button>` : ''}
              <button class="small danger" data-remove="${t.id}">删除</button>
            </div>
          </div>
          <div class="progress-track">
            <div class="progress-fill ${fillCls}" style="width:${pct}%"></div>
          </div>
          <div class="task-stats">
            <span>${fmtSize(t.downloadedBytes)} / ${fmtSize(t.totalBytes)} · ${pct.toFixed(1)}%${
              t.chunks > 1 ? ` · ${t.chunks} 分片` : ''
            }</span>
            <span>${t.status === 'RUNNING' ? fmtSpeed(t.speedBps) : ''}</span>
          </div>
          ${t.error ? `<div class="alert error" style="margin:10px 0 0">${esc(t.error)}</div>` : ''}
        </div>`;
    }
  }

  html += '</div>';
  return html;
}

/* ---------- 渲染：账号页 ---------- */
function renderAccounts() {
  let html = '<div class="panel">';

  // 登录窗口状态条：窗口不会自动关闭，保存必须由用户点击触发
  if (state.login.platform) {
    const LP = PLATFORM_LABELS[state.login.platform] || state.login.platform;
    const tip = state.login.saved
      ? '✅ 已保存，可以关闭登录窗口了。'
      : state.login.detected
        ? '🔔 检测到登录态，点右侧「保存登录信息」写入。'
        : '请在登录窗口中完成登录（可能需扫码或短信验证）。登录窗口不会自动关闭。';
    html += `
      <div class="login-bar">
        <div class="login-bar-text">
          <b>登录窗口已打开：${esc(LP)}</b>
          <div class="hint" style="margin-top:4px">${esc(tip)}</div>
        </div>
        <div class="login-bar-actions">
          <button class="primary" data-save-login="${state.login.platform}" id="btn-save-login">保存登录信息</button>
          <button data-reload-login="${state.login.platform}" id="btn-reload-login">重新加载</button>
          <button id="btn-close-login">关闭窗口</button>
        </div>
      </div>`;
  }

  html += `<div class="card"><div class="card-title">👤 网盘账号</div>
    <div class="hint" style="margin-bottom:14px">点击「登录」打开对应网盘官网，完成登录后回到本页点<b>「保存登录信息」</b>。
    登录窗口<b>不会自动关闭</b>，方便你处理扫码/短信验证。凭据使用系统 DPAPI 加密保存在本机。</div>
    <div class="grid-2">`;

  for (const p of state.platforms) {
    const status = p.loggedIn
      ? `<span class="badge ok">已登录${p.nickname ? ' · ' + esc(p.nickname) : ''}</span>`
      : `<span class="badge warn">未登录</span>`;
    const anon = p.canListAnonymous ? '<div class="hint">未登录也可浏览分享列表</div>' : '';
    // 迅雷凭据是 JWT（非 Cookie），走账号密码登录而非网页登录
    const primaryBtn =
      p.platform === 'XUNLEI'
        ? `<button class="small primary" data-xl-login="1">账号登录</button>`
        : `<button class="small primary" data-login="${p.platform}">登录</button>`;
    html += `
      <div class="card" style="margin-bottom:0">
        <div class="card-title" style="font-size:14px">${esc(p.label)}</div>
        <div style="margin-bottom:10px">${status}</div>
        ${anon}
        <div class="task-actions" style="margin-top:10px">
          ${primaryBtn}
          <button class="small" data-manual="${p.platform}">手动填凭据</button>
          ${p.loggedIn ? `<button class="small danger" data-logout="${p.platform}">退出</button>` : ''}
        </div>
      </div>`;
  }
  html += '</div></div></div>';
  return html;
}

/* ---------- 渲染：设置页 ---------- */
function renderSettings() {
  let html = '<div class="panel">';
  html += `
    <div class="card">
      <div class="card-title">⚙ 设置</div>
      <div class="field">
        <label>下载保存目录</label>
        <div class="row">
          <input type="text" id="dir-input" value="${esc(state.settings.downloadDir)}" readonly
                 placeholder="默认：下载/YunX" />
          <div style="flex:0 0 auto"><button id="btn-pickdir">选择目录</button></div>
        </div>
      </div>
      <div class="field">
        <label>分片并发数（1-64）</label>
        <input type="text" id="conc-input" value="${state.settings.concurrency}" />
        <div class="hint">并发越高下载越快，但过高可能被网盘 CDN 限速。默认 16。</div>
      </div>
      <button class="primary" id="btn-save-settings">保存设置</button>
    </div>
    <div class="card">
      <div class="card-title">ℹ 关于</div>
      <div class="hint" style="line-height:1.8">
        云析 YunX 桌面版 —— 移植自开源项目
        <b>CYQawa/YunX</b>（AGPL-3.0）。<br />
        支持夸克 / UC / 迅雷 / 百度 / 139 / 123 云盘分享链接解析与高速下载。<br />
        Range 分片并发 + 断点续传。本程序同样以 AGPL-3.0 开源。
      </div>
    </div>`;
  html += '</div>';
  return html;
}

/* ---------- 主渲染 ---------- */
function render() {
  const tabs = [
    ['resolve', '解析'],
    ['download', '下载'],
    ['accounts', '账号'],
    ['settings', '设置'],
  ];

  let html = `
    <div class="titlebar">
      <span class="logo">云析 YunX</span>
      <span class="logo-sub">桌面版 · 粘贴分享链接，直接高速下载</span>
    </div>
    <div class="tabs">
      ${tabs
        .map(
          ([k, label]) =>
            `<button class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${label}</button>`,
        )
        .join('')}
    </div>
    <div class="content">`;

  if (state.toast) {
    html += `<div class="panel"><div class="alert ${state.toast.kind}">${esc(state.toast.msg)}</div></div>`;
  }

  if (state.tab === 'resolve') html += renderResolve();
  else if (state.tab === 'download') html += renderDownload();
  else if (state.tab === 'accounts') html += renderAccounts();
  else html += renderSettings();

  html += '</div>';
  document.getElementById('app').innerHTML = html;
  bindEvents();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((el) => {
    el.onclick = () => {
      state.tab = el.dataset.tab;
      if (state.tab === 'download') void refreshTasks().then(render);
      render();
    };
  });

  const linkInput = document.getElementById('link-input');
  if (linkInput) {
    linkInput.oninput = (e) => (state.resolve.text = e.target.value);
  }
  const pwdInput = document.getElementById('pwd-input');
  if (pwdInput) {
    pwdInput.oninput = (e) => (state.resolve.pwd = e.target.value);
  }

  const btnParse = document.getElementById('btn-parse');
  if (btnParse) btnParse.onclick = () => void doParse();

  const btnPaste = document.getElementById('btn-paste');
  if (btnPaste) {
    btnPaste.onclick = async () => {
      const txt = await safeCall(() => api.sys.readClipboard(), '读取剪贴板失败');
      if (typeof txt === 'string' && txt) {
        state.resolve.text = txt;
        render();
      } else {
        toast('剪贴板为空', 'error');
      }
    };
  }

  document.querySelectorAll('[data-crumb]').forEach((el) => {
    el.onclick = () => gotoBreadcrumb(Number(el.dataset.crumb));
  });

  document.querySelectorAll('[data-dir]').forEach((el) => {
    const raw = el.dataset.dir;
    if (!raw) return;
    el.onclick = () => void enterDir(JSON.parse(raw));
  });

  document.querySelectorAll('[data-dl]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      void downloadFile(JSON.parse(el.dataset.dl));
    };
  });

  document.querySelectorAll('[data-pause]').forEach((el) => {
    el.onclick = async () => {
      await api.download.pause(el.dataset.pause);
      await refreshTasks();
      render();
    };
  });
  document.querySelectorAll('[data-resume]').forEach((el) => {
    el.onclick = async () => {
      await api.download.resume(el.dataset.resume);
      await refreshTasks();
      render();
    };
  });
  document.querySelectorAll('[data-remove]').forEach((el) => {
    el.onclick = async () => {
      await api.download.remove(el.dataset.remove);
      await refreshTasks();
      render();
    };
  });
  document.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = () => void api.download.openFile(el.dataset.open);
  });
  document.querySelectorAll('[data-folder]').forEach((el) => {
    el.onclick = () => void api.download.openFolder(el.dataset.folder);
  });

  document.querySelectorAll('[data-login]').forEach((el) => {
    el.onclick = async () => {
      const platform = el.dataset.login;
      const res = await safeCall(
        () => api.auth.openLogin(platform, LOGIN_URLS[platform] || 'about:blank'),
        '打开登录窗口失败',
      );
      if (res.ok) {
        state.login = { platform, detected: false, saved: false };
        toast('已打开登录窗口。登录完成后点「保存登录信息」即可。');
        render();
      } else {
        toast(`无法打开登录窗口：${res.error}`, 'error');
      }
    };
  });

  // 登录窗口内检测到登录态 → 只做提示，等待用户点保存
  const btnSaveLogin = document.getElementById('btn-save-login');
  if (btnSaveLogin) {
    btnSaveLogin.onclick = async () => {
      const platform = btnSaveLogin.dataset.saveLogin;
      if (!platform) return;
      const res = await safeCall(() => api.auth.saveLoginCookies(platform), '保存登录信息失败');
      if (res.ok) {
        state.login.saved = true;
        await loadPlatforms();
        toast(`已保存登录信息（${res.data.cookieCount} 项 Cookie）`, 'success');
        render();
      } else {
        toast(res.error, 'error');
      }
    };
  }

  const btnCloseLogin = document.getElementById('btn-close-login');
  if (btnCloseLogin) {
    btnCloseLogin.onclick = async () => {
      await safeCall(() => api.auth.closeLogin(), '关闭登录窗口失败');
      state.login = { platform: '', detected: false, saved: false };
      render();
    };
  }

  const btnReloadLogin = document.getElementById('btn-reload-login');
  if (btnReloadLogin) {
    btnReloadLogin.onclick = async () => {
      const p = btnReloadLogin.dataset.reloadLogin;
      const res = await safeCall(
        () => api.auth.reloadLogin(LOGIN_URLS[p] || undefined),
        '重新加载失败',
      );
      if (!res.ok) toast(res.error, 'error');
    };
  }

  document.querySelectorAll('[data-manual]').forEach((el) => {
    el.onclick = async () => {
      const platform = el.dataset.manual;
      const hint =
        platform === 'XUNLEI'
          ? '粘贴迅雷凭据（JSON：accessToken/refreshToken/deviceId/captchaToken，或 a|r|d|c 格式）：'
          : `粘贴 ${platform} 的 Cookie 串：`;
      const val = window.prompt(hint);
      if (!val) return;
      const res = await safeCall(() => api.auth.setCookie(platform, val.trim()), '保存凭据失败');
      if (!res.ok) {
        toast(res.error, 'error');
        return;
      }
      await loadPlatforms();
      toast('凭据已保存', 'success');
      render();
    };
  });

  document.querySelectorAll('[data-xl-login]').forEach((el) => {
    el.onclick = async () => {
      const username = window.prompt('迅雷账号（手机号/邮箱）：');
      if (!username) return;
      const password = window.prompt('迅雷密码：');
      if (!password) return;
      toast('正在登录迅雷…');
      const res = await safeCall(
        () => api.auth.xunleiLogin(username.trim(), password),
        '迅雷登录失败',
      );
      if (res.ok) {
        await loadPlatforms();
        toast('迅雷登录成功', 'success');
        render();
      } else {
        toast(`迅雷登录失败：${res.error}`, 'error');
      }
    };
  });

  document.querySelectorAll('[data-logout]').forEach((el) => {
    el.onclick = async () => {
      await safeCall(() => api.auth.clear(el.dataset.logout), '退出登录失败');
      await loadPlatforms();
      toast('已退出登录');
      render();
    };
  });

  const btnPickDir = document.getElementById('btn-pickdir');
  if (btnPickDir) {
    btnPickDir.onclick = async () => {
      const res = await safeCall(() => api.settings.pickDir(), '选择目录失败');
      if (res.ok) {
        state.settings.downloadDir = res.data;
        render();
      }
    };
  }

  const btnSave = document.getElementById('btn-save-settings');
  if (btnSave) {
    btnSave.onclick = async () => {
      const dir = document.getElementById('dir-input').value.trim();
      const conc = Number(document.getElementById('conc-input').value) || 16;
      const clamped = Math.max(1, Math.min(64, conc));
      await safeCall(() => api.settings.set('downloadDir', dir), '保存设置失败');
      await safeCall(() => api.settings.set('concurrency', clamped), '保存设置失败');
      state.settings.concurrency = clamped;
      toast('设置已保存（并发数重启后生效）', 'success');
    };
  }
}

/** 各平台登录页 */
const LOGIN_URLS = {
  QUARK: 'https://pan.quark.cn/?fr=pc&platform=pc',
  UC: 'https://drive.uc.cn/',
  BAIDU: 'https://pan.baidu.com/',
  C139: 'https://yun.139.com/',
  XUNLEI: 'https://pan.xunlei.com/',
  PAN123: 'https://www.123pan.com/',
};

/** 平台中文名（渲染层本地副本，避免额外 IPC 往返） */
const PLATFORM_LABELS = {
  QUARK: '夸克网盘',
  UC: 'UC 网盘',
  BAIDU: '百度网盘',
  C139: '139 网盘',
  XUNLEI: '迅雷网盘',
  PAN123: '123 云盘',
};

/* ---------- 启动 ---------- */
async function boot() {
  await loadPlatforms();
  await refreshTasks();
  await loadSettings();

  // 登录窗口事件：检测到登录态只提示，保存必须用户点击
  if (api.auth.onLoginDetected) {
    api.auth.onLoginDetected((platform) => {
      if (state.login.platform === platform && !state.login.detected) {
        state.login.detected = true;
        if (state.tab === 'accounts') render();
      }
    });
  }
  if (api.auth.onLoginWindowClosed) {
    api.auth.onLoginWindowClosed((platform) => {
      if (state.login.platform === platform && !state.login.saved) {
        toast('登录窗口已关闭，若已完成登录请重新打开并点「保存登录信息」');
      }
      state.login.platform = '';
      if (state.tab === 'accounts') render();
    });
  }

  api.download.onProgress((t) => {
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t;
    else state.tasks.push(t);
    if (state.tab === 'download') render();
  });
  api.download.onDone((t) => {
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t;
    toast(`下载完成：${t.fileName}`, 'success');
    if (state.tab === 'download') render();
  });
  api.download.onError((t) => {
    const i = state.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.tasks[i] = t;
    toast(`下载失败：${t.fileName}`, 'error');
    if (state.tab === 'download') render();
  });

  // 定时刷新任务进度（兜底）
  setInterval(() => {
    if (state.tab === 'download') void refreshTasks().then(render);
  }, 3000);

  render();
}

void boot();
