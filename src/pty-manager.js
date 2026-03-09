import pty from 'node-pty';
import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

const BUFFER_MAX = 50_000;

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
      return existing;
    }
  }

  // Spawn PTY first - if this throws, no DB row is created
  const proc = pty.spawn('claude', [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env },
  });

  const id = randomUUID();
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

/**
 * Check if a session is alive in memory.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isSessionAlive(sessionId) {
  return sessions.has(sessionId);
}
