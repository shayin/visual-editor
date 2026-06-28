// app.js — Visual Editor 前端主逻辑
// 完整功能：可拖拽分栏 / 元素检查器 / 文件浏览侧栏 / 三种选区模式 /
//          Toast / 设置持久化 / 主题切换 / 快捷键 / 状态栏

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ============ 状态 ============
const state = {
  currentFile: null,
  selections: [],
  mode: 'point',
  inspectorOpen: false,
  settings: loadSettings(),
  recent: loadRecent(),
  wsReady: false,
  currentInspectorSel: null,
};

function loadSettings() {
  const def = {
    claudeCommand: '',
    format: 'xml',
    autofocus: true,
    autoInspector: true,
    autoRefresh: true,
    showStatusbar: true,
    theme: 'dark',
  };
  try {
    return { ...def, ...JSON.parse(localStorage.getItem('ve-settings') || '{}') };
  } catch { return def; }
}
function saveSettings() { localStorage.setItem('ve-settings', JSON.stringify(state.settings)); }

function loadRecent() {
  try { return JSON.parse(localStorage.getItem('ve-recent') || '[]'); } catch { return []; }
}
function saveRecent() { localStorage.setItem('ve-recent', JSON.stringify(state.recent)); }

function pushRecent(file) {
  const exists = state.recent.findIndex((r) => r.path === file);
  if (exists >= 0) state.recent.splice(exists, 1);
  let meta = { name: file.split('/').pop() };
  fetch(`/api/file-info?file=${encodeURIComponent(file)}`).then(r => r.json()).then(info => {
    if (info.basename) {
      const idx = state.recent.findIndex((r) => r.path === file);
      if (idx >= 0) {
        state.recent[idx].name = info.basename;
        state.recent[idx].size = info.size;
        state.recent[idx].mtime = info.mtime;
        saveRecent(); renderRecent();
      }
    }
  }).catch(() => {});
  state.recent.unshift({ path: file, name: meta.name, ts: Date.now() });
  if (state.recent.length > 20) state.recent.length = 20;
  saveRecent();
  renderRecent();
}

// ============ DOM refs ============
const fileInput = $('#fileInput');
const loadBtn = $('#loadBtn');
const copyPathBtn = $('#copyPathBtn');
const previewWrap = $('#previewWrap');
const queueList = $('#queueList');
const selCount = $('#selCount');
const queueCount = $('#queueCount');
const modeStatus = $('#modeStatus');
const modeHint = $('#modeHint');
const previewStatus = $('#previewStatus');
const fileName = $('#fileName');
const fileStatusItem = $('#fileStatusItem');
const wsDot = $('#wsDot');
const wsStatus = $('#wsStatus');
const claudeCmd = $('#claudeCmd');
const inspector = $('#inspector');
const queueDrawer = $('#queueDrawer');
const main = $('#main');
const toastContainer = $('#toastContainer');

// ============ Theme ============
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  $('#themeToggle').innerHTML = state.settings.theme === 'dark'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
}
applyTheme();

