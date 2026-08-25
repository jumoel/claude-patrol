import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, chmodSync, constants, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { appEvents, emitLocalChange, emitSessionState } from './app-events.js';
import { getDb } from './db.js';
import { buildSessionLaunch, mcpConfigPathForSession, normalizeSessionProvider } from './session-launch.js';
import {
  normalizeSessionTarget,
  sessionTargetColumns,
  sessionTargetFromRow,
  sessionTargetWhere,
} from './session-target.js';
import { archiveTranscript } from './transcripts.js';

const BUFFER_MAX = 50_000;
// Bumped from 5s to 10s on 2026-05-08. Empirical max mid-turn gap was 1.36s
// during a 15s silent tool call; 10s gives 7x safety margin against
// false-positive idle while a turn is still in flight (lt#17).
const IDLE_THRESHOLD_MS = 10_000;
export const BOOT_TIMEOUT_MS_DEFAULT = 30_000;
// A nested peer-review tool may use its full 30 minute budget. The presenting
// agent's outer Patrol MCP call also includes range setup and process startup.
export const PATROL_MCP_TIMEOUT_MS = 35 * 60 * 1000;

const DEFAULT_SESSION_RUNTIME = {
  randomUUID,
  execFileSync,
  spawnPty(file, args, options) {
    if (process.platform === 'darwin') {
      const nodePtyEntry = fileURLToPath(import.meta.resolve('node-pty'));
      const helperPath = resolve(dirname(nodePtyEntry), '..', 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
      try {
        accessSync(helperPath, constants.X_OK);
      } catch {
        try {
          chmodSync(helperPath, 0o755);
        } catch (error) {
          throw new Error(`node-pty spawn helper is not executable at ${helperPath}: ${error.message}`, {
            cause: error,
          });
        }
      }
    }
    return pty.spawn(file, args, options);
  },
};

/**
 * Strip ANSI escape sequences and return the count of printable characters.
 * Used to distinguish real content output from TUI status-bar refreshes.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\(.|>[0-9]*|=[0-9]*|[ #%()*+\-./][A-Za-z0-9]?)/g;
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

/**
 * Port the Patrol server is currently listening on. Used to construct
 * per-session MCP URLs at session-spawn time. Set after the server binds.
 * @type {number | null}
 */
let currentPort = null;

/**
 * Record the current listening port. Per-session MCP config files are
 * written at session-spawn time (see writeMcpConfigForSession) using this
 * port. The per-session URL embeds the session id so MCP tool handlers can
 * identify their caller without trusting it.
 * @param {number} port
 */
export function setMcpPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`Invalid MCP port: ${port}`);
  }
  currentPort = port;
}

/**
 * Preserved Claude sessions keep the MCP config written when they started.
 * An omitted timeout inherits Claude Code's longer default and is safe. Only
 * an explicit timeout below the review budget requires a restart.
 */
export function getSessionPeerReviewReadiness(sessionId) {
  const row = getDb().prepare('SELECT provider FROM sessions WHERE id = ?').get(sessionId);
  if (row?.provider === 'codex') return { ready: true, reason: null };
  try {
    const config = JSON.parse(readFileSync(mcpConfigPathForSession(sessionId), 'utf8'));
    const patrol = config?.mcpServers?.patrol;
    if (patrol && (patrol.timeout === undefined || patrol.timeout >= PATROL_MCP_TIMEOUT_MS)) {
      return { ready: true, reason: null };
    }
  } catch {
    // Missing or malformed config means the running Claude session cannot be
    // trusted to keep this MCP call open for the review duration.
  }
  return {
    ready: false,
    reason: 'session_restart_required',
  };
}

/**
 * Fixed-size circular buffer. Appends copy only the new bytes; linearization
 * happens on the much less frequent replay path.
 */
