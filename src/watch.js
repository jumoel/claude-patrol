/**
 * Watch mode: runs the backend server and `vite build --watch` concurrently,
 * interleaving their output with prefixed labels.
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FRONTEND = resolve(ROOT, 'frontend');

function prefix(label, color) {
  const code = color === 'cyan' ? '\x1b[36m' : '\x1b[33m';
  const reset = '\x1b[0m';
  return `${code}[${label}]${reset} `;
}

function pipeWithPrefix(stream, label, color) {
  const tag = prefix(label, color);
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (line.trim()) process.stdout.write(tag + line + '\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) process.stdout.write(tag + buffer + '\n');
  });
}

// 1. Start vite build --watch
const vite = spawn('npx', ['vite', 'build', '--watch'], {
  cwd: FRONTEND,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env },
});
pipeWithPrefix(vite.stdout, 'vite', 'cyan');
pipeWithPrefix(vite.stderr, 'vite', 'cyan');

// 2. Start the backend server
const server = spawn('node', [resolve(ROOT, 'src/index.js'), ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env },
});
pipeWithPrefix(server.stdout, 'server', 'yellow');
pipeWithPrefix(server.stderr, 'server', 'yellow');

// Forward exit signals
function cleanup(signal) {
  vite.kill(signal);
  server.kill(signal);
}

process.on('SIGINT', () => cleanup('SIGINT'));
process.on('SIGTERM', () => cleanup('SIGTERM'));

// Exit when server dies (vite --watch can survive, but without a server it's useless)
server.on('exit', (code) => {
  console.log(`\n${prefix('watch', 'yellow')}Server exited with code ${code}`);
  vite.kill();
  process.exit(code ?? 1);
});

vite.on('exit', (code) => {
  if (code !== 0) {
    console.log(`\n${prefix('watch', 'cyan')}Vite exited with code ${code}`);
  }
});