// ============ Toast ============
function toast(opts) {
  if (typeof opts === 'string') opts = { msg: opts };
  const { type = 'info', title, msg, duration = 3000 } = opts;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const iconMap = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };
  el.innerHTML = `
    <div class="toast-icon">${iconMap[type] || iconMap.info}</div>
    <div class="toast-content">
      ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
      ${msg ? `<div class="toast-msg">${escapeHtml(msg)}</div>` : ''}
    </div>
  `;
  toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 300);
  }, duration);
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ============ WebSocket ============
let ws;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.addEventListener('open', () => {
    state.wsReady = true;
    wsDot.className = 'status-dot connected';
    wsStatus.textContent = '已连接';
    if (state.currentFile) sendWs({ type: 'watch', file: state.currentFile });
  });
  ws.addEventListener('close', () => {
    state.wsReady = false;
    wsDot.className = 'status-dot disconnected';
    wsStatus.textContent = '断开,重连中...';
    setTimeout(connectWs, 1500);
  });
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pty:out') {
      term.write(msg.data);
    } else if (msg.type === 'pty:exit') {
      term.write(`\r\n\x1b[33m[claude exited code=${msg.code}]\x1b[0m\r\n`);
      toast({ type: msg.code === 0 ? 'success' : 'warning', title: 'Claude 进程退出', msg: `code=${msg.code}` });
    } else if (msg.type === 'pty:error') {
      $('#termStatus').textContent = 'PTY 失败';
      term.write(`\r\n\x1b[31m[Claude 启动失败]\x1b[0m ${msg.msg}\r\n`);
      term.write(`\x1b[90m常见原因：node-pty 在当前环境受限。\x1b[0m\r\n`);
      term.write(`\x1b[90m请在普通终端运行 npm start 而非沙盒环境。\x1b[0m\r\n`);
      toast({ type: 'error', title: 'Claude 终端启动失败', msg: msg.msg, duration: 6000 });
    } else if (msg.type === 'pty:mem-warn') {
      toast({
        type: 'warning',
        title: 'Claude 进程内存吃紧',
        msg: `子进程已占 ${msg.mb}MB，建议点终端右上角「重启」按钮释放内存，否则系统可能强杀整个 server。`,
        duration: 10000,
      });
    } else if (msg.type === 'selection') {
      handleSelection(msg.payload);
    } else if (msg.type === 'file:changed') {
      console.log('[ws] file:changed', msg.file, 'autoRefresh=', state.settings.autoRefresh);
      if (state.settings.autoRefresh) {
        wsDot.className = 'status-dot refreshing';
        wsStatus.textContent = '文件变化,刷新中';
        setTimeout(() => {
          $('#previewIframe').src = `/api/render?file=${encodeURIComponent(state.currentFile)}&t=${Date.now()}`;
          wsDot.className = 'status-dot connected';
          wsStatus.textContent = '已连接';
        }, 150); // 让写盘完成
      }
    }
  });
}
function sendWs(obj) {
  if (state.wsReady && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ============ Terminal ============
const term = new Terminal({
  fontFamily: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace',
  fontSize: 13,
  lineHeight: 1.3,
  cursorBlink: true,
  allowProposedApi: true,
  theme: {
    background: '#0a0c10',
    foreground: '#e6e9ef',
    cursor: '#6366f1',
    selectionBackground: 'rgba(99, 102, 241, 0.35)',
    black: '#0a0c10', red: '#ef4444', green: '#10b981', yellow: '#f59e0b',
    blue: '#3b82f6', magenta: '#ec4899', cyan: '#06b6d4', white: '#e6e9ef',
    brightBlack: '#6c7585', brightRed: '#fca5a5', brightGreen: '#86efac',
    brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#f9a8d4',
    brightCyan: '#67e8f9', brightWhite: '#ffffff',
  },
});
const fitAddon = new FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open($('#terminal'));
setTimeout(() => fitAddon.fit(), 60);

// Shift+Enter → 换行（用 bracketed paste mode 包裹 \n，绕过 kitty 依赖）
// Enter → 保持默认（发 \r，Claude CLI 触发提交）
// 注意：IME composition 期间所有按键都不拦截，否则会破坏中文输入
//
// macOS 中文输入法「中文标点直接转换」bug 修复：
// 按 , . ; : 等标点键时，IME 不进入 composition，直接把字符替换成全角
// 但 xterm 在 keydown 阶段就发送 ASCII 字符，绕过 IME。
// 解决：标点键在 keydown 时 return false（让 xterm 不发），
// xterm 会回退到 textarea 的 input 事件路径，input 事件拿到的是 IME 处理后的最终字符。
const IME_PUNCT_CODES = new Set([
  'Comma', 'Period', 'Semicolon', 'Quote', 'Slash',
  'BracketLeft', 'BracketRight', 'Backquote', 'Minus', 'Equal',
]);
term.attachCustomKeyEventHandler((ev) => {
  // IME 组合中（keyCode 229 或 isComposing）放行，让 composition 走正常路径
  if (ev.isComposing || ev.keyCode === 229) return true;
  if (ev.type === 'keydown' && ev.key === 'Enter') {
    if (ev.shiftKey) {
      // ESC[200~ ... ESC[201~ 是 bracketed paste 序列
      // Claude CLI 会把包裹内容当作"粘贴"插入，不触发提交
      sendWs({ type: 'pty:in', data: '\x1b[200~\n\x1b[201~' });
      return false;
    }
  }
  // 标点键 return false → 强制走 input 事件路径，让 IME 有机会转换
  // 英文输入下 input 事件也会拿到字符，不影响英文标点
  if (ev.type === 'keydown' && IME_PUNCT_CODES.has(ev.code)) {
    return false;
  }
  return true;
});

term.onData((data) => sendWs({ type: 'pty:in', data }));
term.onResize(({ cols, rows }) => sendWs({ type: 'pty:resize', cols, rows }));

window.addEventListener('resize', () => fitAddon.fit());

// ============ File loading ============
function loadFile(file) {
  if (!file) return;
  fetch(`/api/file-info?file=${encodeURIComponent(file)}`).then(r => {
    if (!r.ok) throw new Error('文件不存在');
    return r.json();
  }).then(info => {
    state.currentFile = file;
    localStorage.setItem('ve-current-file', file); // 持久化，刷新后恢复
    previewWrap.classList.remove('no-file');
    previewWrap.innerHTML = `<iframe id="previewIframe" class="preview-iframe" src="/api/render?file=${encodeURIComponent(file)}&t=${Date.now()}"></iframe>
      <div class="preview-hint"><span id="hintText">按住 <kbd>Option</kbd> + 点击元素</span></div>`;
    updateModeHint();
    sendWs({ type: 'watch', file });
    pushRecent(file);
    fileStatusItem.style.display = 'flex';
    fileName.textContent = info.basename;
    previewStatus.textContent = '已加载';
    fileInput.value = file;
    copyPathBtn.disabled = false;
    toast({ type: 'success', title: '文件已加载', msg: info.basename, duration: 2000 });
  }).catch(err => {
    toast({ type: 'error', title: '加载失败', msg: err.message });
  });
}

loadBtn.addEventListener('click', () => loadFile(fileInput.value.trim()));
fileInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFile(fileInput.value.trim()); });
fileInput.addEventListener('paste', () => {
  // 粘贴后稍等 value 更新再加载
  setTimeout(() => loadFile(fileInput.value.trim()), 0);
});

