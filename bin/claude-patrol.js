#!/usr/bin/env node

import { isRunning, readPid, removePid } from '../src/pid.js';
import { pidPath, stateDir, dataDir, configDir, configPath, defaultDbPath, mcpConfigPath } from '../src/paths.js';
import { unlinkSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const command = args[0] || 'start';

switch (command) {
  case 'start': {
    const open = args.includes('--open');
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    console.log('[claude-patrol] Building frontend...');
    execSync('pnpm --filter claude-patrol-frontend build', { cwd: rootDir, stdio: 'inherit' });
    const { startServer } = await import('../src/index.js');
    await startServer({ open });
    break;
  }

  case 'stop': {
    const status = isRunning();
    if (!status.running) {
      console.log('[claude-patrol] Not running.');
      process.exit(0);
    }

    console.log(`[claude-patrol] Stopping server (pid ${status.pid})...`);
    process.kill(status.pid, 'SIGTERM');

    // Poll for exit (up to 5 seconds)
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(status.pid, 0);
      } catch {
        // Process is gone
        removePid();
        console.log('[claude-patrol] Stopped.');
        process.exit(0);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    console.error('[claude-patrol] Server did not stop within 5s. Sending SIGKILL.');
    try { process.kill(status.pid, 'SIGKILL'); } catch { /* already gone */ }
    removePid();
    process.exit(1);
    break;
  }

  case 'status': {
    const status = isRunning();
    if (!status.running) {
      console.log('[claude-patrol] Not running.');
      process.exit(1);
    }

    const uptime = Math.round((Date.now() - new Date(status.startedAt).getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    const uptimeStr = hours > 0
      ? `${hours}h ${minutes}m ${seconds}s`
      : minutes > 0
        ? `${minutes}m ${seconds}s`
        : `${seconds}s`;

    console.log(`[claude-patrol] Running`);
    console.log(`  URL:     http://localhost:${status.port}`);
    console.log(`  PID:     ${status.pid}`);
    console.log(`  Uptime:  ${uptimeStr}`);
    break;
  }

  case 'clean': {
    const status = isRunning();
    if (status.running) {
      console.error('[claude-patrol] Server is still running. Stop it first with "claude-patrol stop".');
      process.exit(1);
    }

    const files = [
      { path: pidPath(), label: 'PID file' },
      { path: mcpConfigPath(), label: 'MCP config' },
    ];

    // Try to read actual db_path from config, fall back to default
    let dbPath = defaultDbPath();
    try {
      const { loadConfig } = await import('../src/config.js');
      const cfg = loadConfig();
      if (cfg.db_path) dbPath = cfg.db_path;
    } catch {
      // Config missing or invalid - use default
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      files.push({ path: dbPath + suffix, label: `DB${suffix || ''}` });
    }

    let removed = 0;
    for (const { path, label } of files) {
      if (existsSync(path)) {
        try {
          unlinkSync(path);
          console.log(`  Removed ${label}: ${path}`);
          removed++;
        } catch (err) {
          console.error(`  Failed to remove ${label}: ${err.message}`);
        }
      }
    }

    // Remove empty XDG directories
    for (const dir of [stateDir(), dataDir(), configDir()]) {
      // Only remove if the dir is now empty (or only has hidden files we already removed)
      try {
        rmSync(dir, { recursive: false });
        console.log(`  Removed directory: ${dir}`);
        removed++;
      } catch {
        // Not empty or doesn't exist - fine
      }
    }

    if (removed === 0) {
      console.log('[claude-patrol] Nothing to clean.');
    } else {
      console.log(`[claude-patrol] Cleaned ${removed} item(s).`);
    }
    console.log('[claude-patrol] Config preserved at: ' + configPath());
    break;
  }

  case 'attach': {
    const status = isRunning();
    if (!status.running) {
      console.error('[claude-patrol] Not running. Start the server first.');
      process.exit(1);
    }

    // Fetch active sessions from the running server
    let sessions;
    try {
      const res = await fetch(`http://localhost:${status.port}/api/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sessions = await res.json();
    } catch (err) {
      console.error(`[claude-patrol] Failed to fetch sessions: ${err.message}`);
      process.exit(1);
    }

    if (sessions.length === 0) {
      console.log('[claude-patrol] No active sessions.');
      process.exit(0);
    }

    // Fetch workspaces for context
    let workspaces = [];
    try {
      const res = await fetch(`http://localhost:${status.port}/api/workspaces`);
      if (res.ok) workspaces = await res.json();
    } catch { /* non-fatal */ }
    const wsMap = Object.fromEntries(workspaces.map(w => [w.id, w]));

    // If a session ID fragment was passed, match it directly
    const targetArg = args[1];
    let target = null;

    if (targetArg) {
      target = sessions.find(s => s.id === targetArg || s.id.startsWith(targetArg));
      if (!target) {
        console.error(`[claude-patrol] No session matching "${targetArg}".`);
        process.exit(1);
      }
    } else if (sessions.length === 1) {
      target = sessions[0];
    } else {
      // List sessions and let user pick
      console.log('[claude-patrol] Active sessions:\n');
      sessions.forEach((s, i) => {
        const ws = s.workspace_id ? wsMap[s.workspace_id] : null;
        const label = ws ? `${ws.repo} #${ws.pr_number} (${ws.branch})` : 'Global';
        const age = Math.round((Date.now() - new Date(s.started_at).getTime()) / 60000);
        console.log(`  ${i + 1}) ${s.id.slice(0, 8)}  ${label}  (${age}m ago, ${s.status})`);
      });

      // Read single keypress for selection
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => rl.question('\nSelect session number: ', resolve));
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
        console.error('[claude-patrol] Invalid selection.');
        process.exit(1);
      }
      target = sessions[idx];
    }

    const tmuxName = `patrol-${target.id}`;
    console.log(`[claude-patrol] Attaching to ${tmuxName}...`);

    // Replace this process with tmux attach
    const { execFileSync: execSync2 } = await import('node:child_process');
    try {
      execSync2('tmux', ['attach-session', '-t', tmuxName], { stdio: 'inherit' });
    } catch (err) {
      if (err.status) process.exit(err.status);
      throw err;
    }
    break;
  }

  case '--help':
  case '-h':
  case 'help': {
    console.log(`Usage: claude-patrol <command> [options]

Commands:
  start [--open]     Start the server (default; --open to launch browser)
  stop               Stop the running server
  status             Check if the server is running
  attach [id]        Attach terminal to a running session (tmux)
  clean              Remove data files (DB, PID, MCP config)
  help               Show this help

Config: ${configPath()}
Data:   ${dataDir()}
State:  ${stateDir()}`);
    break;
  }

  default:
    console.error(`Unknown command: ${command}. Run "claude-patrol help" for usage.`);
    process.exit(1);
}
