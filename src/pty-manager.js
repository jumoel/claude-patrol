import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import pty from 'node-pty';
import { appEvents, emitSessionState } from './app-events.js';
import { getDb } from './db.js';
import { mcpConfigPath as getMcpConfigPath } from './paths.js';
import { archiveTranscript } from './transcripts.js';
import { expandPath, toClaudeProjectKey } from './utils.js';

const BUFFER_MAX = 50_000;
const IDLE_THRESHOLD_MS = 5000;
export const BOOT_TIMEOUT_MS_DEFAULT = 30_000;

/**
 * Strip ANSI escape sequences and return the count of printable characters.
 * Used to distinguish real content output from TUI status-bar refreshes.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\(.|>[0-9]*|=[0-9]*|[ #%()*+\-.\/][A-Za-z0-9]?)/g;
function printableLength(data) {
  // Strip escape sequences, then count non-control characters
  const stripped = data.replace(ANSI_RE, '');
  let count = 0;
  for (let i = 0; i < stripped.length; i++) {
    const code = stripped.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) count++;
  }
  return count;
}

const PATROL_SYSTEM_PROMPT = readFileSync(resolve(import.meta.dirname, 'patrol-system-prompt.md'), 'utf8');

/** @type {string | null} */
let mcpConfigPathCached = null;

/**
 * Write the MCP config JSON for the patrol server. Called once at startup,
 * and again whenever the listening port changes. Spawned Claude sessions
 * point at the in-process HTTP MCP endpoint inside the running Patrol
 * server, so there is no per-session subprocess.
 * @param {object} config
 */