copyPathBtn.addEventListener('click', async () => {
  const p = fileInput.value.trim();
  if (!p) return;
  try {
    await navigator.clipboard.writeText(p);
    toast({ type: 'success', title: '路径已复制', msg: p, duration: 2000 });
  } catch (e) {
    fileInput.select();
    document.execCommand('copy');
    toast({ type: 'success', title: '路径已复制', msg: p, duration: 2000 });
  }
});

// ============ File Browser Modal ============
const browserModal = $('#browserModal');
const browserList = $('#browserList');
const browserBreadcrumb = $('#browserBreadcrumb');
const browserAddr = $('#browserAddr');
const browserSelected = $('#browserSelected');
const browserConfirm = $('#browserConfirm');
const browserQuick = $('#browserQuick');
let browserCurrentDir = null;
let browserSelectedFile = null;

async function browseDir(dir) {
  browserCurrentDir = dir;
  browserList.innerHTML = '<div class="browser-loading">加载中...</div>';
  browserSelectedFile = null;
  browserSelected.textContent = '未选择';
  browserConfirm.disabled = true;
  try {
    const r = await fetch(`/api/browse?dir=${encodeURIComponent(dir)}`);
    if (!r.ok) throw new Error('目录不存在或无权限');
    const data = await r.json();
    browserCurrentDir = data.dir;
    browserAddr.value = data.dir;
    renderBreadcrumb(data.dir, data.parent);
    renderEntries(data.entries);
    // 渲染快捷位置（home / 上次加载的目录 / 当前文件目录）
    renderQuick(data.dir);
  } catch (e) {
    browserList.innerHTML = `<div class="browser-empty">${escapeHtml(e.message)}</div>`;
  }
}

function renderBreadcrumb(dir, parent) {
  const parts = dir.split('/').filter(Boolean);
  browserBreadcrumb.innerHTML = '';
  // 根目录
  const root = document.createElement('a');
  root.textContent = '/';
  root.dataset.path = '/';
  root.addEventListener('click', () => browseDir('/'));
  browserBreadcrumb.appendChild(root);
  let cur = '';
  parts.forEach((p, i) => {
    cur += '/' + p;
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    browserBreadcrumb.appendChild(sep);
    const a = document.createElement('a');
    a.textContent = p;
    a.dataset.path = cur;
    if (i === parts.length - 1) a.classList.add('current');
    a.addEventListener('click', () => browseDir(cur));
    browserBreadcrumb.appendChild(a);
  });
}

function renderEntries(entries) {
  if (entries.length === 0) {
    browserList.innerHTML = '<div class="browser-empty">空目录</div>';
    return;
  }
  browserList.innerHTML = '';
  entries.forEach((e) => {
    const div = document.createElement('div');
    div.className = `browser-entry ${e.isDir ? 'dir' : 'file'} ${e.ext === '.html' || e.ext === '.htm' ? 'is-html' : ''}`;
    const iconHtml = e.isDir
      ? '<svg class="entry-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      : '<svg class="entry-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
    const meta = e.isDir ? `${countHint(e)}` : formatSize(e.size);
    div.innerHTML = `${iconHtml}<span class="entry-name">${escapeHtml(e.name)}</span><span class="entry-meta">${meta}</span>`;
    div.addEventListener('click', (ev) => {
      if (e.isDir) {
        browseDir(e.path);
      } else {
        // 选中文件
        browserList.querySelectorAll('.browser-entry').forEach(x => x.classList.remove('selected'));
        div.classList.add('selected');
        browserSelectedFile = e.path;
        browserSelected.textContent = e.path;
        browserConfirm.disabled = false;
      }
    });
    div.addEventListener('dblclick', () => {
      if (e.isDir) browseDir(e.path);
      else if (e.ext === '.html' || e.ext === '.htm') {
        browserSelectedFile = e.path;
        confirmBrowser();
      }
    });
    browserList.appendChild(div);
  });
}

function countHint(e) { return ''; }
function formatSize(b) {
  if (!b) return '';
  if (b < 1024) return b + 'B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + 'K';
  return (b / 1024 / 1024).toFixed(1) + 'M';
}

