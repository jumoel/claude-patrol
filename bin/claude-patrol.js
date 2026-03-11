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
    const noOpen = args.includes('--no-open');
    const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
    console.log('[claude-patrol] Building frontend...');
    execSync('pnpm --filter claude-patrol-frontend build', { cwd: rootDir, stdio: 'inherit' });
    const { startServer } = await import('../src/index.js');
    await startServer({ noOpen });
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

  case '--help':
  case '-h':
  case 'help': {
    console.log(`Usage: claude-patrol <command> [options]

Commands:
  start [--no-open]  Start the server (default)
  stop               Stop the running server
  status             Check if the server is running
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