export function initMcpConfig(config) {
  const configJson = {
    mcpServers: {
      patrol: {
        type: 'http',
        url: `http://127.0.0.1:${config.port}/mcp`,
      },
    },
  };
  mcpConfigPathCached = getMcpConfigPath();
  writeFileSync(mcpConfigPathCached, JSON.stringify(configJson, null, 2));
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
 * Spawn a node-pty attached to an existing tmux session and wire up
 * output buffering, WebSocket broadcast, and exit handling.
 * @param {string} sessionId
 * @param {{ claudeProjectDir?: string, startedAt?: string }} meta
 * @returns {SessionEntry}
 */
function attachPtyToTmux(sessionId, meta = {}) {
  const db = getDb();
  const tmuxName = `patrol-${sessionId}`;
  const proc = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: { ...process.env },
  });

  db.prepare('UPDATE sessions SET pid = ?, status = ? WHERE id = ?').run(proc.pid, 'active', sessionId);

  // Look up workspace_id once for idle event payloads
  const sessionRow = db.prepare('SELECT workspace_id FROM sessions WHERE id = ?').get(sessionId);
  const workspaceId = sessionRow?.workspace_id || null;

  // Activity state: null (untracked) | 'working' | 'idle'
  //   null -> working:  first substantial output (>= BURST_BYTE_THRESHOLD)
  //   working -> idle:  IDLE_THRESHOLD_MS of no substantial output
  //   idle -> working:  substantial output resumes
  // "Idle" only applies to sessions that WERE working and went silent.
  // Untracked sessions show "Session" badge in the UI.
  let state = null;
  let idleTimer = null;
  function setState(s) {
    state = s;
    entry.activityState = s;
  }

  // Activity detection: count distinct "moments" of printable output.
  // A moment = an onData with printable bytes, separated from the previous
  // by at least MOMENT_GAP ms (debounces batched tmux status-bar chunks into
  // one moment). Tmux status bar: events arrive within <50ms of each other
  // = 1 moment. Spinner/TUI: frames every 100-250ms = separate moments.
  let momentCount = 0;
  let lastMomentAt = 0;
  let momentTimer = null;
  const MOMENT_GAP = 50; // ms between events to count as distinct
  const MOMENT_THRESHOLD = 3; // moments needed to transition to working
  const MOMENT_WINDOW = 10_000; // reset if no output for this long
  const LARGE_OUTPUT = 500; // instant transition for big chunks
  const MIN_PRINTABLE = 10; // ignore events with fewer printable chars (status bar refreshes)

  const entry = {
    proc,
    buffer: new RingBuffer(BUFFER_MAX),
    websockets: new Set(),
    resizeSuppressUntil: Date.now() + 500,
    activityState: state, // exposed for getSessionStates()
    workspaceId, // exposed for getSessionStates()
  };

  proc.onData((data) => {
    entry.buffer.append(data);
    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of entry.websockets) {
      if (ws.readyState === 1) ws.send(msg);
    }

    // Ignore resize-triggered redraws (full screen repaint from terminal open).
    if (Date.now() < entry.resizeSuppressUntil) return;

    // Ignore events with negligible printable content (TUI status-bar refreshes,
    // cursor repositioning, etc.). Only compute when not already working, since
    // once working any output should keep the idle timer alive.
    if (state !== 'working' && printableLength(data) < MIN_PRINTABLE) return;

    if (state === 'working') {
      // Already working - any output resets the idle countdown.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        setState('idle');
        emitSessionState(sessionId, workspaceId, 'idle');
      }, IDLE_THRESHOLD_MS);
    } else {
      // State is null or 'idle'. Count distinct output moments.
      // The moment debounce (MOMENT_GAP) handles tmux batching.
      const now = Date.now();
      if (now - lastMomentAt >= MOMENT_GAP) {
        lastMomentAt = now;
        momentCount++;
        if (momentTimer) clearTimeout(momentTimer);
        momentTimer = setTimeout(() => {
          momentCount = 0;
        }, MOMENT_WINDOW);
      }

      if (momentCount >= MOMENT_THRESHOLD || data.length >= LARGE_OUTPUT) {
        setState('working');
        momentCount = 0;
        emitSessionState(sessionId, workspaceId, 'working');
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          setState('idle');
          emitSessionState(sessionId, workspaceId, 'idle');
        }, IDLE_THRESHOLD_MS);
      }
    }
  });

  proc.onExit(({ exitCode }) => {
    if (idleTimer) clearTimeout(idleTimer);
    if (momentTimer) clearTimeout(momentTimer);
    emitSessionState(sessionId, workspaceId, 'exited');
    const exitMsg = JSON.stringify({ type: 'exit', code: exitCode });
    for (const ws of entry.websockets) {
      if (ws.readyState === 1) {
        ws.send(exitMsg);
        ws.close(1000);
      }
    }
    sessions.delete(sessionId);
    const endedAt = new Date().toISOString();
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(endedAt, sessionId);

    if (meta.claudeProjectDir) {
      setTimeout(() => {
        archiveTranscript(sessionId, meta.claudeProjectDir, meta.startedAt, endedAt);
      }, 500);
    }
  });

  sessions.set(sessionId, entry);
  return entry;
}

/**
 * Mark orphaned sessions from a previous server run as killed.
 */
export function cleanupOrphanedSessions() {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE status IN ('active', 'detached')").run(now);
}

/**
 * Kill any orphaned tmux sessions from a previous server run.
 */
export function cleanupOrphanedTmuxSessions() {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    for (const line of output.trim().split('\n')) {
      const name = line.trim();
      if (name.startsWith('patrol-')) {
        try {
          execFileSync('tmux', ['kill-session', '-t', name], { timeout: 5000 });
          console.log(`[pty-manager] Killed orphaned tmux session: ${name}`);
        } catch {
          /* session may have already died */
        }
      }
    }
  } catch {
    // tmux server not running or no sessions - that's fine
  }
}

/**
 * Reattach to surviving tmux sessions from a previous server run.
 * Used in watch/dev mode to preserve sessions across server restarts.
 * Sessions whose tmux process is dead are marked killed.
 * @returns {number} number of sessions reattached
 */