function renderQuick(currentDir) {
  browserQuick.innerHTML = '';
  const home = osHome();
  const projRoot = '/Users/shayin/data1/htdocs/project/mind';
  const quicks = [
    { name: '主目录', target: () => browseDir(home) },
    { name: 'PPT 输出', target: () => browseDir(projRoot + '/tmp/ppt-output') },
    { name: '示例文件', target: () => browseDir(projRoot + '/ai-tools/ppt-tools/visual-editor/test/fixtures') },
    { name: 'drafts', target: () => browseDir(projRoot + '/ai-wiki/drafts') },
  ];
  quicks.forEach(q => {
    const btn = document.createElement('div');
    btn.className = 'browser-quick-item';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>${escapeHtml(q.name)}`;
    btn.addEventListener('click', q.target);
    browserQuick.appendChild(btn);
  });
}

function osHome() {
  // 简单从环境推断（前端拿不到 process.env）
  return '/Users/shayin';
}

async function openBrowser() {
  browserModal.classList.add('open');
  // 默认目录：当前文件所在目录 / 上次加载 / 用户家目录
  let startDir;
  if (state.currentFile) startDir = state.currentFile.split('/').slice(0, -1).join('/');
  else if (state.recent[0]?.path) startDir = state.recent[0].path.split('/').slice(0, -1).join('/');
  else startDir = '/Users/shayin/data1/htdocs/project/mind/tmp';
  await browseDir(startDir);
}

function closeBrowser() { browserModal.classList.remove('open'); }
function confirmBrowser() {
  if (!browserSelectedFile) return;
  fileInput.value = browserSelectedFile;
  loadFile(browserSelectedFile);
  closeBrowser();
}

$('#browseBtn').addEventListener('click', openBrowser);
$('#browserClose').addEventListener('click', closeBrowser);
$('#browserCancel').addEventListener('click', closeBrowser);
$('#browserConfirm').addEventListener('click', confirmBrowser);
$('#browserUp').addEventListener('click', () => {
  if (browserCurrentDir && browserCurrentDir !== '/') {
    browseDir(browserCurrentDir.split('/').slice(0, -1).join('/') || '/');
  }
});
$('#browserHome').addEventListener('click', () => browseDir(osHome()));
browserAddr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    browseDir(browserAddr.value.trim());
  }
});
browserModal.addEventListener('click', (ev) => {
  if (ev.target === browserModal) closeBrowser();
});
browserModal.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeBrowser();
});

// URL ?file=xxx → 优先；否则从 localStorage 恢复上次打开的文件
const params = new URLSearchParams(location.search);
if (params.get('file')) {
  fileInput.value = params.get('file');
  loadFile(fileInput.value);
} else {
  const lastFile = localStorage.getItem('ve-current-file');
  if (lastFile) {
    fileInput.value = lastFile;
    loadFile(lastFile);
  }
}

// ============ iframe 消息（选区事件） ============
window.addEventListener('message', (ev) => {
  const p = ev.data;
  if (!p) return;
  if (p.type === 'ppt-ve-debug') {
    console.log('[overlay]', p.msg);
    return;
  }
  if (p.type !== 'select') return;
  sendWs({ type: 'selection', payload: p });
  handleSelection(p);
});

function handleSelection(payload) {
  // 处理多选（rect 模式产出）
  if (payload.multi && payload.multi.length > 1) {
    toast({ type: 'info', title: `框选命中 ${payload.multi.length} 个元素`, msg: '已全部加入队列', duration: 2400 });
    for (const m of payload.multi) {
      addSelection({ selector: m.selector, elementHtml: m.elementHtml, rect: m.rect, mode: 'rect' });
    }
    return;
  }
  addSelection(payload);
  if (state.settings.autoInspector) showInspector(payload);
}

function addSelection(payload) {
  state.selections.unshift({ ...payload, ts: Date.now(), pinned: false });
  if (state.selections.length > 20) state.selections.length = 20;
  renderQueue();
}

// ============ Queue rendering ============
function renderQueue() {
  selCount.textContent = state.selections.length;
  queueCount.textContent = state.selections.length;
  if (state.selections.length === 0) {
    queueList.innerHTML = `
      <div class="queue-empty">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        <span>${state.mode === 'rect' ? '拖拽鼠标框选多个元素' : state.mode === 'text' ? '用鼠标选中文本' : '按住 Option/Alt + 点击 元素'}</span>
      </div>`;
    return;
  }
  queueList.innerHTML = '';
  // pinned 排前面
  const sorted = [...state.selections].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  sorted.forEach((s) => {
    const idx = state.selections.indexOf(s) + 1;
    const card = document.createElement('div');
    card.className = 'queue-card';
    card.dataset.idx = state.selections.indexOf(s);
    const text = s.selectedText || s.text || (s.elementHtml || '').replace(/<[^>]+>/g, '').trim().slice(0, 60);
    card.innerHTML = `
      <div class="queue-card-index">${idx}</div>
      <div class="queue-card-anchor">${s.selector?.anchor || '—'}${s.mode === 'rect' ? ' · rect' : s.mode === 'text' ? ' · text' : ''}</div>
      <div class="queue-card-sel">${escapeHtml(s.selector?.css || '?')}</div>
      <div class="queue-card-text">${escapeHtml(text)}</div>
      <div class="queue-card-actions">
        <button class="send" data-act="send">发送</button>
        <button data-act="copy">复制</button>
        <button data-act="pin" class="${s.pinned ? 'pin active' : 'pin'}">${s.pinned ? '★' : '☆'}</button>
        <button data-act="drop">✕</button>
      </div>
    `;
    queueList.appendChild(card);
  });
}

queueList.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button'); if (!btn) return;
  const card = ev.target.closest('.queue-card'); if (!card) return;
  const idx = parseInt(card.dataset.idx, 10);
  const s = state.selections[idx]; if (!s) return;
  const act = btn.dataset.act;
  if (act === 'send') { sendSelectionToTerminal(idx); flashCard(card); }
  else if (act === 'drop') { state.selections.splice(idx, 1); renderQueue(); }
  else if (act === 'pin') { s.pinned = !s.pinned; renderQueue(); }
  else if (act === 'copy') {
    const text = buildContextPacket(s);
    navigator.clipboard.writeText(text).then(() => toast({ type: 'success', msg: '已复制到剪贴板', duration: 1500 }));
  }
});
function flashCard(card) {
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
}

function sendSelectionToTerminal(idx) {
  const s = state.selections[idx]; if (!s) return false;
  const packet = buildContextPacket(s);
  let data;
  if (state.settings.format === 'markdown') {
    data = '\n' + packet + '\n';
  } else if (state.settings.format === 'compact') {
    data = '\n' + packet + '\n';
  } else {
    data = '\n' + packet + '\n';
  }
  sendWs({ type: 'pty:in', data });
  if (state.settings.autofocus) term.focus();
  toast({ type: 'success', title: `选区 #${idx + 1} 已发送`, msg: s.selector?.css, duration: 1800 });
  return true;
}

function buildContextPacket(s) {
  const file = state.currentFile || '(未加载文件)';
  const lines = [];

  // 头部：明确告诉 Claude 这是文件 + 元素位置参考
  lines.push(`我在浏览器里点选了 HTML 文件里的一个元素，需要你帮我修改它。下面是定位上下文，请基于此完成我接下来的指令：`);
  lines.push('');
  lines.push(`📄 文件路径：${file}`);
  lines.push('');

  if (state.settings.format === 'compact') {
    const sel = s.selector?.css || '?';
    const text = (s.selectedText || s.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    lines.push(`[target file=${JSON.stringify(file)} selector=${JSON.stringify(sel)} text=${JSON.stringify(text)}]`);
    if (s.elementHtml) lines.push(`[html] ${s.elementHtml.replace(/\s+/g, ' ').trim().slice(0, 400)}`);
    return lines.join('\n');
  }

  if (state.settings.format === 'markdown') {
    lines.push('```html');
    if (s.selector?.css) lines.push(`<!-- selector: ${s.selector.css} -->`);
    if (s.selectedText) lines.push(`<!-- selected text: ${s.selectedText.replace(/-->/g, '').slice(0, 200)} -->`);
    lines.push(s.elementHtml || '');
    lines.push('```');
    return lines.join('\n');
  }

  // 默认 xml 风格（最详细）
  const anchorAttr = s.selector?.anchor ? ` anchor="${s.selector.anchor}"` : '';
  const selAttr = s.selector?.css ? ` selector=${JSON.stringify(s.selector.css)}` : '';
  lines.push(`<target file=${JSON.stringify(file)}${anchorAttr}${selAttr}>`);
  if (s.selectedText) lines.push(`  <selected>${escapeHtml(s.selectedText)}</selected>`);
  if (s.elementHtml) {
    lines.push('  <element>');
    lines.push('    ' + s.elementHtml.replace(/\s+/g, ' ').trim().slice(0, 800));
    lines.push('  </element>');
  }
  if (s.siblings?.length) {
    lines.push('  <context>');
    for (const sib of s.siblings) lines.push(`    ${sib.relation}: ${sib.html.slice(0, 200)}`);
    lines.push('  </context>');
  }
  if (s.rect) lines.push(`  <rect x="${s.rect.x}" y="${s.rect.y}" w="${s.rect.w}" h="${s.rect.h}" />`);
  if (s.hostRect) lines.push(`  <host-rect x="${s.hostRect.x}" y="${s.hostRect.y}" w="${s.hostRect.w}" h="${s.hostRect.h}" />`);
  if (s.pseudo?.length) {
    lines.push('  <pseudo-elements>');
    for (const p of s.pseudo) {
      const bits = [`content=${JSON.stringify(p.content)}`];
      // size 去掉 px 单位，加乘号，更易读
      const wNum = parseInt(p.width, 10);
      const hNum = parseInt(p.height, 10);
      if (!isNaN(wNum) && !isNaN(hNum)) bits.push(`size="${wNum}×${hNum}px"`);
      if (p.background) bits.push(`bg=${JSON.stringify(p.background)}`);
      if (p.border) bits.push(`border=${JSON.stringify(p.border)}`);
      if (p.color && p.color !== 'rgb(0, 0, 0)') bits.push(`color=${JSON.stringify(p.color)}`);
      if (p.rect) bits.push(`rect="${p.rect.x},${p.rect.y},${p.rect.w},${p.rect.h}"`);
      const hostAttr = p.host ? ` host=${JSON.stringify(p.host)}` : '';
      const nameAttr = ` name=${JSON.stringify(p.pseudo)}`;
      lines.push(`    <pseudo${nameAttr}${hostAttr} ${bits.join(' ')} />`);
    }
    lines.push('  </pseudo-elements>');
  }
  lines.push('</target>');
  return lines.join('\n');
}

// ============ Inspector ============
function showInspector(s) {
  state.currentInspectorSel = s;
  console.log('[inspector] showInspector got pseudo=', s.pseudo, 'sel=', s.selector?.css);
  $('#inspSelector').textContent = s.selector?.css || '—';
  $('#inspHtml').textContent = (s.elementHtml || '').replace(/\s+/g, ' ').trim();
  $('#inspW').textContent = s.rect?.w + 'px' || '—';
  $('#inspH').textContent = s.rect?.h + 'px' || '—';
  $('#inspX').textContent = s.rect?.x ?? '—';
  $('#inspY').textContent = s.rect?.y ?? '—';
  // 伪元素展示
  const pseudos = Array.isArray(s.pseudo) ? s.pseudo : [];
  if (pseudos.length) {
    const parts = pseudos.map((p) => {
      const bits = [`content: ${p.content}`];
      if (p.width && p.width !== 'auto') bits.push(`${p.width}×${p.height}`);
      if (p.background) bits.push(`bg:${p.background}`);
      if (p.border) bits.push(`border:${p.border}`);
      if (p.color && p.color !== 'rgb(0, 0, 0)') bits.push(`color:${p.color}`);
      const hostInfo = p.host ? `<div class="pseudo-host">宿主: <code>${p.hostTag}${p.pseudo}</code>（${p.host}）</div>` : '';
      return `<div class="pseudo-item"><span class="pseudo-name">${p.pseudo}</span>${bits.join(' · ')}${hostInfo}</div>`;
    });
    $('#inspPseudo').innerHTML = parts.join('');
    $('#inspPseudoRow').style.display = '';
  } else {
    $('#inspPseudo').textContent = '—';
    $('#inspPseudoRow').style.display = 'none';
  }
  if (!state.inspectorOpen) toggleInspector(true);
}
function toggleInspector(force) {
  const open = force !== undefined ? force : !state.inspectorOpen;
  state.inspectorOpen = open;
  inspector.classList.toggle('open', open);
  $('#inspectorToggle').classList.toggle('active', open);
}
$('#inspectorToggle').addEventListener('click', () => toggleInspector());
$('#inspectorClose').addEventListener('click', () => toggleInspector(false));
$('#inspSendBtn').addEventListener('click', () => {
  if (state.currentInspectorSel) {
    addSelection({ ...state.currentInspectorSel, mode: 'inspect' });
    // 找到刚加的并发送
    sendSelectionToTerminal(0);
  }
});
$('#inspCopyBtn').addEventListener('click', () => {
  if (state.currentInspectorSel) {
    navigator.clipboard.writeText(buildContextPacket(state.currentInspectorSel))
      .then(() => toast({ type: 'success', msg: '已复制', duration: 1200 }));
  }
});

// ============ Recent files ============
function renderRecent() {
  const list = $('#recentList');
  if (state.recent.length === 0) {
    list.innerHTML = '<div class="sidebar-empty">尚无最近打开的文件<br/>加载一个 HTML 开始</div>';
    return;
  }
  list.innerHTML = '';
  state.recent.forEach((r) => {
    const item = document.createElement('div');
    item.className = 'sidebar-item' + (r.path === state.currentFile ? ' active' : '');
    item.dataset.path = r.path;
    item.innerHTML = `
      <span class="file-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
      <span class="file-name">${escapeHtml(r.name || r.path)}</span>
      <span class="close-x" data-action="remove">✕</span>
    `;
    item.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-action="remove"]')) {
        state.recent = state.recent.filter(x => x.path !== r.path);
        saveRecent(); renderRecent();
        return;
      }
      fileInput.value = r.path;
      loadFile(r.path);
    });
    list.appendChild(item);
  });
}
renderRecent();

