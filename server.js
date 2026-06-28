// server.js
// 主入口：Express 静态服务 + WebSocket（终端 + 选区事件）+ HTML 文件监听

import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import cp from 'node:child_process';
import { spawnClaude, resolveClaudeCommand } from './lib/pty-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 7788;

// 默认工作区：用户主目录下隐藏目录
const WORKSPACE_DIR = process.env.PPT_VE_WORKSPACE || path.join(os.homedir(), '.ppt-ve-workspace');
const BACKUP_DIR = path.join(WORKSPACE_DIR, 'backup');
const BACKUP_KEEP = 20; // 每个文件保留最近 20 份备份

function initWorkspace() {
  if (!fs.existsSync(WORKSPACE_DIR)) {
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    console.log(`[workspace] created: ${WORKSPACE_DIR}`);
  }
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`[workspace] created backup dir: ${BACKUP_DIR}`);
  }
  const claudeMdPath = path.join(WORKSPACE_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.writeFileSync(claudeMdPath, buildWorkspaceCLAUDEMd(), 'utf8');
    console.log(`[workspace] initialized CLAUDE.md`);
  }
}

function buildWorkspaceCLAUDEMd() {
  return `# PPT Visual Editor 工作区

本目录是 PPT 可视化编辑器的工作区，Claude Code 终端默认在本目录运行。

## 工作区定位

- **工作区根**：\`${WORKSPACE_DIR}\`
- **备份目录**：\`${BACKUP_DIR}\`（每个源文件保留最近 ${BACKUP_KEEP} 份滚动备份）

## 铁律（必须严格遵守）

### 1. 产物收敛

除用户显式指定路径的源文件（HTML 模板、外部资源等读取/改动对象）外，**所有生成或衍生的产物必须收敛在本工作区内**，不得散落到其他位置：

- ✅ 临时产物、调试输出、中间文件 → 放工作区内
- ✅ 截图、对比图、测试输出 → 放工作区内
- ❌ 不得在用户主目录、桌面、项目源码目录等位置生成任何文件

### 2. 滚动备份（每次改动前必做）

修改任何用户指定的源 HTML 文件前，**必须先备份**。优先调用 HTTP 接口（自动完成备份 + 滚动清理）：

\`\`\`bash
curl -sX POST http://localhost:${PORT}/api/backup \\
  -H 'Content-Type: application/json' \\
  -d '{"file":"/abs/path/to/source.html"}'
\`\`\`

或手动执行（命名规则 \`<原文件名>.bak.<时间戳>.<原扩展名>\`）：

\`\`\`bash
SRC="/abs/path/to/source.html"
BASENAME=$(basename "$SRC")
BD="${BACKUP_DIR}"
cp "$SRC" "$BD/\${BASENAME}.bak.\$(date +%Y%m%d_%H%M%S).html"
# 滚动清理：保留最近 ${BACKUP_KEEP} 份
ls -t "\$BD"/"\$BASENAME".bak.* 2>/dev/null | tail -n +\$(( ${BACKUP_KEEP} + 1 )) | xargs rm -f 2>/dev/null
\`\`\`

### 3. 操作约束

- 改动范围严格限定在用户明确指定的源文件内
- 不主动新建源文件、不改其他文件、不重构无关代码
- 备份是改动的必要前置条件，未备份不得修改
`;
}

initWorkspace();

const app = express();
app.use(express.json({ limit: '50mb' }));

// 临时 access log，定位图片 404 用
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// 把 xterm 前端资源暴露为静态文件
const xtermDir = path.join(__dirname, 'node_modules', '@xterm');
app.get('/xterm/xterm.js', (req, res) => res.sendFile(path.join(xtermDir, 'xterm', 'lib', 'xterm.js')));
app.get('/xterm/xterm.css', (req, res) => res.sendFile(path.join(xtermDir, 'xterm', 'css', 'xterm.css')));
app.get('/xterm/addon-fit.js', (req, res) => res.sendFile(path.join(xtermDir, 'addon-fit', 'lib', 'addon-fit.js')));

app.use(express.static(PUBLIC_DIR));