export function reattachOrphanedSessions() {
  const db = getDb();
  const orphans = db.prepare("SELECT * FROM sessions WHERE status IN ('active', 'detached')").all();
  if (orphans.length === 0) return 0;

  let reattached = 0;
  const now = new Date().toISOString();

  for (const session of orphans) {
    if (!isTmuxSessionAlive(session.id)) {
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(now, session.id);
      console.log(`[pty-manager] Orphaned session ${session.id} - tmux dead, marked killed`);
      continue;
    }

    try {
      // Ensure status bar is off (may have been on from older sessions)
      const tmuxName = `patrol-${session.id}`;
      try { execFileSync('tmux', ['set-option', '-t', tmuxName, 'status', 'off'], { timeout: 5_000 }); } catch {}
      attachPtyToTmux(session.id, {
        claudeProjectDir: session.claude_project_dir,
        startedAt: session.started_at,
      });
      reattached++;
      console.log(`[pty-manager] Reattached to session ${session.id}`);
    } catch (err) {
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(now, session.id);
      console.warn(`[pty-manager] Failed to reattach session ${session.id}: ${err.message}`);
    }
  }

  return reattached;
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
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        existing.id,
      );
    }
  }

  // For workspace sessions, return existing if alive (prevent concurrent edits)
  if (workspaceId) {
    const existing = db.prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status = 'active'").get(workspaceId);
    if (existing && sessions.has(existing.id)) {
      if (isTmuxSessionAlive(existing.id)) {
        return existing;
      }
      sessions.delete(existing.id);
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        existing.id,
      );
    }
  }

  const id = randomUUID();
  const tmuxName = `patrol-${id}`;

  // Build the claude command with args
  const claudeArgs = ['claude'];
  if (mcpConfigPathCached) {
    claudeArgs.push('--mcp-config', mcpConfigPathCached);

    // Write system prompt to a temp file to avoid shell escaping issues
    const promptFile = resolve(tmpdir(), `patrol-prompt-${id}.txt`);
    writeFileSync(promptFile, PATROL_SYSTEM_PROMPT);
    claudeArgs.push('--append-system-prompt-file', promptFile);

    claudeArgs.push('--allowedTools', 'mcp__patrol__*', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent');
  }
  // 1. Create detached tmux session running claude.
  // tmux new-session takes a single shell-command string, so we must
  // shell-escape each arg and join them into one string.
  const shellCmd = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '30', '-c', cwd, shellCmd], {
    timeout: 10_000,
  });
  // Disable tmux chrome (status bar) so its periodic redraws don't
  // produce terminal output that triggers false activity detection.
  execFileSync('tmux', ['set-option', '-t', tmuxName, 'status', 'off'], { timeout: 5_000 });

  // 2. Attach node-pty to the tmux session (for WebSocket I/O)
  const now = new Date().toISOString();
  const claudeProjectDir = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(cwd));

  db.prepare(
    'INSERT INTO sessions (id, workspace_id, pid, status, started_at, claude_project_dir) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, workspaceId, 0, 'active', now, claudeProjectDir);

  attachPtyToTmux(id, { claudeProjectDir, startedAt: now });

  return { id, workspace_id: workspaceId, status: 'active', started_at: now, claude_project_dir: claudeProjectDir };
}

/**
 * Create a session that resumes an existing Claude conversation.
 * Same as createSession but adds `--resume <claudeSessionId>` to the claude args.
 * @param {string | null} workspaceId
 * @param {string} cwd
 * @param {string} claudeSessionId - Claude CLI session UUID to resume
 * @returns {object} session record
 */