$('#clearRecentBtn').addEventListener('click', () => {
  if (state.recent.length === 0) return;
  state.recent = []; saveRecent(); renderRecent();
  toast({ type: 'info', msg: '已清空最近打开列表', duration: 1500 });
});

// 拖拽文件到侧栏 → 自动加载路径
// 浏览器安全沙箱默认不暴露绝对路径，但尝试多种 dataTransfer 类型
// 某些浏览器/数据源能拿到 file:// URL，拿到就解码成路径加载
(function attachDragDrop() {
  const sidebar = $('#sidebar');
  if (!sidebar) return;
  let dragCounter = 0;
  let lastLog = null;

  function extractPath(e) {
    const dt = e.dataTransfer;
    if (!dt) return null;
    // 调试：记录所有 types + 数据
    const types = Array.from(dt.types || []);
    const dump = {};
    for (const t of types) {
      try { dump[t] = dt.getData(t); } catch { dump[t] = '<error>'; }
    }
    lastLog = { types, dump, files: Array.from(dt.files || []).map((f) => ({ name: f.name, path: f.path, webkitRelativePath: f.webkitRelativePath })) };
    console.log('[drag-drop] dataTransfer:', lastLog);

    // 1) File 对象上的 .path（Electron 才有）
    for (const f of (dt.files || [])) {
      if (f.path) return f.path;
    }
    // 2) text/uri-list 中可能有 file:// URL
    const tryTypes = ['text/uri-list', 'text/plain', 'URL', 'public.file-url', 'application/x-moz-file'];
    for (const t of tryTypes) {
      const v = dt.getData(t);
      if (!v) continue;
      const m = v.match(/file:\/\/(.+)/i);
      if (m) return decodeURIComponent(m[1]);
      // 纯文本里可能直接是绝对路径（/ 开头）
      if (/^\/[^\s]+\.(html?|htm)$/i.test(v.trim())) return v.trim();
    }
    return null;
  }

  sidebar.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files') && !e.dataTransfer?.types?.includes('text/uri-list')) return;
    e.preventDefault();
    dragCounter++;
    sidebar.classList.add('drag-over');
  });
  sidebar.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  sidebar.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      sidebar.classList.remove('drag-over');
    }
  });
  sidebar.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    sidebar.classList.remove('drag-over');
    const p = extractPath(e);
    if (p) {
      fileInput.value = p;
      copyPathBtn.disabled = false;
      loadFile(p);
      toast({ type: 'success', msg: '已加载：' + p, duration: 2000 });
    } else {
      console.log('[drag-drop] 拿不到绝对路径，详细 dataTransfer 见上。浏览器安全沙箱不允许网页读取拖入文件的绝对路径。');
      toast({
        type: 'error',
        title: '拿不到文件路径',
        msg: '浏览器安全沙箱限制。请打开 devtools 看 console 的 [drag-drop] 输出，或直接粘贴路径到输入框',
        duration: 4000,
      });
    }
  });
})();

