import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from './db.js';

const BUFFER_MAX = 50_000;

const PATROL_SYSTEM_PROMPT = readFileSync(resolve(import.meta.dirname, 'patrol-system-prompt.md'), 'utf8');

/** @type {string | null} */
let mcpConfigPath = null;

/**
 * Write the MCP config JSON for the patrol server. Called once at startup.
 * @param {object} config
 */
export function initMcpConfig(config) {
  const mcpServerPath = resolve(import.meta.dirname, 'mcp-server.js');
  const configJson = {
    mcpServers: {
      patrol: {
        type: 'stdio',
        command: 'node',
        args: [mcpServerPath],
        env: { PATROL_PORT: String(config.port) },
      },
    },
  };
  mcpConfigPath = resolve(config.db_path, '..', '.patrol-mcp.json');
  writeFileSync(mcpConfigPath, JSON.stringify(configJson, null, 2));
}

/** Alias for config change handler - re-writes MCP config with new port. */
export const updateMcpConfig = initMcpConfig;

/**
 * Fixed-size ring buffer that avoids allocations on append.
 */
class RingBuffer {
  constructor(capacity) {
    this.buf = Buffer.alloc(capacity);
    this.len = 0;
  }

  append(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (chunk.length >= this.buf.length) {
      // Data larger than buffer - keep only the tail
      chunk.copy(this.buf, 0, chunk.length - this.buf.length);
      this.len = this.buf.length;
    } else if (this.len + chunk.length <= this.buf.length) {
      // Fits without eviction
      chunk.copy(this.buf, this.len);
      this.len += chunk.length;
    } else {
      // Evict oldest bytes to make room
      const keep = this.buf.length - chunk.length;
      this.buf.copy(this.buf, 0, this.len - keep, this.len);
      chunk.copy(this.buf, keep);
      this.len = this.buf.length;
    }
  }

  contents() {
    return this.buf.subarray(0, this.len);
  }
}

/**
 * @typedef {object} SessionEntry
 * @property {import('node-pty').IPty} proc
 * @property {RingBuffer} buffer
 * @property {Set<import('ws').WebSocket>} websockets
 */

/** @type {Map<string, SessionEntry>} */
const sessions = new Map();

/**
 * Mark orphaned sessions from a previous server run as killed.
 */
export function cleanupOrphanedSessions() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE status = 'active'").run(now);
}

/**
 * Kill any orphaned tmux sessions from a previous server run.
 */
export function cleanupOrphanedTmuxSessions() {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', timeout: 5000 });
    for (const line of output.trim().split('\n')) {
      const name = line.trim();
      if (name.startsWith('patrol-')) {
        try {
          execFileSync('tmux', ['kill-session', '-t', name], { timeout: 5000 });
          console.log(`[pty-manager] Killed orphaned tmux session: ${name}`);
        } catch { /* session may have already died */ }
      }
    }
  } catch {
    // tmux server not running or no sessions - that's fine
  }
}

/**
 * Spawn a new PTY session. Spawns the process first, then inserts into DB.
 * @param {string | null} workspaceId - null for global session
 * @param {string} cwd - working directory
 * @returns {object} session record
 */
export function createSession(workspaceId, cwd) {
  const db = getDb();

  // For global sessions, return existing if alive
  if (!workspaceId) {
    const existing = db.prepare("SELECT * FROM sessions WHERE workspace_id IS NULL AND status = 'active'").get();
    if (existing && sessions.has(existing.id)) {
      if (isTmuxSessionAlive(existing.id)) {
        return existing;
      }
      // tmux session is dead but map entry is stale - clean up
      sessions.delete(existing.id);
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
    }
  }

  const id = randomUUID();
  const tmuxName = `patrol-${id}`;

  // Build the claude command with args
  const claudeArgs = ['claude'];
  if (mcpConfigPath) {
    claudeArgs.push('--mcp-config', mcpConfigPath);
    claudeArgs.push('--append-system-prompt', PATROL_SYSTEM_PROMPT);
    claudeArgs.push('--allowedTools', 'mcp__patrol__*', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent');
  }

  // 1. Create detached tmux session running claude
  execFileSync('tmux', [
    'new-session', '-d', '-s', tmuxName,
    '-x', '120', '-y', '30',
    '-c', cwd,
    ...claudeArgs,
  ], { timeout: 10_000 });

  // 2. Attach node-pty to the tmux session (for WebSocket I/O)
  const proc = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env },
  });

  const now = new Date().toISOString();

  db.prepare('INSERT INTO sessions (id, workspace_id, pid, status, started_at) VALUES (?, ?, ?, ?, ?)').run(
    id, workspaceId, proc.pid, 'active', now
  );

  const entry = {
    proc,
    buffer: new RingBuffer(BUFFER_MAX),
    websockets: new Set(),
  };

  proc.onData((data) => {
    entry.buffer.append(data);

    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of entry.websockets) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  });

  proc.onExit(({ exitCode }) => {
    const exitMsg = JSON.stringify({ type: 'exit', code: exitCode });
    for (const ws of entry.websockets) {
      if (ws.readyState === 1) {
        ws.send(exitMsg);
        ws.close();
      }
    }
    sessions.delete(id);
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  });

  sessions.set(id, entry);

  return { id, workspace_id: workspaceId, pid: proc.pid, status: 'active', started_at: now };
}