export function createResumedSession(workspaceId, cwd, claudeSessionId) {
  const db = getDb();
  const id = randomUUID();
  const tmuxName = `patrol-${id}`;

  const claudeArgs = ['claude', '--resume', claudeSessionId];
  if (mcpConfigPathCached) {
    claudeArgs.push('--mcp-config', mcpConfigPathCached);

    const promptFile = resolve(tmpdir(), `patrol-prompt-${id}.txt`);
    writeFileSync(promptFile, PATROL_SYSTEM_PROMPT);
    claudeArgs.push('--append-system-prompt-file', promptFile);

    claudeArgs.push('--allowedTools', 'mcp__patrol__*', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent');
  }

  const shellCmd = claudeArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '30', '-c', cwd, shellCmd], {
    timeout: 10_000,
  });
  execFileSync('tmux', ['set-option', '-t', tmuxName, 'status', 'off'], { timeout: 5_000 });

  const now = new Date().toISOString();
  const claudeProjectDir = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(cwd));

  db.prepare(
    'INSERT INTO sessions (id, workspace_id, pid, status, started_at, claude_project_dir) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, workspaceId, 0, 'active', now, claudeProjectDir);

  attachPtyToTmux(id, { claudeProjectDir, startedAt: now });

  return { id, workspace_id: workspaceId, status: 'active', started_at: now, claude_project_dir: claudeProjectDir };
}

/**
 * WebSocket message dispatch table. Each entry owns both validation and
 * handling for a single message type, so adding a new type is one entry -
 * impossible to add a handler without validation or vice versa. Previously
 * had a separate `parseWsMessage` whitelist that drifted from the dispatcher
 * and silently dropped `prompt-submit` messages for the duration of the
 * f2436f3 → ebf502f window. (See `claude-patrol#2`.)
 *
 * Handlers receive `(entry, msg, ctx)`. `ctx` carries per-session info that
 * isn't on the entry itself (currently just `tmuxName`).
 *
 * @type {Record<string, {
 *   validate: (msg: any) => boolean,
 *   handle: (entry: any, msg: any, ctx: { tmuxName: string }) => void,
 * }>}
 */
const WS_MESSAGE_HANDLERS = {
  input: {
    validate: (msg) => typeof msg.data === 'string',
    handle: (entry, msg, ctx) => {
      // CSI u sequences (kitty keyboard protocol) can't go through tmux's
      // input parser - it doesn't understand them. Route them via
      // `tmux send-keys` which writes directly to the inner pane's PTY,
      // bypassing tmux's own key interpretation.
      if (msg.data.includes('\x1b[') && /\x1b\[\d+;\d+u/.test(msg.data)) {
        const hexKeys = [];
        for (let i = 0; i < msg.data.length; i++) {
          hexKeys.push(msg.data.charCodeAt(i).toString(16).padStart(2, '0'));
        }
        execFile('tmux', ['send-keys', '-t', ctx.tmuxName, '-H', ...hexKeys], { timeout: 2000 }, () => {});
      } else {
        entry.proc.write(msg.data);
      }
    },
  },
  'prompt-submit': {
    // Programmatic prompt submission: write the text, wait briefly, write
    // Enter. Shares `submitPromptToEntry` with the server-side rules engine
    // so the split timing lives in one place.
    validate: (msg) => typeof msg.text === 'string',
    handle: (entry, msg) => {
      submitPromptToEntry(entry, msg.text).catch(() => {});
    },
  },
  resize: {
    validate: (msg) => Number.isInteger(msg.cols) && Number.isInteger(msg.rows),
    handle: (entry, msg) => {
      try {
        entry.proc.resize(msg.cols, msg.rows);
      } catch {
        // PTY fd already closed (EBADF) - session exited but WS still open
        return;
      }
      // Suppress activity detection for 500ms - the resize triggers a full
      // tmux redraw that produces multiple onData events with printable content.
      entry.resizeSuppressUntil = Date.now() + 500;
    },
  },
};

/**
 * Dispatch a parsed WS message to its handler. Returns the handler entry that
 * was invoked (for testing) or null if the message was rejected. Exported so
 * tests can hit the validation + dispatch path without standing up a real
 * WebSocket + PTY.
 *
 * @param {string} raw - raw WS frame text
 * @param {any}    entry - session entry from the `sessions` map
 * @param {{tmuxName: string}} ctx
 * @returns {{ type: string } | null}
 */
export function dispatchWsMessage(raw, entry, ctx) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg.type !== 'string') return null;
  const handler = WS_MESSAGE_HANDLERS[msg.type];
  if (!handler || !handler.validate(msg)) return null;
  handler.handle(entry, msg, ctx);
  return { type: msg.type };
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
    ws.close(1000);
    return;
  }

  // Send replay buffer
  const replay = entry.buffer.contents();
  if (replay.length > 0) {
    ws.send(JSON.stringify({ type: 'replay', data: replay.toString() }));
  }

  entry.websockets.add(ws);

  const tmuxName = `patrol-${sessionId}`;
  ws.on('message', (raw) => {
    dispatchWsMessage(raw.toString(), entry, { tmuxName });
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
    }
  }
  // Always clear state - for attached sessions proc.onExit handles it,
  // but for detached sessions (not in the sessions map) we must do it here.
  const wsRow = getDb().prepare('SELECT workspace_id FROM sessions WHERE id = ?').get(sessionId);
  emitSessionState(sessionId, wsRow?.workspace_id || null, 'exited');
  // For detached sessions (not in the sessions map), the proc.onExit
  // handler won't fire, so update the DB directly.
  if (!sessions.has(sessionId)) {
    const db = getDb();
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ? AND status != 'killed'").run(
      new Date().toISOString(),
      sessionId,
    );
  }
}