export class RingBuffer {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError('RingBuffer capacity must be a positive integer');
    }
    this.buf = Buffer.alloc(capacity);
    this.start = 0;
    this.len = 0;
  }

  append(data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (chunk.length >= this.buf.length) {
      // Data larger than buffer - keep only the tail
      chunk.copy(this.buf, 0, chunk.length - this.buf.length);
      this.start = 0;
      this.len = this.buf.length;
      return;
    }

    const overflow = Math.max(0, this.len + chunk.length - this.buf.length);
    this.start = (this.start + overflow) % this.buf.length;
    this.len -= overflow;

    const writeStart = (this.start + this.len) % this.buf.length;
    const firstLength = Math.min(chunk.length, this.buf.length - writeStart);
    chunk.copy(this.buf, writeStart, 0, firstLength);
    if (firstLength < chunk.length) {
      chunk.copy(this.buf, 0, firstLength);
    }
    this.len += chunk.length;
  }

  contents() {
    if (this.len === 0) return this.buf.subarray(0, 0);
    const end = this.start + this.len;
    if (end <= this.buf.length) return this.buf.subarray(this.start, end);

    const result = Buffer.allocUnsafe(this.len);
    const firstLength = this.buf.length - this.start;
    this.buf.copy(result, 0, this.start);
    this.buf.copy(result, firstLength, 0, end - this.buf.length);
    return result;
  }
}

/**
 * Coalesce the small PTY reads emitted in one event-loop turn into one output
 * frame. The replay buffer remains authoritative while no browser is attached.
 */
export class TerminalOutputBatcher {
  constructor(websockets, schedule = setImmediate, cancel = clearImmediate) {
    this.websockets = websockets;
    this.schedule = schedule;
    this.cancel = cancel;
    this.pendingChunks = [];
    this.flushHandle = null;
  }

  append(data) {
    if (!this.hasOpenSocket()) return;
    this.pendingChunks.push(data);
    if (this.flushHandle !== null) return;
    this.flushHandle = this.schedule(() => {
      this.flushHandle = null;
      this.flush();
    });
  }

  flush() {
    if (this.flushHandle !== null) {
      this.cancel(this.flushHandle);
      this.flushHandle = null;
    }
    if (this.pendingChunks.length === 0) return;

    const data = this.pendingChunks.join('');
    this.pendingChunks.length = 0;
    if (!this.hasOpenSocket()) return;

    const msg = JSON.stringify({ type: 'output', data });
    for (const ws of this.websockets) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  hasOpenSocket() {
    for (const ws of this.websockets) {
      if (ws.readyState === 1) return true;
    }
    return false;
  }
}

/**
 * @typedef {object} SessionEntry
 * @property {import('node-pty').IPty} proc
 * @property {RingBuffer} buffer
 * @property {Set<import('ws').WebSocket>} websockets
 * @property {TerminalOutputBatcher} output
 */

/** @type {Map<string, SessionEntry>} */
const sessions = new Map();

/**
 * Spawn a node-pty attached to an existing tmux session and wire up
 * output buffering, WebSocket broadcast, and exit handling.
 * @param {string} sessionId
 * @param {{ claudeProjectDir?: string, startedAt?: string }} meta
 * @param {typeof DEFAULT_SESSION_RUNTIME} runtime
 * @returns {SessionEntry}
 */
function attachPtyToTmux(sessionId, meta = {}, runtime = DEFAULT_SESSION_RUNTIME) {
  const db = getDb();
  const tmuxName = `patrol-${sessionId}`;
  const proc = runtime.spawnPty('tmux', ['attach-session', '-t', tmuxName], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    env: { ...process.env },
  });

  db.prepare('UPDATE sessions SET pid = ?, status = ? WHERE id = ?').run(proc.pid, 'active', sessionId);

  const sessionRow = db.prepare('SELECT workspace_id, work_item_id FROM sessions WHERE id = ?').get(sessionId);
  const target = sessionTargetFromRow(sessionRow);

