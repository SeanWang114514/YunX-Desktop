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
  upload: {
    selectedFiles: [],
    tasks: [],
    platform: 'BAIDU',
    confirm: false,
    error: '',
    oauth: { secureStorage: false, configured: false, authorized: false, appName: '' },
  },
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

async function refreshUploadTasks() {
  const r = await safeCall(() => api.upload.list(), '获取上传任务失败');
  state.upload.tasks = Array.isArray(r) ? r : state.upload.tasks;
}

async function refreshBaiduOAuth() {
  const r = await safeCall(() => api.auth.baiduOAuthStatus(), '获取百度上传能力失败');
  if (r && typeof r === 'object') state.upload.oauth = { ...state.upload.oauth, ...r };
}

function queueUploadFiles(files) {
  const valid = files.filter((file) => file && file.name && Number.isFinite(file.size));
  state.upload.selectedFiles = valid.map((file) => ({
    fileToken: file.fileToken,
    fileName: file.name,
    size: file.size,
  }));
  state.upload.confirm = valid.length > 0;
  state.upload.error = valid.length ? '' : '未检测到可上传的普通文件';
  state.tab = 'upload';
  void refreshBaiduOAuth().then(render);
  render();
}

async function selectUploadFiles() {
  const result = await safeCall(() => api.upload.pickFiles(), '选择文件失败');
  if (!result?.ok || !Array.isArray(result.data) || result.data.length === 0) return;
  queueUploadFiles(result.data.map((file) => ({
    fileToken: file.fileToken,
    name: file.fileName || '未命名文件',
    size: Number(file.size) || 0,
  })));
}

async function handleDroppedFiles(fileList) {
  const results = await Promise.all(Array.from(fileList).map(async (file) => {
    const result = await api.upload.grantDroppedFile(file);
    if (!result?.ok) return { error: result?.error };
    return { fileToken: result.data.fileToken, name: result.data.fileName, size: result.data.size };
  }));
  const failed = results.filter((file) => file.error);
  queueUploadFiles(results.filter((file) => file.fileToken));
  if (failed.length) {
    state.upload.error = failed.map((file) => file.error).filter(Boolean).join('；') || '拖放文件校验失败';
    render();
  }
}