/**
 * Kill all live PTY sessions. Used during graceful shutdown.
 * Closes all WebSockets first so server.close() doesn't hang waiting
 * for connections to drain.
 */
/** @returns {number} number of live in-memory sessions */
export function activeSessionCount() {
  return sessions.size;
}

/**
 * Get the current activity state for all tracked sessions.
 * Used to seed new SSE clients with the current state.
 * @returns {Array<{ sessionId: string, workspaceId: string | null, state: 'working' | 'idle' }>}
 */
export function getSessionStates() {
  const results = [];
  for (const [sessionId, entry] of sessions) {
    if (entry.activityState) {
      results.push({
        sessionId,
        workspaceId: entry.workspaceId ?? null,
        state: entry.activityState,
      });
    }
  }
  return results;
}

export function killAllSessions() {
  // Close all WebSockets immediately so the HTTP server can shut down cleanly
  for (const entry of sessions.values()) {
    for (const ws of entry.websockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    entry.websockets.clear();
  }
  // Now kill the tmux sessions / pty processes
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
  const entry = sessions.get(sessionId);
  if (!entry) {
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

  // Detach the node-pty client from the tmux session so the web
  // terminal's small dimensions no longer constrain the window size.
  // Tell all WebSocket clients the session was popped out, then
  // kill the node-pty process (the tmux session itself stays alive
  // in Ghostty). Mark as 'detached' so it can be reattached later.
  const popMsg = JSON.stringify({ type: 'popped-out' });
  for (const ws of entry.websockets) {
    if (ws.readyState === 1) {
      ws.send(popMsg);
      ws.close(1000);
    }
  }
  entry.proc.kill();
  sessions.delete(sessionId);

  const db = getDb();
  db.prepare("UPDATE sessions SET status = 'detached' WHERE id = ?").run(sessionId);

  // Clean up the temp script after a short delay
  setTimeout(() => {
    try {
      unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
  }, 5000);
}

/**
 * Reattach a detached session (e.g. after pop-out) back to the web UI.
 * @param {string} sessionId
 * @returns {object} session record
 */
export function reattachSession(sessionId) {
  if (sessions.has(sessionId)) {
    // Already attached - return existing
    const db = getDb();
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  }

  const db = getDb();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'detached'").get(sessionId);
  if (!row) throw new Error('Session not found or not detached');

  if (!isTmuxSessionAlive(sessionId)) {
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      sessionId,
    );
    throw new Error('Session tmux process is no longer alive');
  }

  attachPtyToTmux(sessionId, {
    claudeProjectDir: row.claude_project_dir,
    startedAt: row.started_at,
  });

  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

/**
 * Write text directly into a session's PTY. Used by server-side callers
 * (rules engine, future automation) to inject prompts. Callers append
 * any submission key (e.g. '\r') themselves.
 * @param {string} sessionId
 * @param {string} text
 * @returns {boolean} false if session not found or not active
 */
export function writeToSession(sessionId, text) {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  entry.proc.write(text);
  return true;
}

/**
 * Default delay between writing prompt text and writing the Enter that
 * submits it. Single source of truth for both the WS `prompt-submit` handler
 * and the server-side `sendPromptToSession` helper. If you find yourself
 * defining a "delay" constant elsewhere for the same purpose, route through
 * here instead.
 */
const PROMPT_SUBMIT_DELAY_MS = 100;

/**
 * Internal: write `text + Enter` to a session entry's PTY using the two-step
 * split that Claude's TUI requires (text first, brief delay, then Enter).
 * Sending them as a single write can cause the TUI to swallow Enter while
 * still painting the input field.
 *
 * Both the WebSocket `prompt-submit` handler and `sendPromptToSession` route
 * through here so the split lives in exactly one place.
 *
 * @param {object} entry - session entry from `sessions` map
 * @param {string} text
 * @param {number} delay
 * @returns {Promise<void>}
 */
async function submitPromptToEntry(entry, text, delay = PROMPT_SUBMIT_DELAY_MS) {
  const stripped = text.replace(/\r+$/, '');
  entry.proc.write(stripped);
  await new Promise((r) => setTimeout(r, delay));
  entry.proc.write('\r');
}

/**
 * Submit a prompt to a Claude session: write the text, wait briefly so the
 * PTY can render it into the input field, then send Enter as a separate
 * write. Server-side counterpart to the WS `prompt-submit` message - both
 * share the same `submitPromptToEntry` helper, so the split timing can't drift.
 *
 * Strips any trailing `\r` from the input. The Enter is always sent.
 *
 * @param {string} sessionId
 * @param {string} prompt
 * @param {{delay?: number}} [opts] - ms to wait between text and Enter (default 100)
 * @returns {Promise<boolean>} false if session not found
 */
export async function sendPromptToSession(sessionId, prompt, { delay = PROMPT_SUBMIT_DELAY_MS } = {}) {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  await submitPromptToEntry(entry, prompt, delay);
  return true;
}

/**
 * Resolve when the session emits its first 'idle' event after this call.
 * If the session is already in 'idle' state, resolves immediately.
 * Rejects if the session exits, is not found, or the timeout elapses.
 * @param {string} sessionId
 * @param {number} [timeoutMs=BOOT_TIMEOUT_MS_DEFAULT]
 * @returns {Promise<void>}
 */
export function waitForFirstIdle(sessionId, timeoutMs = BOOT_TIMEOUT_MS_DEFAULT) {
  return new Promise((resolve, reject) => {
    const entry = sessions.get(sessionId);
    if (!entry) return reject(new Error(`Session ${sessionId} not found`));
    if (entry.activityState === 'idle') return resolve();

    const handler = (data) => {
      if (data.sessionId !== sessionId) return;
      if (data.state === 'idle') {
        cleanup();
        resolve();
      } else if (data.state === 'exited') {
        cleanup();
        reject(new Error(`Session ${sessionId} exited before reaching idle`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Session ${sessionId} did not reach idle within ${timeoutMs}ms`));
    }, timeoutMs);
    function cleanup() {
      appEvents.removeListener('session-state', handler);
      clearTimeout(timer);
    }
    appEvents.on('session-state', handler);
  });
}