// ============ Selection modes ============
function setMode(m) {
  state.mode = m;
  $$('#modeGroup .tool-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  modeStatus.textContent = { point: '点选模式', rect: '框选模式', text: '文本选区模式' }[m];
  updateModeHint();
  // 通知 iframe
  const iframe = $('#previewIframe');
  if (iframe && iframe.contentWindow) {
    iframe.contentWindow.postMessage({ type: 'ppt-ve-mode', mode: m }, '*');
  }
  renderQueue(); // 提示文案跟随
}
function updateModeHint() {
  const hintText = $('#hintText');
  if (!hintText) return;
  hintText.innerHTML = {
    point: '按住 <kbd>Option</kbd> + 点击元素',
    rect: '拖拽鼠标框选多个元素',
    text: '用鼠标选中文本',
  }[state.mode];
}
$$('#modeGroup .tool-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

$('#clearSelBtn').addEventListener('click', () => {
  const iframe = $('#previewIframe');
  if (iframe && iframe.contentWindow) iframe.contentWindow.postMessage({ type: 'ppt-ve-clear' }, '*');
  toast({ type: 'info', msg: '已清除高亮', duration: 1200 });
});

// ============ Queue drawer ============
function openQueue() { queueDrawer.classList.add('open'); }
function closeQueue() { queueDrawer.classList.remove('open'); }
$('#queueToggle').addEventListener('click', () => queueDrawer.classList.toggle('open'));
$('#queueCloseBtn').addEventListener('click', closeQueue);
$('#queueClearBtn').addEventListener('click', () => {
  // pinned 的保留
  const pinned = state.selections.filter(s => s.pinned);
  if (pinned.length === state.selections.length) return;
  state.selections = pinned;
  renderQueue();
  toast({ type: 'info', msg: '已清空未固定选区', duration: 1500 });
});

// ============ Sidebar toggle ============
$('#sidebarToggle').addEventListener('click', () => {
  main.classList.toggle('no-sidebar');
  $('#sidebarToggle').classList.toggle('active', !main.classList.contains('no-sidebar'));
  setTimeout(() => fitAddon.fit(), 50);
});

// ============ Theme toggle ============
$('#themeToggle').addEventListener('click', () => {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  saveSettings();
  applyTheme();
  toast({ type: 'info', msg: `主题：${state.settings.theme === 'dark' ? '深色' : '浅色'}`, duration: 1200 });
});

// ============ Refresh ============
$('#refreshBtn').addEventListener('click', () => {
  if (!state.currentFile) return;
  const iframe = $('#previewIframe');
  if (iframe) iframe.src = `/api/render?file=${encodeURIComponent(state.currentFile)}&t=${Date.now()}`;
  toast({ type: 'info', msg: '已刷新预览', duration: 1200 });
});

// ============ Terminal actions ============
$('#termRestartBtn').addEventListener('click', () => {
  sendWs({ type: 'pty:restart' });
  term.reset();
  toast({ type: 'info', title: 'Claude 进程', msg: '正在重启…', duration: 1500 });
});
$('#termClearBtn').addEventListener('click', () => {
  sendWs({ type: 'pty:in', data: '\x1b[2J\x1b[3J\x1b[H' });
  term.focus();
});

// ============ Settings modal ============
const settingsModal = $('#settingsModal');
function openSettings() {
  $('#setCmd').value = state.settings.claudeCommand;
  $('#setFormat').value = state.settings.format;
  $('#setAutofocus').classList.toggle('on', state.settings.autofocus);
  $('#setAutoInspector').classList.toggle('on', state.settings.autoInspector);
  $('#setAutoRefresh').classList.toggle('on', state.settings.autoRefresh);
  $('#setStatusbar').classList.toggle('on', state.settings.showStatusbar);
  settingsModal.classList.add('open');
}
function closeSettings() { settingsModal.classList.remove('open'); }
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', closeSettings);
$('#settingsCancel').addEventListener('click', closeSettings);
$('#settingsSave').addEventListener('click', () => {
  state.settings.claudeCommand = $('#setCmd').value.trim();
  state.settings.format = $('#setFormat').value;
  state.settings.autofocus = $('#setAutofocus').classList.contains('on');
  state.settings.autoInspector = $('#setAutoInspector').classList.contains('on');
  state.settings.autoRefresh = $('#setAutoRefresh').classList.contains('on');
  state.settings.showStatusbar = $('#setStatusbar').classList.contains('on');
  saveSettings();
  closeSettings();
  toast({ type: 'success', msg: '设置已保存', duration: 1500 });
});
$$('.toggle').forEach(t => t.addEventListener('click', () => t.classList.toggle('on')));

// ============ Help modal ============
const helpModal = $('#helpModal');
$('#helpBtn').addEventListener('click', () => helpModal.classList.add('open'));
$('#helpClose').addEventListener('click', () => helpModal.classList.remove('open'));
[settingsModal, helpModal].forEach(m => {
  m.addEventListener('click', (ev) => { if (ev.target === m) m.classList.remove('open'); });
});

// ============ Resizer ============
let dragState = null;
$('#resizer1').addEventListener('mousedown', (ev) => {
  ev.preventDefault();
  dragState = { type: 'col', el: $('#resizer1'), startX: ev.clientX };
  $('#resizer1').classList.add('active');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});
document.addEventListener('mousemove', (ev) => {
  if (!dragState) return;
  const mainRect = main.getBoundingClientRect();
  const sidebarW = main.classList.contains('no-sidebar') ? 0 : 240;
  // 预览区宽度 = (鼠标 x - main left - sidebar)
  const previewW = ev.clientX - mainRect.left - sidebarW;
  const terminalW = mainRect.width - sidebarW - previewW - 2;
  if (previewW < 200 || terminalW < 200) return;
  main.style.gridTemplateColumns = `${sidebarW}px ${previewW}px 1px 1fr`;
});
document.addEventListener('mouseup', () => {
  if (!dragState) return;
  $('#resizer1')?.classList.remove('active');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  dragState = null;
  fitAddon.fit();
});

// ============ Global keyboard shortcuts ============
document.addEventListener('keydown', (ev) => {
  const mod = ev.metaKey || ev.ctrlKey;

  // Cmd+Shift+1-9: 发送选区
  if (mod && ev.shiftKey && /^[1-9]$/.test(ev.key)) {
    ev.preventDefault();
    const n = parseInt(ev.key, 10);
    const cards = $$('.queue-card');
    if (cards[n - 1]) {
      const idx = parseInt(cards[n - 1].dataset.idx, 10);
      sendSelectionToTerminal(idx);
      flashCard(cards[n - 1]);
    }
    return;
  }

  // Modal open 时按 Esc 关闭
  if (ev.key === 'Escape') {
    if (settingsModal.classList.contains('open')) return closeSettings();
    if (helpModal.classList.contains('open')) return helpModal.classList.remove('open');
  }

  // 输入框聚焦时，单字母快捷键不响应
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (inInput && ev.key !== 'Escape') return;

  // ? 显示帮助
  if (ev.key === '?' && !mod) { ev.preventDefault(); helpModal.classList.add('open'); return; }

  // 单字母：切模式
  if (!mod && !ev.shiftKey) {
    if (ev.key === 'p' || ev.key === 'P') { setMode('point'); return; }
    if (ev.key === 'r' || ev.key === 'R') { setMode('rect'); return; }
    if (ev.key === 't' || ev.key === 'T') { setMode('text'); return; }
  }

  if (!mod) return;

  // Cmd+系列
  switch (ev.key.toLowerCase()) {
    case 'b': ev.preventDefault(); $('#sidebarToggle').click(); break;
    case 'j': ev.preventDefault(); queueDrawer.classList.toggle('open'); break;
    case 'i': ev.preventDefault(); toggleInspector(); break;
    case 'd': ev.preventDefault(); $('#themeToggle').click(); break;
    case 'r': ev.preventDefault(); $('#refreshBtn').click(); break;
    case '`': ev.preventDefault(); term.focus(); break;
  }
});

// ============ Status ============
function updateClaudeCmd() {
  fetch('/api/info').then(r => r.json()).then(info => {
    claudeCmd.textContent = state.settings.claudeCommand || info.claudeCommand;
  }).catch(() => {
    claudeCmd.textContent = state.settings.claudeCommand || 'claude';
  });
}
updateClaudeCmd();

// ============ Bootstrap ============
connectWs();
// 设置默认布局：侧栏可见
$('#sidebarToggle').classList.add('active');

// 欢迎提示
setTimeout(() => {
  if (!state.currentFile) {
    toast({ type: 'info', title: '欢迎使用 Visual Editor', msg: '在顶部输入 HTML 文件路径并回车加载', duration: 4500 });
  }
}, 600);

// ============ 暴露给非 module 脚本（audit.js 等） ============
window.sendWs = sendWs;
window.toast = toast;
window.state = state;
window.term = term;