// 加载用户 HTML 文件，注入 overlay.js 和 <base> 让相对路径解析到原目录
app.get('/api/render', (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).send('missing ?file');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return res.status(404).send('file not found: ' + abs);

  // 把 HTML 所在目录编码成 base64url，作为静态资源路由的 key
  const dir = path.dirname(abs);
  const dirB64 = Buffer.from(dir, 'utf8').toString('base64url');
  // <base> 末尾的斜杠很关键，否则相对路径会丢最后一段
  const baseTag = `<base href="/api/asset/${dirB64}/">`;
  const overlayTag = `<script src="/overlay.js"></script>`;

  let html = fs.readFileSync(abs, 'utf8');
  // 注意：overlay.js 是绝对路径不受 base 影响，但要在 base 之后注入以防万一
  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}${overlayTag}`);
  } else if (/<html[^>]*>/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, `<html$1><head>${baseTag}${overlayTag}</head>`);
  } else {
    html = `${baseTag}${overlayTag}` + html;
  }
  res.type('html').send(html);
});

// 静态资源服务：让 iframe 内的相对路径（图片/CSS/JS）能解析回原目录
app.get('/api/asset/:dirB64/*', (req, res) => {
  let dir;
  try {
    dir = Buffer.from(req.params.dirB64, 'base64url').toString('utf8');
  } catch {
    return res.status(400).send('invalid dir encoding');
  }
  const rel = req.params[0];
  const abs = path.resolve(dir, rel);
  // 路径越界保护：必须仍在 dir 内
  if (!abs.startsWith(dir + path.sep) && abs !== dir) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).send('not found: ' + rel);
  }
  res.sendFile(abs);
});

// 元信息接口
app.get('/api/info', (req, res) => {
  const cmd = resolveClaudeCommand();
  res.json({ claudeCommand: [cmd.file, ...cmd.args].join(' '), port: PORT });
});

// 目录浏览接口（文件选择器用）—— 默认从工作区开始
app.get('/api/browse', (req, res) => {
  const dir = req.query.dir ? path.resolve(String(req.query.dir)) : WORKSPACE_DIR;
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(404).json({ error: 'not a directory' });
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .map((e) => {
        const full = path.join(dir, e.name);
        let meta = {};
        try {
          const st = fs.statSync(full);
          meta = { size: st.size, mtime: st.mtimeMs };
        } catch {}
        return {
          name: e.name,
          isDir: e.isDirectory(),
          isFile: e.isFile(),
          path: full,
          ext: e.isFile() ? path.extname(e.name).toLowerCase() : '',
          ...meta,
        };
      })
      .filter((e) => {
        if (e.name.startsWith('.')) return false; // 隐藏文件
        if (e.isDir) return true;
        return ['.html', '.htm'].includes(e.ext);
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ dir, parent: path.dirname(dir), entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 文件元信息
app.get('/api/file-info', (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'missing file' });
  try {
    const abs = path.resolve(String(file));
    const st = fs.statSync(abs);
    res.json({
      path: abs,
      basename: path.basename(abs),
      dirname: path.dirname(abs),
      size: st.size,
      mtime: st.mtimeMs,
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// 滚动备份接口：改动前调用，自动 cp + 清理旧备份
app.post('/api/backup', (req, res) => {
  const file = req.body?.file;
  if (!file) return res.status(400).json({ error: 'missing file' });
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return res.status(404).json({ error: 'file not found: ' + abs });
  }
  const basename = path.basename(abs);
  const ext = path.extname(abs);
  const stem = basename.slice(0, basename.length - ext.length);
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '_' + String(Date.now()).slice(-4);
  const backupName = `${stem}.bak.${ts}${ext}`;
  const backupPath = path.join(BACKUP_DIR, backupName);
  try {
    fs.copyFileSync(abs, backupPath);
  } catch (e) {
    return res.status(500).json({ error: 'copy failed: ' + e.message });
  }
  // 滚动清理：同 stem 的备份保留最近 BACKUP_KEEP 份
  const globPrefix = `${stem}.bak.`;
  let olds = [];
  try {
    olds = fs.readdirSync(BACKUP_DIR)
      .filter((n) => n.startsWith(globPrefix) && n.endsWith(ext))
      .map((n) => ({ name: n, mtime: fs.statSync(path.join(BACKUP_DIR, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {}
  const removed = [];
  if (olds.length > BACKUP_KEEP) {
    for (const o of olds.slice(BACKUP_KEEP)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, o.name)); removed.push(o.name); } catch {}
    }
  }
  res.json({
    ok: true,
    backup: backupPath,
    kept: olds.slice(0, BACKUP_KEEP).map((o) => o.name),
    removed,
  });
});

// 工作区信息（前端启动时拿）
app.get('/api/workspace', (req, res) => {
  res.json({ workspace: WORKSPACE_DIR, backup: BACKUP_DIR, keep: BACKUP_KEEP });
});

const server = http.createServer(app);

// WebSocket：一个端点同时承载终端数据 & 选区事件
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set();
let ptyProc = null;
let ptyError = null;
const ptyOutputBuf = []; // ringbuffer，新 client 连接时回放历史输出
let ptyBufSize = 0;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const c of clients) {
    if (c.readyState === 1) c.send(msg);
  }
}

function ensurePty() {
  if (ptyProc || ptyError) return;
  try {
    const cwd = WORKSPACE_DIR; // 始终在工作区启动 Claude
    ptyProc = spawnClaude({ cwd });
    ptyProc.onData((data) => {
      ptyOutputBuf.push(data);
      // ringbuffer 限制总长度 ~256KB（足够 Claude TUI 一屏）
      while (ptyOutputBuf.length && ptyBufSize > 256 * 1024) {
        const old = ptyOutputBuf.shift();
        ptyBufSize -= old.length;
      }
      broadcast({ type: 'pty:out', data });
    });
    ptyProc.onExit(({ exitCode }) => {
      broadcast({ type: 'pty:exit', code: exitCode });
      ptyProc = null;
      ptyOutputBuf.length = 0;
      ptyBufSize = 0;
    });
    console.log(`[pty] spawned, child pid=${ptyProc.pid}`);
  } catch (e) {
    ptyError = e.message;
    console.error('[pty] spawn failed:', e.message);
    broadcast({ type: 'pty:error', msg: e.message });
  }
}

// 监控 claude 子进程树内存，超阈值提醒用户重启终端
let lastMemWarn = 0;
function monitorPtyMem() {
  if (!ptyProc || !ptyProc.pid) return;
  let totalKb = 0;
  try {
    const out = cp.execSync('ps -A -o pid= -o ppid= -o rss=', { encoding: 'utf8' });
    const byPid = new Map();
    const procs = [];
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = +m[1], ppid = +m[2], rss = +m[3];
      procs.push({ pid, ppid, rss });
      byPid.set(pid, { pid, ppid, rss });
    }
    const visited = new Set();
    const queue = [ptyProc.pid];
    while (queue.length) {
      const cur = queue.shift();
      if (visited.has(cur)) continue;
      visited.add(cur);
      const info = byPid.get(cur);
      if (info) totalKb += info.rss;
      for (const p of procs) if (p.ppid === cur && !visited.has(p.pid)) queue.push(p.pid);
    }
  } catch (e) {
    console.error('[pty-mem] ps failed:', e.message);
    return;
  }
  const mb = totalKb / 1024;
  console.log(`[pty-mem] subtree from pid=${ptyProc.pid} total rss=${mb.toFixed(0)}MB`);
  if (mb > 1200 && Date.now() - lastMemWarn > 60000) {
    lastMemWarn = Date.now();
    broadcast({ type: 'pty:mem-warn', mb: Math.round(mb) });
  }
}
setInterval(monitorPtyMem, 15000);

wss.on('connection', (ws) => {
  clients.add(ws);
  ensurePty();
  // 历史回放不再立即发——等前端 fit + resize 后主动请求
  // 避免新 client cols 还没就绪时写入历史导致换行错位

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'pty:in') {
      if (ptyProc) ptyProc.write(msg.data);
    } else if (msg.type === 'pty:resize') {
      if (ptyProc) ptyProc.resize(msg.cols || 100, msg.rows || 30);
    } else if (msg.type === 'pty:replay-request') {
      // 前端已完成 fit + resize，回放历史输出
      if (ptyOutputBuf.length) {
        const replay = ptyOutputBuf.join('');
        try { ws.send(JSON.stringify({ type: 'pty:out', data: replay })); } catch {}
      }
    } else if (msg.type === 'pty:restart') {
      if (ptyProc) {
        try { ptyProc.kill(); } catch {}
        ptyProc = null;
      }
      ptyError = null;
      ensurePty();
    } else if (msg.type === 'watch') {
      startWatching(msg.file);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

let watchers = new Map(); // file -> watcher
function startWatching(file) {
  const abs = path.resolve(file);
  if (watchers.has(abs)) {
    console.log(`[watch] already watching: ${abs}`);
    return;
  }
  try {
    const w = chokidar.watch(abs, { persistent: true, ignoreInitial: true });
    w.on('change', () => {
      console.log(`[watch] file changed: ${abs}`);
      broadcast({ type: 'file:changed', file: abs });
    });
    w.on('ready', () => console.log(`[watch] ready: ${abs}`));
    w.on('error', (e) => console.error(`[watch] error ${abs}:`, e.message));
    watchers.set(abs, w);
    console.log(`[watch] started: ${abs}`);
  } catch (e) {
    console.error('watch failed:', e.message);
  }
}

server.listen(PORT, () => {
  console.log(`ppt-visual-editor listening on http://localhost:${PORT}`);
  console.log(`claude command: ${resolveClaudeCommand().file}`);
  console.log(`Usage: open http://localhost:${PORT}/?file=/abs/path/to.html`);
});

// 内存监控：每 10 秒打一次，定位是否 OOM
setInterval(() => {
  const m = process.memoryUsage();
  console.log(`[mem] rss=${(m.rss/1024/1024).toFixed(0)}MB heap=${(m.heapUsed/1024/1024).toFixed(0)}MB/${(m.heapTotal/1024/1024).toFixed(0)}MB ext=${(m.external/1024/1024).toFixed(0)}MB`);
}, 10000);

// 捕获致命信号，看是被谁杀的
['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`[signal] received ${sig} at ${new Date().toISOString()}`);
    // 不立刻退出，先 log
    setTimeout(() => process.exit(0), 100);
  });
});
process.on('exit', (code) => console.log(`[exit] code=${code}`));
