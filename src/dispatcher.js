import { getCurrentConfig } from './config.js';
import { getDb } from './db.js';
import {
  BOOT_TIMEOUT_MS_DEFAULT,
  createSession,
  dispatchToSession,
  getSessionSnapshot,
  taggedError,
  waitForFirstIdle,
} from './pty-manager.js';
import { createWorkspace } from './workspace.js';

/**
 * Resolve a target session and write a prompt into it. Used by the rules
 * engine's `dispatch_claude` action and by the upcoming
 * `send_prompt_to_session` MCP tool.
 *
 * Exactly one of `session_id`, `pr_id`, `workspace_id`, or `global: true`
 * must be provided.
 *
 * Resolution rules:
 *  - `session_id` selects a specific session row. Detached sessions are
 *    rejected (lt#4 design lock); killed/missing rows error `no_session`.
 *    `autoCreate` does not apply: a session id implies a specific session.
 *  - `pr_id` resolves to the PR's active workspace's session. With
 *    `autoCreate`, missing workspace and missing session are both created.
 *  - `workspace_id` resolves to the workspace's session. The workspace
 *    itself must already exist (we don't create workspaces from raw ids).
 *  - `global: true` resolves to the global session (workspace_id IS NULL).
 *    `autoCreate` spawns one in `global_terminal_cwd` if missing.
 *
 * After resolution, if `callerSessionId` matches the resolved target,
 * throws `self_target`. If the target is currently `working`, throws
 * `session_busy`. Otherwise force-sets working state, writes the prompt,
 * and returns the dispatch timestamp.
 *
 * Newlines in `prompt` are stripped (the TUI submits on Enter, so embedded
 * newlines would split the prompt mid-stream).
 *
 * Errors thrown carry `.code` in:
 *   `no_target`, `multiple_targets`, `invalid_prompt`, `no_session`,
 *   `no_workspace`, `session_detached`, `self_target`, `session_busy`,
 *   `boot_timeout`, `session_exited`.
 *
 * @param {object} args
 * @param {string} [args.session_id]
 * @param {string} [args.pr_id]
 * @param {string} [args.workspace_id]
 * @param {boolean} [args.global]
 * @param {string} args.prompt
 * @param {boolean} [args.autoCreate=false]
 * @param {string|null} [args.callerSessionId=null]
 * @param {boolean} [args.waitForBusy=false] - if the resolved session is mid-turn,
 *   wait for it to go idle (up to BUSY_WAIT_TIMEOUT_MS) instead of throwing
 *   session_busy. Used by the manual "Run Now" path; natural triggers leave
 *   this off so they retain the busy-as-cooldown-retry contract.
 * @returns {Promise<{session_id: string, workspace_id: string|null, dispatched_at: number}>}
 */
const BUSY_WAIT_TIMEOUT_MS = 15 * 60_000;