  // Activity state: null (untracked) | 'working' | 'idle'
  //   null -> working:  first substantial output (>= BURST_BYTE_THRESHOLD)
  //   working -> idle:  IDLE_THRESHOLD_MS of no substantial output
  //   idle -> working:  substantial output resumes
  // "Idle" only applies to sessions that WERE working and went silent.
  // Untracked sessions show "Session" badge in the UI.
  let state = null;
  let idleTimer = null;
  // Transition order is locked: write the timestamp (lastWorkingAt or
  // lastIdleAt), then update state, then emit the session-state event. Any
  // listener observing the event is guaranteed to see consistent fields.
  // wait_for_idle (lt#15) reads lastIdleAt > lastWorkingAt > since to anchor
  // on a specific dispatch.
  function transitionTo(s) {
    if (s === 'working') entry.lastWorkingAt = Date.now();
    else if (s === 'idle') entry.lastIdleAt = Date.now();
    state = s;
    entry.activityState = s;
    emitSessionState(sessionId, target, s);
  }
  function resetIdleTimer() {
    if (idleTimer) {
      idleTimer.refresh();
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      transitionTo('idle');
    }, IDLE_THRESHOLD_MS);
  }
  // Force-set state to working at dispatch time. Used by the dispatcher
  // (lt#12) so wait_for_idle.since has a deterministic anchor regardless of
  // when the natural detector trips on the TUI echo. Also resets the idle
  // countdown so a session that's already idle gets a fresh window.
  function markWorking() {
    transitionTo('working');
    resetIdleTimer();
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

  const websockets = new Set();
  const entry = {
    proc,
    buffer: new RingBuffer(BUFFER_MAX),
    websockets,
    output: new TerminalOutputBatcher(websockets),
    resizeSuppressUntil: Date.now() + 500,
    activityState: state, // exposed for getSessionStates()
    target,
    lastWorkingAt: null, // ms timestamp of most recent null|idle -> working transition
    lastIdleAt: null, // ms timestamp of most recent working -> idle transition
    markWorking, // dispatcher's deterministic anchor for wait_for_idle (lt#12)
  };

  proc.onData((data) => {
    entry.buffer.append(data);
    entry.output.append(data);

    // Ignore resize-triggered redraws (full screen repaint from terminal open).
    if (Date.now() < entry.resizeSuppressUntil) return;

    // Ignore events with negligible printable content (TUI status-bar refreshes,
    // cursor repositioning, etc.). Only compute when not already working, since
    // once working any output should keep the idle timer alive.
    if (state !== 'working' && printableLength(data) < MIN_PRINTABLE) return;

    if (state === 'working') {
      // Already working - any output resets the idle countdown.
      resetIdleTimer();
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
        momentCount = 0;
        transitionTo('working');
        resetIdleTimer();
      }
    }
  });

  proc.onExit(({ exitCode }) => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (momentTimer) clearTimeout(momentTimer);
    entry.output.flush();
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
    emitSessionState(sessionId, target, 'exited');
    emitLocalChange();

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
      try {
        execFileSync('tmux', ['set-option', '-t', tmuxName, 'status', 'off'], { timeout: 5_000 });
      } catch {}
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
 * Remove a failed session start from tmux, memory, the database, and temp files.
 * The tmux name is a fresh UUID, so killing it is safe even when new-session
 * returned an error after creating the process.
 * @param {string} sessionId
 * @param {typeof DEFAULT_SESSION_RUNTIME} runtime
 * @param {string[]} tempPaths
 */
function rollbackFailedSessionStart(sessionId, runtime, tempPaths) {
  const tmuxName = `patrol-${sessionId}`;
  try {
    runtime.execFileSync('tmux', ['kill-session', '-t', tmuxName], { timeout: 5000 });
  } catch {
    // The tmux process may not have been created yet.
  }

  const entry = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (entry) {
    try {
      entry.proc.kill();
    } catch {
      // The PTY may already have exited with tmux.
    }
  }

  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  for (const path of tempPaths) {
    try {
      unlinkSync(path);
    } catch {
      // The file may not have been written yet.
    }
  }
}

/**
 * Mark active database rows without a live in-memory PTY as killed before a
 * replacement is created. This prevents a partial start from being returned
 * to the terminal UI on the next sync.
 * @param {{type: 'global'} | {type: 'workspace'|'work_item', id: string}} target
 * @param {typeof DEFAULT_SESSION_RUNTIME} runtime
 * @returns {object | null}
 */
function findReusableSession(target, provider, runtime) {
  const db = getDb();
  const where = sessionTargetWhere(target);
  const existingRows = db
    .prepare(`SELECT * FROM sessions WHERE ${where.sql} AND status IN ('active', 'detached')`)
    .all(...where.params);

  for (const existing of existingRows) {
    if (isTmuxSessionAlive(existing.id)) {
      if (existing.provider !== provider) {
        throw taggedError(
          'provider_conflict',
          `${existing.provider} session ${existing.id} is already active for this target`,
        );
      }
      return existing;
    }

    const entry = sessions.get(existing.id);
    sessions.delete(existing.id);
    try {
      runtime.execFileSync('tmux', ['kill-session', '-t', `patrol-${existing.id}`], { timeout: 5000 });
    } catch {
      try {
        entry?.proc.kill();
      } catch {
        // The stale PTY and tmux process are already gone.
      }
    }
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      existing.id,
    );
  }

  return null;
}