/**
 * Parse and validate a WebSocket message.
 * @param {string} raw
 * @returns {{ type: string, data?: string, cols?: number, rows?: number } | null}
 */
function parseWsMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (msg.type === 'input' && typeof msg.data === 'string') return msg;
    if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) return msg;
    return null;
  } catch {
    return null;
  }
}

/**
 * Attach a WebSocket to an existing session.
 * @param {string} sessionId
 * @param {import('ws').WebSocket} ws
 */
export function attachSession(sessionId, ws) {
  const entry = sessions.get(sessionId);
  if (!entry) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found or not running' }));
    ws.close();
    return;
  }

  // Send replay buffer
  const replay = entry.buffer.contents();
  if (replay.length > 0) {
    ws.send(JSON.stringify({ type: 'replay', data: replay.toString() }));
  }

  entry.websockets.add(ws);

  ws.on('message', (raw) => {
    const msg = parseWsMessage(raw.toString());
    if (!msg) return;

    if (msg.type === 'input') {
      entry.proc.write(msg.data);
    } else if (msg.type === 'resize') {
      entry.proc.resize(msg.cols, msg.rows);
    }
  });

  ws.on('close', () => {
    entry.websockets.delete(ws);
  });
}

/**
 * Kill a session by ID.
 * @param {string} sessionId
 */
export function killSession(sessionId) {
  const tmuxName = `patrol-${sessionId}`;
  try {
    execFileSync('tmux', ['kill-session', '-t', tmuxName], { timeout: 5000 });
  } catch {
    // tmux session already dead - kill the pty directly as fallback
    const entry = sessions.get(sessionId);
    if (entry) {
      entry.proc.kill();
    } else {
      const db = getDb();
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ? AND status != 'killed'").run(
        new Date().toISOString(), sessionId
      );
    }
  }
}

/**
 * Kill all live PTY sessions. Used during graceful shutdown.
 */
export function killAllSessions() {
  for (const [id] of sessions) {
    killSession(id);
  }
}

/**
 * Check if a tmux session is alive by name.
 * @param {string} sessionId
 * @returns {boolean}
 */
function isTmuxSessionAlive(sessionId) {
  try {
    execFileSync('tmux', ['has-session', '-t', `patrol-${sessionId}`], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a session is alive in memory and its tmux session is still running.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionAlive(sessionId) {
  if (!sessions.has(sessionId)) return false;
  return isTmuxSessionAlive(sessionId);
}

/**
 * Pop out a session into a Ghostty terminal window.
 * Opens a new Ghostty instance attached to the same tmux session.
 * @param {string} sessionId
 */
export function popOutSession(sessionId) {
  if (!sessions.has(sessionId)) {
    throw new Error('Session not found or not running');
  }
  if (!isTmuxSessionAlive(sessionId)) {
    throw new Error('Session tmux process is not alive');
  }

  const tmuxName = `patrol-${sessionId}`;
  const scriptPath = resolve(tmpdir(), `patrol-ghostty-${sessionId}.sh`);

  writeFileSync(scriptPath, `#!/bin/sh\nexec tmux attach-session -t ${tmuxName}\n`);
  chmodSync(scriptPath, 0o755);

  execFileSync('open', ['-na', 'Ghostty.app', '--args', '-e', scriptPath], { timeout: 10_000 });

  // Clean up the temp script after a short delay
  setTimeout(() => {
    try { unlinkSync(scriptPath); } catch { /* ignore */ }
  }, 5000);
}
