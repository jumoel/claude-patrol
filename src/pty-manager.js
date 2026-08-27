import { execFile, execFileSync } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { accessSync, chmodSync, constants, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';
import { appEvents, emitLocalChange, emitSessionState } from './app-events.js';
import { getDb } from './db.js';
import { pollProviderSessionStatuses } from './provider-status-poller.js';
import { normalizeProviderActivity, SessionActivityTracker } from './session-activity.js';
import {
  activityCredentialPathForSession,
  activitySettingsPathForSession,
  buildSessionLaunch,
  mcpConfigPathForSession,
  normalizeSessionProvider,
  readActivityCredential,
} from './session-launch.js';
import {
  normalizeSessionTarget,
  sessionTargetColumns,
  sessionTargetFromRow,
  sessionTargetWhere,
} from './session-target.js';
import { archiveTranscript } from './transcripts.js';

const BUFFER_MAX = 50_000;
export const MAX_LIVE_GLOBAL_SESSIONS = 16;
export const BOOT_TIMEOUT_MS_DEFAULT = 30_000;
// A nested peer-review tool may use its full 30 minute budget. The presenting
// agent's outer Patrol MCP call also includes range setup and process startup.
export const PATROL_MCP_TIMEOUT_MS = 35 * 60 * 1000;

const DEFAULT_SESSION_RUNTIME = {
  randomUUID,
  execFileSync,
  isTmuxAlive: isTmuxSessionAlive,
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
/** @type {Map<string, {provider: 'claude'|'codex', token: string}>} */
const activityCredentials = new Map();
const reattachedSessionsAwaitingStatus = new Set();
export const SESSION_STATUS_POLL_INTERVAL_MS = 1_000;
let sessionStatusPollingEnabled = false;
let sessionStatusPollTimer = null;
let sessionStatusPollInFlight = null;

/**
 * Spawn a node-pty attached to an existing tmux session and wire up
 * output buffering, WebSocket broadcast, and exit handling.
 * @param {string} sessionId
 * @param {{ claudeProjectDir?: string, startedAt?: string, tempPaths?: string[], pollActivity?: boolean }} meta
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

  const sessionRow = db
    .prepare('SELECT workspace_id, work_item_id, provider, last_idle_at FROM sessions WHERE id = ?')
    .get(sessionId);
  const target = sessionTargetFromRow(sessionRow);

  const websockets = new Set();
  const entry = {
    proc,
    buffer: new RingBuffer(BUFFER_MAX),
    websockets,
    output: new TerminalOutputBatcher(websockets),
    activityState: null,
    target,
    lastWorkingAt: null,
    lastIdleAt: null,
    persistedIdleAt: sessionRow.last_idle_at ?? null,
    activityChangedAt: null,
    // The first post-reattach idle observation restores persisted UI state. It
    // does not prove that a new idle transition happened during the restart.
    restoringPersistedIdle: false,
  };
  const activity = new SessionActivityTracker({
    idleThresholdMs: runtime.activityIdleThresholdMs,
    onState: ({ state, changedAt, confirmed, outcome, source }) => {
      const snapshot = activity.snapshot();
      const transitionChangedAt = new Date(changedAt).toISOString();
      entry.activityState = snapshot.activityState;
      entry.lastWorkingAt = snapshot.lastWorkingAt;
      entry.lastIdleAt = snapshot.lastIdleAt;
      if (state === 'idle') {
        if (!entry.restoringPersistedIdle) {
          entry.persistedIdleAt = transitionChangedAt;
          db.prepare('UPDATE sessions SET last_idle_at = ? WHERE id = ?').run(transitionChangedAt, sessionId);
        }
        entry.activityChangedAt = entry.persistedIdleAt;
      } else {
        entry.activityChangedAt = transitionChangedAt;
      }
      emitSessionState(sessionId, target, state, entry.activityChangedAt, {
        confirmed,
        outcome,
        source,
      });
    },
  });
  entry.activity = activity;

  const credential = readActivityCredential(sessionId);
  if (credential?.provider === sessionRow.provider) activityCredentials.set(sessionId, credential);
  entry.markWorking = (source = 'dispatch') => {
    reattachedSessionsAwaitingStatus.delete(sessionId);
    activity.markWorking(source, {
      expectNative: credential?.provider === 'codex',
    });
  };

  proc.onData((data) => {
    entry.buffer.append(data);
    entry.output.append(data);
  });

  proc.onExit(({ exitCode }) => {
    activity.dispose();
    entry.output.flush();
    const exitMsg = JSON.stringify({ type: 'exit', code: exitCode });
    for (const ws of entry.websockets) {
      if (ws.readyState === 1) {
        ws.send(exitMsg);
        ws.close(1000);
      }
    }
    sessions.delete(sessionId);
    activityCredentials.delete(sessionId);
    reattachedSessionsAwaitingStatus.delete(sessionId);
    const tempPaths = new Set([
      ...(meta.tempPaths ?? []),
      activityCredentialPathForSession(sessionId),
      activitySettingsPathForSession(sessionId),
    ]);
    for (const path of tempPaths) {
      try {
        unlinkSync(path);
      } catch {
        // The optional provider file may not exist for this session.
      }
    }
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
  if (meta.pollActivity) {
    reattachedSessionsAwaitingStatus.add(sessionId);
    scheduleSessionStatusPoll();
  }
  return entry;
}

function scheduleSessionStatusPoll(delay = SESSION_STATUS_POLL_INTERVAL_MS) {
  if (!sessionStatusPollingEnabled || sessionStatusPollTimer !== null || sessionStatusPollInFlight !== null) return;
  if (reattachedSessionsAwaitingStatus.size === 0) return;
  sessionStatusPollTimer = setTimeout(async () => {
    sessionStatusPollTimer = null;
    try {
      await pollReattachedSessionStatuses();
    } catch (error) {
      console.warn(`[pty-manager] Session status poll failed: ${error.message}`);
    } finally {
      scheduleSessionStatusPoll();
    }
  }, delay);
  sessionStatusPollTimer.unref?.();
}

/** Poll every reattached session whose post-restart state is still unresolved or working. */
export async function pollReattachedSessionStatuses({ probe = pollProviderSessionStatuses } = {}) {
  if (sessionStatusPollInFlight) return sessionStatusPollInFlight;
  const candidates = [...reattachedSessionsAwaitingStatus]
    .map((sessionId) => {
      const row = getDb().prepare('SELECT provider FROM sessions WHERE id = ?').get(sessionId);
      return row ? { sessionId, provider: row.provider } : null;
    })
    .filter(Boolean);
  if (candidates.length === 0) return 0;

  sessionStatusPollInFlight = (async () => {
    const statuses = await probe(candidates);
    let applied = 0;
    for (const [sessionId, status] of statuses) {
      if (!reattachedSessionsAwaitingStatus.has(sessionId)) continue;
      const entry = sessions.get(sessionId);
      if (!entry) {
        reattachedSessionsAwaitingStatus.delete(sessionId);
        continue;
      }
      entry.restoringPersistedIdle = entry.activity.snapshot().activityState === null && status.state !== 'working';
      try {
        entry.activity.handleStatusPoll(status);
      } finally {
        entry.restoringPersistedIdle = false;
      }
      applied++;
      if (status.state !== 'working') reattachedSessionsAwaitingStatus.delete(sessionId);
    }
    return applied;
  })().finally(() => {
    sessionStatusPollInFlight = null;
  });
  return sessionStatusPollInFlight;
}

export function startSessionStatusPolling() {
  sessionStatusPollingEnabled = true;
  scheduleSessionStatusPoll(0);
}

export async function stopSessionStatusPolling() {
  sessionStatusPollingEnabled = false;
  if (sessionStatusPollTimer !== null) clearTimeout(sessionStatusPollTimer);
  sessionStatusPollTimer = null;
  try {
    await sessionStatusPollInFlight;
  } catch {
    // The polling loop already reports probe failures.
  }
}

function activityTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/**
 * Validate and apply one provider lifecycle callback. Tokens are scoped to a
 * single session and never leave the PTY manager after launch.
 */
export function recordProviderActivity(sessionId, rawProvider, token, payload) {
  let provider;
  try {
    provider = normalizeSessionProvider(rawProvider, null);
  } catch {
    return { accepted: false, reason: 'invalid_provider', status: 400 };
  }

  const credential = activityCredentials.get(sessionId);
  if (!credential) return { accepted: false, reason: 'unknown_session', status: 404 };
  if (!activityTokenEqual(token, credential.token)) {
    return { accepted: false, reason: 'invalid_credential', status: 403 };
  }
  if (credential.provider !== provider) {
    return { accepted: false, reason: 'provider_mismatch', status: 409 };
  }

  const row = getDb()
    .prepare("SELECT provider, status FROM sessions WHERE id = ? AND status IN ('active', 'detached')")
    .get(sessionId);
  if (!row) return { accepted: false, reason: 'unknown_session', status: 404 };
  if (row.provider !== provider) return { accepted: false, reason: 'provider_mismatch', status: 409 };

  const entry = sessions.get(sessionId);
  if (!entry) return { accepted: false, reason: 'session_detached', status: 409 };
  const event = normalizeProviderActivity(provider, payload);
  if (!event) return { accepted: false, reason: 'invalid_event', status: 400 };

  const result = entry.activity.handleProviderEvent(event);
  if (!result.accepted) return { ...result, status: 409 };
  reattachedSessionsAwaitingStatus.delete(sessionId);
  return { ...result, status: 202 };
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
 * Sessions whose tmux process is dead are marked killed. A live tmux that
 * cannot be attached stays detached so a transient PTY failure is recoverable.
 * @param {Partial<typeof DEFAULT_SESSION_RUNTIME>} [runtimeOverrides]
 * @returns {number} number of sessions reattached
 */
export function reattachOrphanedSessions(runtimeOverrides = {}) {
  const db = getDb();
  const runtime = {
    ...DEFAULT_SESSION_RUNTIME,
    isTmuxAlive: isTmuxSessionAlive,
    ...runtimeOverrides,
  };
  const orphans = db.prepare("SELECT * FROM sessions WHERE status IN ('active', 'detached')").all();
  if (orphans.length === 0) return 0;

  let reattached = 0;
  const now = new Date().toISOString();

  for (const session of orphans) {
    if (!runtime.isTmuxAlive(session.id)) {
      db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(now, session.id);
      console.log(`[pty-manager] Orphaned session ${session.id} - tmux dead, marked killed`);
      continue;
    }

    try {
      const tmuxName = `patrol-${session.id}`;
      try {
        runtime.execFileSync('tmux', ['set-option', '-t', tmuxName, 'status', 'off'], { timeout: 5_000 });
      } catch {}
      attachPtyToTmux(
        session.id,
        {
          claudeProjectDir: session.claude_project_dir,
          startedAt: session.started_at,
          pollActivity: true,
        },
        runtime,
      );
      reattached++;
      console.log(`[pty-manager] Reattached to session ${session.id}`);
    } catch (err) {
      if (runtime.isTmuxAlive(session.id)) {
        db.prepare("UPDATE sessions SET status = 'detached', ended_at = NULL WHERE id = ?").run(session.id);
        console.warn(`[pty-manager] Failed to reattach session ${session.id}; tmux is still alive: ${err.message}`);
      } else {
        db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(now, session.id);
        console.warn(
          `[pty-manager] Failed to reattach session ${session.id}; tmux exited during attach: ${err.message}`,
        );
      }
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
  activityCredentials.delete(sessionId);
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
    if (runtime.isTmuxAlive(existing.id)) {
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

const SESSION_NAME_MAX_LENGTH = 80;
const SESSION_NAME_UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeGlobalSessionName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError('Session name must be a string');
  const name = value.trim();
  if (!name) throw new TypeError('Session name must not be empty');
  if ([...name].length > SESSION_NAME_MAX_LENGTH) {
    throw new TypeError(`Session name must be ${SESSION_NAME_MAX_LENGTH} characters or fewer`);
  }
  if (SESSION_NAME_UNSAFE_RE.test(name)) {
    throw new TypeError('Session name must not contain control or formatting characters');
  }
  return name;
}

/** @param {'claude'|'codex'} provider */
function nextGlobalSessionName(provider) {
  const base = provider === 'codex' ? 'Codex' : 'Claude';
  const used = new Set(
    getDb()
      .prepare(
        `SELECT name FROM sessions
          WHERE workspace_id IS NULL
            AND work_item_id IS NULL
            AND status IN ('active', 'detached')
            AND name IS NOT NULL`,
      )
      .all()
      .map((row) => row.name.toLowerCase()),
  );
  for (let suffix = 1; ; suffix++) {
    const candidate = `${base} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Start a tmux-backed agent session as one transaction. Runtime injection is
 * used by the regression test to force PTY failure without starting processes.
 * @param {{type: 'global'} | {type: 'workspace'|'work_item', id: string}} target
 * @param {string} cwd
 * @param {{provider?: 'claude'|'codex', claudeSessionId?: string | null, enablePatrolMcp?: boolean, initialPrompt?: string|null, name?: string|null, reuseExisting?: boolean, runtime?: typeof DEFAULT_SESSION_RUNTIME}} options
 * @returns {object} session record
 */
export function createSessionWithRuntime(target, cwd, options = {}) {
  const {
    claudeSessionId = null,
    enablePatrolMcp = true,
    initialPrompt = null,
    name = null,
    reuseExisting = true,
    runtime = DEFAULT_SESSION_RUNTIME,
  } = options;
  const normalizedTarget = normalizeSessionTarget(target);
  const { workspaceId, workItemId } = sessionTargetColumns(normalizedTarget);
  const provider = normalizeSessionProvider(options.provider);
  const db = getDb();

  if (!claudeSessionId && reuseExisting) {
    const existing = findReusableSession(normalizedTarget, provider, runtime);
    if (existing) return existing;
  }

  if (normalizedTarget.type === 'global') {
    const { count } = db
      .prepare(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE workspace_id IS NULL
            AND work_item_id IS NULL
            AND status IN ('active', 'detached')`,
      )
      .get();
    if (count >= MAX_LIVE_GLOBAL_SESSIONS) {
      throw taggedError(
        'global_session_limit',
        `at most ${MAX_LIVE_GLOBAL_SESSIONS} global sessions may be active at once`,
      );
    }
  }

  const id = runtime.randomUUID();
  const activityToken = randomUUID();
  const sessionName =
    normalizedTarget.type === 'global' ? (normalizeGlobalSessionName(name) ?? nextGlobalSessionName(provider)) : null;
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
      activityToken,
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
        (id, workspace_id, work_item_id, name, pid, provider, status, started_at, claude_project_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, workspaceId, workItemId, sessionName, 0, provider, 'active', now, launch.claudeProjectDir);

    const entry = attachPtyToTmux(
      id,
      { claudeProjectDir: launch.claudeProjectDir, startedAt: now, tempPaths: launch.tempPaths },
      runtime,
    );
    if (initialPrompt) entry.markWorking('initial_prompt');
    return {
      id,
      workspace_id: workspaceId,
      work_item_id: workItemId,
      name: sessionName,
      target: normalizedTarget,
      provider,
      status: 'active',
      started_at: now,
      last_idle_at: null,
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
      if (msg.data.includes('\r') || msg.data.includes('\n')) entry.markWorking?.('terminal_input');
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
      entry.markWorking?.('terminal_input');
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
 * @returns {object | null}
 */
export function getSessionSnapshot(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  return entry.activity.snapshot();
}

/**
 * Get the current activity state for all tracked sessions.
 * Used to seed new SSE clients with the current state.
 * @returns {Array<{ sessionId: string, target: object, workspaceId: string | null, workItemId: string | null, state: 'working' | 'idle', activity_changed_at: string | null }>}
 */
export function getSessionStates() {
  const results = [];
  for (const [sessionId, entry] of sessions) {
    const snapshot = entry.activity.snapshot();
    if (snapshot.activityState) {
      results.push({
        sessionId,
        target: entry.target,
        workspaceId: entry.target.type === 'workspace' ? entry.target.id : null,
        workItemId: entry.target.type === 'work_item' ? entry.target.id : null,
        state: snapshot.activityState,
        activity_changed_at: entry.activityChangedAt,
        confirmed: snapshot.completionConfirmed,
        completion_outcome: snapshot.completionOutcome,
        activity_source: snapshot.activitySource,
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
 * Reattach a detached session back to the web UI.
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
    pollActivity: true,
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
  entry.markWorking('dispatch');
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
    const initial = entry.activity.snapshot();
    if (initial.activityState === 'idle' && initial.completionConfirmed && initial.completionOutcome === 'completed') {
      return resolve();
    }
    if (initial.completionOutcome === 'failed') {
      return reject(taggedError('provider_failure', `session ${sessionId} provider turn failed`));
    }

    const handler = (data) => {
      if (data.sessionId !== sessionId) return;
      if (data.state === 'idle') {
        const snapshot = entry.activity.snapshot();
        if (snapshot.completionOutcome === 'failed') {
          cleanup();
          reject(taggedError('provider_failure', `session ${sessionId} provider turn failed`));
        } else if (snapshot.completionConfirmed && snapshot.completionOutcome === 'completed') {
          cleanup();
          resolve();
        }
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