/**
 * Start a tmux-backed agent session as one transaction. Runtime injection is
 * used by the regression test to force PTY failure without starting processes.
 * @param {{type: 'global'} | {type: 'workspace'|'work_item', id: string}} target
 * @param {string} cwd
 * @param {{provider?: 'claude'|'codex', claudeSessionId?: string | null, enablePatrolMcp?: boolean, initialPrompt?: string|null, runtime?: typeof DEFAULT_SESSION_RUNTIME}} options
 * @returns {object} session record
 */
export function createSessionWithRuntime(target, cwd, options = {}) {
  const {
    claudeSessionId = null,
    enablePatrolMcp = true,
    initialPrompt = null,
    runtime = DEFAULT_SESSION_RUNTIME,
  } = options;
  const normalizedTarget = normalizeSessionTarget(target);
  const { workspaceId, workItemId } = sessionTargetColumns(normalizedTarget);
  const provider = normalizeSessionProvider(options.provider);
  const db = getDb();

  if (!claudeSessionId) {
    const existing = findReusableSession(normalizedTarget, provider, runtime);
    if (existing) return existing;
  }

  const id = runtime.randomUUID();
  const tmuxName = `patrol-${id}`;
  const tempPaths = [];

  try {
    const launch = buildSessionLaunch({
      provider,
      sessionId: id,
      cwd,
      port: currentPort,
      patrolPrompt: PATROL_SYSTEM_PROMPT,
      mcpTimeoutMs: PATROL_MCP_TIMEOUT_MS,
      claudeSessionId,
      enablePatrolMcp,
      initialPrompt,
    });
    tempPaths.push(...launch.tempPaths);

    // Patrol owns a color terminal, so a NO_COLOR value inherited by the
    // server must not silently disable the agent's ANSI palette. tmux new-session
    // takes one shell-command string, so shell-escape the complete env command.
    const shellCmd = launch.commandArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    runtime.execFileSync('tmux', ['new-session', '-d', '-s', tmuxName, '-x', '120', '-y', '30', '-c', cwd, shellCmd], {
      timeout: 10_000,
    });
    runtime.execFileSync('tmux', ['set-option', '-t', tmuxName, 'status', 'off'], { timeout: 5_000 });

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions
        (id, workspace_id, work_item_id, pid, provider, status, started_at, claude_project_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, workspaceId, workItemId, 0, provider, 'active', now, launch.claudeProjectDir);

    attachPtyToTmux(id, { claudeProjectDir: launch.claudeProjectDir, startedAt: now }, runtime);
    return {
      id,
      workspace_id: workspaceId,
      work_item_id: workItemId,
      target: normalizedTarget,
      provider,
      status: 'active',
      started_at: now,
      claude_project_dir: launch.claudeProjectDir,
    };
  } catch (error) {
    rollbackFailedSessionStart(id, runtime, tempPaths);
    throw error;
  }
}

/**
 * Spawn a new PTY session.
 * @param {{type: 'global'} | {type: 'workspace'|'work_item', id: string}} target
 * @param {string} cwd - working directory
 * @returns {object} session record
 */