async function confirmUpload() {
  const selectedFiles = state.upload.selectedFiles;
  if (!selectedFiles.length) return;
  if (state.upload.platform !== 'BAIDU' || !state.upload.oauth.authorized) {
    state.upload.error = '请先配置并授权百度开放平台上传';
    render();
    return;
  }
  const result = await safeCall(
    () => api.upload.add(selectedFiles.map(({ fileToken, fileName }) => ({ fileToken, fileName })), state.upload.platform),
    '添加上传任务失败',
  );
  if (!result?.ok) {
    state.upload.error = result?.error || '添加上传任务失败';
    render();
    return;
  }
  state.upload.confirm = false;
  state.upload.selectedFiles = [];
  state.upload.error = '';
  await refreshUploadTasks();
  state.tab = 'upload';
  render();
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

  html += `<div class="hint" style="font-size:14px;line-height:20px">粘贴分享链接或口令，一键解析分享内容</div>`;

  html += `
    <div class="field field-icon" style="margin-bottom:0">
      ${icon('link')}
      <textarea id="link-input" placeholder="例如：https://pan.quark.cn/s/xxxx、迅雷口令或 139 云盘口令">${esc(r.text)}</textarea>
    </div>
    <div class="m3-field">
      <input type="text" id="pwd-input" value="${esc(r.pwd)}" placeholder=" " />
      <label for="pwd-input">提取码（可选）</label>
    </div>
  `;

  html += `<button class="primary block" id="btn-parse" ${r.loading ? 'disabled' : ''}>
    ${r.loading ? '<span class="spinner"></span> 解析中…' : '开始解析'}
  </button>`;

  html += `<div class="task-actions"><button class="small" id="btn-paste">读取剪贴板</button></div>`;

  html += `<div class="hint">支持夸克 / UC / 迅雷 / 百度 / 139 / 123 云盘 · 自动识别提取码 · 可粘贴带“提取码: xxxx”的整段文案</div>`;

  if (r.error) html += `<div class="alert error">${esc(r.error)}</div>`;

  if (r.loading && !r.result) {
    html += `<div class="empty"><div class="spinner" style="width:28px;height:28px;border-width:3px"></div><div style="margin-top:14px">正在解析…</div></div>`;
  }

  if (r.result) {
    const cur = r.stack[r.stack.length - 1];
    html += `<div class="card">`;
    html += `<div class="card-title">${esc(r.result.title)} <span class="badge">${esc(r.result.shareId)}</span></div>`;

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
        const ic = f.isdir ? '📁' : '📄';
        html += `
          <div class="file-row">
            <span class="file-icon">${ic}</span>
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

/* ---------- 渲染：上传页 ---------- */
function uploadStatusBadge(status) {
  const map = {
    PENDING: ['等待中', ''],
    RUNNING: ['上传中', 'run'],
    COMPLETED: ['已完成', 'ok'],
    FAILED: ['失败', 'err'],
    CANCELLED: ['已取消', ''],
  };
  const [label, cls] = map[status] || [status, ''];
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderUpload() {
  const u = state.upload;
  let html = '<div class="panel">';

  html += `<div class="hint" style="font-size:14px;line-height:20px">把文件拖到窗口中，或点击「选择文件」。文件只会先进入确认流程，点「开始上传」后才会发起网络请求。</div>`;

  html += `<div class="task-actions">
    <button class="primary" data-upload-open>选择文件</button>
    <span class="hint" style="align-self:center">支持多选，任务按顺序上传</span>
  </div>`;

  if (u.error) html += `<div class="alert error">${esc(u.error)}</div>`;

  const ready = u.oauth.secureStorage && u.oauth.configured && u.oauth.authorized;
  if (u.confirm) {
    html += '<div class="card"><div class="card-title">确认上传</div>';
    html += '<div class="file-list">';
    for (const file of u.selectedFiles) {
      html += `<div class="file-row"><span class="file-icon">📄</span><input class="file-name" data-upload-name="${u.selectedFiles.indexOf(file)}" type="text" value="${esc(file.fileName)}" aria-label="上传文件名" style="background:transparent;border:none;padding:0;font-size:14px" /><span class="file-meta">${fmtSize(file.size)}</span></div>`;
    }
    html += '</div>';
    html += `<div class="field" style="margin-top:16px"><label for="upload-platform">上传平台</label><select id="upload-platform">
      <option value="BAIDU" ${u.platform === 'BAIDU' ? 'selected' : ''} ${ready ? '' : 'disabled'}>百度网盘（${ready ? '可用' : '需 OAuth 授权'}）</option>
      <option disabled>夸克网盘（暂无可核验的官方上传接口）</option>
      <option disabled>123 云盘（暂无可核验的官方上传接口）</option>
      <option disabled>139 网盘（暂无可核验的官方上传接口）</option>
      <option disabled>UC 网盘（暂无可核验的官方上传接口）</option>
      <option disabled>迅雷网盘（暂无可核验的官方上传接口）</option>
    </select></div>`;
    html += `<div class="task-actions" style="justify-content:flex-end"><button data-upload-cancel>取消</button><button class="primary" data-upload-confirm ${ready ? '' : 'disabled'}>开始上传</button></div></div>`;
  }

  html += `<div class="card"><div class="card-title">百度开放平台上传</div>
    <div class="task-actions" style="flex-wrap:wrap;margin-bottom:12px">
      <span class="badge ${u.oauth.secureStorage ? 'ok' : 'err'}">安全存储 ${u.oauth.secureStorage ? '可用' : '不可用'}</span>
      <span class="badge ${u.oauth.configured ? 'ok' : 'warn'}">${u.oauth.configured ? esc(u.oauth.appName || '已配置') : '未配置'}</span>
      <span class="badge ${u.oauth.authorized ? 'ok' : 'warn'}">${u.oauth.authorized ? '已授权' : '未授权'}</span>
    </div>
    <div class="hint">上传只使用百度开放平台 OAuth，不复用百度网页登录 Cookie；目标目录固定为授权应用的 /apps/{appname} 根目录，重名时失败且不覆盖。其他平台暂未发现可核验的官方上传接口。</div>
    <div class="row" style="margin-top:16px">
    <div class="m3-field">
      <input type="text" id="baidu-app-key" placeholder=" " autocomplete="off" />
      <label for="baidu-app-key">AppKey</label>
    </div>
    <div class="m3-field">
      <input id="baidu-app-secret" type="password" placeholder=" " autocomplete="new-password" />
      <label for="baidu-app-secret">AppSecret</label>
    </div>
    <div class="m3-field">
      <input id="baidu-app-name" type="text" placeholder=" " autocomplete="off" />
      <label for="baidu-app-name">应用名</label>
    </div>
    </div>
    <div class="hint" style="margin-top:8px">应用名仅限字母、数字、_、-。</div>
    <div class="task-actions"><button data-save-baidu-oauth>保存配置</button><button class="primary" data-start-baidu-oauth ${u.oauth.configured && u.oauth.secureStorage ? '' : 'disabled'}>开始授权</button><button class="danger" data-clear-baidu-oauth ${u.oauth.configured ? '' : 'disabled'}>清除</button></div>
  </div>`;

  html += '<div class="card"><div class="card-title">上传任务</div>';
  if (!u.tasks.length) html += '<div class="empty">暂无上传任务</div>';
  else for (const t of u.tasks) {
    const pct = t.totalBytes > 0 ? Math.min(100, (t.uploadedBytes / t.totalBytes) * 100) : (t.status === 'COMPLETED' ? 100 : 0);
    const fillCls = t.status === 'COMPLETED' ? 'done' : t.status === 'FAILED' ? 'error' : '';
    html += `<div class="task"><div class="task-head"><span class="task-name" title="${esc(t.fileName)}">${esc(t.fileName)}</span>${uploadStatusBadge(t.status)}<div class="task-actions">${t.status === 'PENDING' || t.status === 'RUNNING' ? `<button class="small" data-upload-cancel-task="${esc(t.id)}">取消</button>` : ''}<button class="small danger" data-upload-remove-task="${esc(t.id)}">删除</button></div></div><div class="progress-track"><div class="progress-fill ${fillCls}" style="width:${pct}%"></div></div><div class="task-stats"><span>${fmtSize(t.uploadedBytes)} / ${fmtSize(t.totalBytes)} · ${pct.toFixed(1)}%</span><span>${esc(t.destination)}</span></div>${t.error ? `<div class="alert ${t.status === 'CANCELLED' ? 'info' : 'error'}" style="margin:12px 0 0">${esc(t.error)}</div>` : ''}</div>`;
  }
  html += '</div></div>';
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

  html += `<div class="card"><div class="card-title">网盘账号</div>
    <div class="hint" style="margin-bottom:16px">点击「登录」打开对应网盘官网，完成登录后回到本页点「保存登录信息」。
    登录窗口不会自动关闭，方便你处理扫码/短信验证。凭据使用系统 DPAPI 加密保存在本机。</div>
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
        <div style="margin-bottom:12px">${status}</div>
        ${anon}
        <div class="task-actions" style="margin-top:12px">
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
      <div class="card-title">下载</div>
      <div class="field">
        <div class="row">
          <div class="m3-field">
            <input type="text" id="dir-input" value="${esc(state.settings.downloadDir)}" readonly placeholder=" " />
            <label for="dir-input">下载保存目录</label>
          </div>
          <div class="row-fixed"><button id="btn-pickdir">选择目录</button></div>
        </div>
      </div>
      <div class="field">
        <div class="m3-field">
          <input type="text" id="conc-input" value="${state.settings.concurrency}" placeholder=" " />
          <label for="conc-input">分片并发数（1-64）</label>
        </div>
        <div class="hint" style="margin-top:8px">并发越高下载越快，但过高可能被网盘 CDN 限速。默认 16。</div>
      </div>
      <button class="primary" id="btn-save-settings">保存设置</button>
    </div>
    <div class="card">
      <div class="card-title">关于</div>
      <div class="hint" style="line-height:20px">
        云析 YunX 桌面版 —— 移植自开源项目 CYQawa/YunX（AGPL-3.0）。<br />
        支持夸克 / UC / 迅雷 / 百度 / 139 / 123 云盘分享链接解析与高速下载。<br />
        Range 分片并发 + 断点续传。本程序同样以 AGPL-3.0 开源。
      </div>
    </div>`;
  html += '</div>';
  return html;
}

/**
 * 导航项：与 Kotlin 原版 MainTab 一致（解析 / 账号 / 下载 / 设置），
 * 上传作为同一体系里的第 5 项插在「下载」之后（同属传输任务）。
 */
const NAV_ITEMS = [
  ['resolve', '解析', 'link'],
  ['accounts', '账号', 'cloud'],
  ['download', '下载', 'download'],
  ['upload', '上传', 'upload'],
  ['settings', '设置', 'settings'],
];

/** Material Symbols 轮廓图标（24×24 描边），与原版侧栏观感一致 */
const ICONS = {
  link:
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
    '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
};

function icon(name) {
  return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
      ICONS[name] || ''
    }</svg>`;
}

/* ---------- 主渲染 ---------- */
function render() {
  const current = NAV_ITEMS.find(([key]) => key === state.tab) || NAV_ITEMS[0];

  let html = `<nav class="rail" aria-label="主导航">`;
  for (const [key, label, ic] of NAV_ITEMS) {
    const active = state.tab === key;
    html += `<button class="rail-item ${active ? 'active' : ''}" data-tab="${key}"
      aria-current="${active ? 'page' : 'false'}" title="${label}">
      <span class="rail-icon">${icon(ic)}</span>
      <span class="rail-label">${label}</span>
    </button>`;
  }
  html += '</nav>';

  html += `<div class="workspace">
    <header class="top-bar">
      <h1 class="top-bar-title">${current[1]}</h1>
      <div class="top-bar-actions"></div>
    </header>
    <div class="content">`;

  if (state.toast) html += `<div class="alert ${state.toast.kind}">${esc(state.toast.msg)}</div>`;

  if (state.tab === 'resolve') html += renderResolve();
  else if (state.tab === 'download') html += renderDownload();
  else if (state.tab === 'upload') html += renderUpload();
  else if (state.tab === 'accounts') html += renderAccounts();
  else html += renderSettings();

  html += '</div></div>';
  document.getElementById('app').innerHTML = html;
  bindEvents();
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  document.querySelectorAll('[data-tab]').forEach((el) => {
    el.onclick = () => {
      state.tab = el.dataset.tab;
      if (state.tab === 'download') void refreshTasks().then(render);
      if (state.tab === 'upload') void Promise.all([refreshUploadTasks(), refreshBaiduOAuth()]).then(render);
      render();
    };
  });

  document.querySelectorAll('[data-upload-open]').forEach((el) => {
    el.onclick = () => void selectUploadFiles();
  });

  const uploadPlatform = document.getElementById('upload-platform');
  if (uploadPlatform) uploadPlatform.onchange = (event) => { state.upload.platform = event.target.value; render(); };
  document.querySelectorAll('[data-upload-name]').forEach((el) => {
    el.oninput = (event) => { state.upload.selectedFiles[Number(el.dataset.uploadName)].fileName = event.target.value; };
  });
  const uploadConfirm = document.querySelector('[data-upload-confirm]');
  if (uploadConfirm) uploadConfirm.onclick = () => void confirmUpload();
  const uploadCancel = document.querySelector('[data-upload-cancel]');
  if (uploadCancel) uploadCancel.onclick = () => { state.upload.confirm = false; state.upload.selectedFiles = []; render(); };
  document.querySelectorAll('[data-upload-cancel-task]').forEach((el) => {
    el.onclick = async () => { await api.upload.cancel(el.dataset.uploadCancelTask); await refreshUploadTasks(); render(); };
  });
  document.querySelectorAll('[data-upload-remove-task]').forEach((el) => {
    el.onclick = async () => { await api.upload.remove(el.dataset.uploadRemoveTask); await refreshUploadTasks(); render(); };
  });

  const saveBaiduOAuth = document.querySelector('[data-save-baidu-oauth]');
  if (saveBaiduOAuth) saveBaiduOAuth.onclick = async () => {
    const res = await safeCall(() => api.auth.saveBaiduOAuthConfig({
      appKey: document.getElementById('baidu-app-key').value.trim(),
      appSecret: document.getElementById('baidu-app-secret').value,
      appName: document.getElementById('baidu-app-name').value.trim(),
      redirectUri: 'oob',
    }), '保存百度 OAuth 配置失败');
    if (!res.ok) toast(res.error, 'error');
    else { await refreshBaiduOAuth(); toast('百度 OAuth 配置已保存', 'success'); render(); }
  };
  const startBaiduOAuth = document.querySelector('[data-start-baidu-oauth]');
  if (startBaiduOAuth) startBaiduOAuth.onclick = async () => {
    const res = await safeCall(() => api.auth.startBaiduOAuth(), '启动百度授权失败');
    if (!res.ok) toast(res.error, 'error');
  };
  const clearBaiduOAuth = document.querySelector('[data-clear-baidu-oauth]');
  if (clearBaiduOAuth) clearBaiduOAuth.onclick = async () => {
    const res = await safeCall(() => api.auth.clearBaiduOAuth(), '清除百度 OAuth 失败');
    if (res.ok) { await refreshBaiduOAuth(); toast('百度 OAuth 配置已清除'); render(); }
    else toast(res.error, 'error');
  };

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

function setupGlobalDropHandlers() {
  let dragDepth = 0;
  document.addEventListener('dragenter', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth++;
  });
  document.addEventListener('dragover', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
  });
  document.addEventListener('dragleave', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
  });
  document.addEventListener('drop', (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    dragDepth = 0;
    void handleDroppedFiles(event.dataTransfer.files);
  });
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
  await refreshUploadTasks();
  await refreshBaiduOAuth();
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
  api.upload.onProgress((t) => {
    const i = state.upload.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.upload.tasks[i] = t;
    else state.upload.tasks.push(t);
    if (state.tab === 'upload') render();
  });
  api.upload.onDone((t) => {
    const i = state.upload.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.upload.tasks[i] = t;
    else state.upload.tasks.push(t);
    toast(`上传完成：${t.fileName}`, 'success');
    if (state.tab === 'upload') render();
  });
  api.upload.onError((t) => {
    const i = state.upload.tasks.findIndex((x) => x.id === t.id);
    if (i >= 0) state.upload.tasks[i] = t;
    else state.upload.tasks.push(t);
    toast(`上传失败：${t.fileName}`, 'error');
    if (state.tab === 'upload') render();
  });
  if (api.auth.onBaiduOAuthChanged) api.auth.onBaiduOAuthChanged(() => void refreshBaiduOAuth().then(render));

  // 定时刷新任务进度（兜底）
  setInterval(() => {
    if (state.tab === 'download') void refreshTasks().then(render);
  }, 3000);

  setupGlobalDropHandlers();
  render();
}

void boot();