export async function ensureSessionAndSend({
  session_id,
  pr_id,
  workspace_id,
  global: isGlobal,
  prompt,
  autoCreate = false,
  callerSessionId = null,
  waitForBusy = false,
}) {
  const targetCount =
    (session_id ? 1 : 0) + (pr_id ? 1 : 0) + (workspace_id ? 1 : 0) + (isGlobal ? 1 : 0);
  if (targetCount === 0) {
    throw taggedError('no_target', 'one of session_id, pr_id, workspace_id, global is required');
  }
  if (targetCount > 1) {
    throw taggedError('multiple_targets', 'only one of session_id, pr_id, workspace_id, global may be set');
  }

  // Prompt validation lives upstream: the MCP zod schema enforces min(1) and
  // the rules engine config loader does the same. Trust the caller here.

  const db = getDb();
  let resolvedSessionId;
  let resolvedWorkspaceId = null;
  let isFresh = false;

  if (session_id) {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
    if (!row || row.status === 'killed') throw taggedError('no_session', `session ${session_id} not found`);
    if (row.status === 'detached') throw taggedError('session_detached', `session ${session_id} is detached`);
    resolvedSessionId = row.id;
    resolvedWorkspaceId = row.workspace_id;
  } else {
    let workspace = null;
    if (pr_id) {
      workspace = db.prepare("SELECT * FROM workspaces WHERE pr_id = ? AND status = 'active'").get(pr_id);
      if (!workspace) {
        if (!autoCreate) throw taggedError('no_workspace', `no active workspace for pr ${pr_id}`);
        const created = await createWorkspace(pr_id, getCurrentConfig());
        workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(created.id);
      }
    } else if (workspace_id) {
      workspace = db.prepare("SELECT * FROM workspaces WHERE id = ? AND status = 'active'").get(workspace_id);
      if (!workspace) throw taggedError('no_workspace', `workspace ${workspace_id} not found or not active`);
    }
    // workspace stays null for the global path

    let sessionRow;
    if (workspace) {
      sessionRow = db
        .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')")
        .get(workspace.id);
      resolvedWorkspaceId = workspace.id;
    } else {
      sessionRow = db
        .prepare("SELECT * FROM sessions WHERE workspace_id IS NULL AND status IN ('active', 'detached')")
        .get();
    }

    if (sessionRow?.status === 'detached') {
      throw taggedError('session_detached', `target session ${sessionRow.id} is detached`);
    }

    if (!sessionRow) {
      if (!autoCreate) throw taggedError('no_session', 'no active session at target');
      const cwd = workspace ? workspace.path : getCurrentConfig().global_terminal_cwd || process.cwd();
      const created = createSession(workspace ? workspace.id : null, cwd);
      resolvedSessionId = created.id;
      isFresh = true;
    } else {
      resolvedSessionId = sessionRow.id;
    }
  }

  if (callerSessionId && callerSessionId === resolvedSessionId) {
    throw taggedError('self_target', 'cannot send prompt to your own session');
  }

  // Wait for first idle when the session has no activity signal yet:
  // either we just created it (isFresh) or it exists in memory but has
  // never tripped the activity detector (state === null, e.g. brand-new
  // session that hasn't finished booting). Without this, bytes can land
  // in a Claude TUI that's still painting boot output and get eaten.
  // For sessions already in 'idle' state, waitForFirstIdle resolves
  // immediately. For 'working' state we don't wait here; the busy check
  // in dispatchToSession will throw session_busy.
  const snap = isFresh ? null : getSessionSnapshot(resolvedSessionId);
  if (isFresh || snap?.activityState === null) {
    await waitForFirstIdle(resolvedSessionId, BOOT_TIMEOUT_MS_DEFAULT);
  } else if (snap?.activityState === 'working' && waitForBusy) {
    // Manual Run Now opts into queueing: rather than failing fast, wait for
    // the current turn to finish before writing the prompt. Capped so a stuck
    // session can't hang the caller forever.
    await waitForFirstIdle(resolvedSessionId, BUSY_WAIT_TIMEOUT_MS);
  }

  // Strip newlines (TUI submits on Enter, embedded newlines split the prompt
  // mid-stream) and reject prompts that are empty after stripping. Zod's
  // .min(1) catches the literal "" case but lets "\n\n\n" or "   " through.
  const cleaned = prompt.replace(/[\r\n]+/g, ' ');
  if (cleaned.trim().length === 0) {
    throw taggedError('invalid_prompt', 'prompt is empty after stripping whitespace');
  }

  let dispatched_at;
  try {
    dispatched_at = await dispatchToSession(resolvedSessionId, cleaned);
  } catch (e) {
    // Attach the resolved session id so callers can record which session
    // blocked (e.g. rule_runs.session_id for a session_busy error row).
    if (!e.session_id) e.session_id = resolvedSessionId;
    throw e;
  }

  return {
    session_id: resolvedSessionId,
    workspace_id: resolvedWorkspaceId,
    dispatched_at,
  };
}