export function createSession(target, cwd, provider = 'claude', options = {}) {
  return createSessionWithRuntime(target, cwd, { ...options, provider });
}

/**
 * Create a session that resumes an existing Claude conversation.
 * Same as createSession but adds `--resume <claudeSessionId>` to the claude args.
 * @param {{type: 'workspace', id: string}} target
 * @param {string} cwd
 * @param {string} claudeSessionId - Claude CLI session UUID to resume
 * @returns {object} session record
 */
export function createResumedSession(target, cwd, claudeSessionId) {
  return createSessionWithRuntime(target, cwd, { provider: 'claude', claudeSessionId });
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

  // Flush queued output to existing clients before taking the replay snapshot.
  // Adding the new client first would send the same bytes in both messages.
  entry.output.flush();

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

function sessionKillRuntime(overrides = {}) {
  return {
    killTmux:
      overrides.killTmux ??
      ((sessionId) =>
        execFileSync('tmux', ['kill-session', '-t', `patrol-${sessionId}`], {
          timeout: 5000,
        })),
    isTmuxAlive: overrides.isTmuxAlive ?? isTmuxSessionAlive,
  };
}

function finalizeDetachedSessionStop(sessionId, runtime) {
  if (sessions.has(sessionId) || runtime.isTmuxAlive(sessionId)) return false;
  const result = getDb()
    .prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ? AND status != 'killed'")
    .run(new Date().toISOString(), sessionId);
  if (result.changes > 0) {
    const row = getDb().prepare('SELECT workspace_id, work_item_id FROM sessions WHERE id = ?').get(sessionId);
    emitSessionState(sessionId, sessionTargetFromRow(row), 'exited');
    emitLocalChange();
  }
  return true;
}

/**
 * Request a session stop without claiming success while tmux is still alive.
 * Attached sessions are closed durably by their PTY exit handler. Detached
 * sessions are closed here only after tmux confirms the process is gone.
 * @param {string} sessionId
 * @param {{killTmux?: (sessionId: string) => void, isTmuxAlive?: (sessionId: string) => boolean}} [runtimeOverrides]
 * @returns {boolean} whether tmux is confirmed stopped
 */
export function killSession(sessionId, runtimeOverrides = {}) {
  const runtime = sessionKillRuntime(runtimeOverrides);
  try {
    runtime.killTmux(sessionId);
  } catch {
    // The follow-up liveness check distinguishes an already-dead session from
    // a failed kill. Do not detach the PTY while its agent is still alive.
  }
  if (runtime.isTmuxAlive(sessionId)) return false;

  const entry = sessions.get(sessionId);
  if (entry) {
    try {
      entry.proc.kill();
    } catch {
      // The attached PTY is already delivering its exit event.
    }
  }
  finalizeDetachedSessionStop(sessionId, runtime);
  return true;
}

/** Kill a tmux-backed session and wait until the durable session row is closed. */
export async function killSessionAndWait(sessionId, timeoutMs = 10_000, runtimeOverrides = {}) {
  const db = getDb();
  const existing = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId);
  if (!existing || existing.status === 'killed') return;
  const runtime = sessionKillRuntime(runtimeOverrides);
  killSession(sessionId, runtime);
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    finalizeDetachedSessionStop(sessionId, runtime);
    const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId);
    if (!row || row.status === 'killed') return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw taggedError('session_stop_timeout', `Session ${sessionId} did not stop within ${timeoutMs}ms`);
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
 * Read-only snapshot of a single session's activity state and transition
 * timestamps. Returns null if the session isn't in memory. Used by
 * wait_for_idle (lt#15) to evaluate the since-anchored idle predicate.
 *
 * @param {string} sessionId
 * @returns {{ activityState: 'working' | 'idle' | null, lastWorkingAt: number | null, lastIdleAt: number | null } | null}
 */
export function getSessionSnapshot(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  return {
    activityState: entry.activityState ?? null,
    lastWorkingAt: entry.lastWorkingAt ?? null,
    lastIdleAt: entry.lastIdleAt ?? null,
  };
}

/**
 * Get the current activity state for all tracked sessions.
 * Used to seed new SSE clients with the current state.
 * @returns {Array<{ sessionId: string, target: object, workspaceId: string | null, workItemId: string | null, state: 'working' | 'idle' }>}
 */
export function getSessionStates() {
  const results = [];
  for (const [sessionId, entry] of sessions) {
    if (entry.activityState) {
      results.push({
        sessionId,
        target: entry.target,
        workspaceId: entry.target.type === 'workspace' ? entry.target.id : null,
        workItemId: entry.target.type === 'work_item' ? entry.target.id : null,
        state: entry.activityState,
      });
    }
  }
  return results;
}

export function killAllSessions() {
  // Close all WebSockets immediately so the HTTP server can shut down cleanly
  for (const entry of sessions.values()) {
    entry.output.flush();
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
  entry.output.flush();
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
 * Default delay between writing prompt text and writing the Enter that
 * submits it. Single source of truth for the WS `prompt-submit` handler and
 * server-side dispatchers.
 */
const PROMPT_SUBMIT_DELAY_MS = 100;

/**
 * Internal: write `text + Enter` to a session entry's PTY using the two-step
 * split that Claude's TUI requires (text first, brief delay, then Enter).
 * Sending them as a single write can cause the TUI to swallow Enter while
 * still painting the input field.
 *
 * Both the WebSocket `prompt-submit` handler and `dispatchToSession` route
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
 * Build a tagged Error. The `code` property is what the dispatcher and MCP
 * handlers branch on; the message is for human-readable logging. Exported
 * so the dispatcher can produce the same shape of error.
 */
export function taggedError(code, msg) {
  const e = new Error(msg);
  e.code = code;
  return e;
}

/**
 * Dispatch a prompt to an in-memory session: busy check, force-set working
 * (anchors `wait_for_idle.since` deterministically per lt#12), then write.
 * Returns the dispatch timestamp (`entry.lastWorkingAt`).
 *
 * Throws `Error` with `.code` in {`no_session`, `session_busy`}.
 *
 * @param {string} sessionId
 * @param {string} prompt
 * @returns {Promise<number>} dispatch timestamp (ms)
 */
export async function dispatchToSession(sessionId, prompt) {
  const entry = sessions.get(sessionId);
  if (!entry) throw taggedError('no_session', `session ${sessionId} not in memory`);
  if (entry.activityState === 'working') {
    throw taggedError('session_busy', `session ${sessionId} is currently working`);
  }
  entry.markWorking();
  await submitPromptToEntry(entry, prompt);
  return entry.lastWorkingAt;
}

/**
 * Resolve when the session emits its first 'idle' event after this call.
 * If the session is already in 'idle' state, resolves immediately.
 *
 * Rejections carry a `.code` so callers (the dispatcher, ultimately the MCP
 * handler) can branch on the failure mode without parsing messages:
 *  - `no_session`: session id not in memory.
 *  - `session_exited`: session exited before reaching idle.
 *  - `boot_timeout`: deadline elapsed without an idle event.
 *
 * @param {string} sessionId
 * @param {number} [timeoutMs=BOOT_TIMEOUT_MS_DEFAULT]
 * @returns {Promise<void>}
 */
export function waitForFirstIdle(sessionId, timeoutMs = BOOT_TIMEOUT_MS_DEFAULT) {
  return new Promise((resolve, reject) => {
    const entry = sessions.get(sessionId);
    if (!entry) return reject(taggedError('no_session', `session ${sessionId} not found`));
    if (entry.activityState === 'idle') return resolve();

    const handler = (data) => {
      if (data.sessionId !== sessionId) return;
      if (data.state === 'idle') {
        cleanup();
        resolve();
      } else if (data.state === 'exited') {
        cleanup();
        reject(taggedError('session_exited', `session ${sessionId} exited before reaching idle`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(taggedError('boot_timeout', `session ${sessionId} did not reach idle within ${timeoutMs}ms`));
    }, timeoutMs);
    function cleanup() {
      appEvents.removeListener('session-state', handler);
      clearTimeout(timer);
    }
    appEvents.on('session-state', handler);
  });
}
