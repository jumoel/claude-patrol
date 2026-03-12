/**
 * Watch mode: runs the backend server and `vite build --watch` concurrently.
 * Vite output is prefixed with [vite]; the server inherits stdio directly so
 * the TUI works (raw mode, cursor positioning, etc.).
 *
 * Backend file changes trigger a server restart with --reattach, which
 * preserves active terminal sessions (tmux sessions survive, node-pty
 * reattaches on startup, browser WebSockets auto-reconnect).
 */

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FRONTEND = resolve(ROOT, 'frontend');
const SRC = resolve(ROOT, 'src');

function prefix(label, color) {
  const colors = { cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m' };
  return `${colors[color] || ''}[${label}]\x1b[0m `;
}

function pipeWithPrefix(stream, label, color) {
  const tag = prefix(label, color);
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) process.stdout.write(tag + line + '\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) process.stdout.write(tag + buffer + '\n');
  });
}

// --- Vite (frontend) ---
const vite = spawn('npx', ['vite', 'build', '--watch'], {
  cwd: FRONTEND,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
pipeWithPrefix(vite.stdout, 'vite', 'cyan');
pipeWithPrefix(vite.stderr, 'vite', 'cyan');

// --- Server (backend) ---
let server = null;
let serverExitedIntentionally = false;

const serverArgs = process.argv.slice(2);

function startServer(reattach) {
  const args = [resolve(ROOT, 'src/index.js'), ...serverArgs];
  if (reattach) args.push('--reattach');

  server = spawn('node', args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env },
  });

  server.on('exit', (code) => {
    server = null;
    if (serverExitedIntentionally) {
      serverExitedIntentionally = false;
      return;
    }
    // Exit code 0 means clean shutdown (e.g. Ctrl-C) - exit watch too
    if (code === 0) {
      vite.kill('SIGTERM');
      setTimeout(() => process.exit(0), 1000);
      return;
    }
    if (code === null) return; // killed by signal during cleanup
    console.log(`\n${prefix('watch', 'magenta')}Server crashed (exit ${code}), waiting for file changes to restart...`);
  });
}

function restartServer() {
  if (server) {
    serverExitedIntentionally = true;
    server.kill('SIGTERM');

    // Wait for server to actually exit before starting new one
    server.on('exit', () => {
      process.stdout.write(`${prefix('watch', 'magenta')}Restarting server (reattaching sessions)...\n`);
      startServer(true);
    });
  } else {
    process.stdout.write(`${prefix('watch', 'magenta')}Starting server (reattaching sessions)...\n`);
    startServer(true);
  }
}

// Initial start (no reattach - clean start)
startServer(false);

// --- Backend file watcher ---
let debounceTimer = null;
const DEBOUNCE_MS = 300;

watch(SRC, { recursive: true }, (eventType, filename) => {
  if (!filename) return;
  // Only watch .js files, skip watch.js itself
  if (!filename.endsWith('.js') || filename === 'watch.js') return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    process.stdout.write(`${prefix('watch', 'magenta')}Detected change: src/${filename}\n`);
    restartServer();
  }, DEBOUNCE_MS);
});

// --- Signal handling ---
function cleanup(signal) {
  vite.kill(signal);
  if (server) server.kill(signal);
  // Give processes a moment to exit, then force
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', () => cleanup('SIGTERM'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

vite.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.log(`\n${prefix('watch', 'cyan')}Vite exited with code ${code}`);
  }
});
