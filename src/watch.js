/**
 * Watch mode: runs the backend server and `vite build --watch` concurrently.
 * Vite output is forwarded to the server via IPC so it renders inside the TUI.
 * The server inherits stdio directly so the TUI works (raw mode, cursor
 * positioning, etc.).
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

/**
 * Collect lines from a stream and call `onLine` for each non-empty line.
 * @param {import('node:stream').Readable} stream
 * @param {(line: string) => void} onLine
 */
function forEachLine(stream, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer);
  });
}

/**
 * Send a log line to the server over IPC. Falls back to stdout if the server
 * isn't connected (e.g. during startup or after a crash).
 */
function sendToServer(line, level = 'log') {
  if (server?.connected) {
    server.send({ type: 'log', msg: line, level });
  } else {
    process.stdout.write(`${line}\n`);
  }
}

// --- Vite (frontend) ---
const vite = spawn(resolve(FRONTEND, 'node_modules/.bin/vite'), ['build', '--watch'], {
  cwd: FRONTEND,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});

const viteTag = prefix('vite', 'cyan');
forEachLine(vite.stdout, (line) => sendToServer(viteTag + line));
forEachLine(vite.stderr, (line) => sendToServer(viteTag + line, 'warn'));

// --- Server (backend) ---
let server = null;
let serverExitedIntentionally = false;

const serverArgs = process.argv.slice(2);

function startServer(reattach) {
  const args = [resolve(ROOT, 'src/index.js'), ...serverArgs];
  if (reattach) args.push('--reattach');

  server = spawn('node', args, {
    cwd: ROOT,
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
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
    // Exit 78 = already running (precondition failure) - exit watch cleanly
    if (code === 78) {
      vite.kill('SIGTERM');
      setTimeout(() => process.exit(1), 1000);
      return;
    }
    console.log(`\n${prefix('watch', 'magenta')}Server crashed (exit ${code}), waiting for file changes to restart...`);
  });
}

function restartServer() {
  if (server) {
    serverExitedIntentionally = true;
    server.kill('SIGTERM');

    // Wait for server to actually exit before starting new one
    server.on('exit', () => {
      sendToServer(`${prefix('watch', 'magenta')}Restarting server (reattaching sessions)...`);
      startServer(true);
    });
  } else {
    sendToServer(`${prefix('watch', 'magenta')}Starting server (reattaching sessions)...`);
    startServer(true);
  }
}

// Initial start (no reattach - clean start)
startServer(false);

// --- Backend file watcher ---
let debounceTimer = null;
const DEBOUNCE_MS = 300;

watch(SRC, { recursive: true }, (_eventType, filename) => {
  if (!filename) return;
  // Only watch .js files, skip watch.js itself
  if (!filename.endsWith('.js') || filename === 'watch.js') return;

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    sendToServer(`${prefix('watch', 'magenta')}Detected change: src/${filename}`);
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
    sendToServer(`${prefix('vite', 'cyan')}Vite exited with code ${code}`, 'error');
  }
});
