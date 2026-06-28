// pty-manager.js
// 启动 claude CLI（命令三级 fallback），桥接到 WebSocket

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import osPty from '@homebridge/node-pty-prebuilt-multiarch';

function readSettingsCommand() {
  try {
    const home = os.homedir();
    const p1 = path.join(home, '.claude', 'settings.json');
    if (fs.existsSync(p1)) {
      const cfg = JSON.parse(fs.readFileSync(p1, 'utf8'));
      if (cfg.claudeCommand) return cfg.claudeCommand;
    }
  } catch {
    // ignore
  }
  if (process.env.CLAUDE_COMMAND) return process.env.CLAUDE_COMMAND;
  return 'claude';
}

export function resolveClaudeCommand() {
  const raw = readSettingsCommand();
  // 支持 "claude --model xxx" 形式，切分为数组
  const parts = raw.split(/\s+/).filter(Boolean);
  return { file: parts[0], args: parts.slice(1) };
}

export function spawnClaude({ cwd = process.cwd() } = {}) {
  const { file, args } = resolveClaudeCommand();
  const shell = process.env.SHELL || (os.platform() === 'win32' ? 'cmd.exe' : '/bin/zsh');
  // 用 shell -c 启动，让 PATH 解析 claude
  const argv = ['-c', [file, ...args].join(' '), 'node-pty'];
  const pty = osPty.spawn(shell, argv, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return pty;
}
