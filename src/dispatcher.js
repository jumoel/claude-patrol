import { getCurrentConfig } from './config.js';
import { getDb } from './db.js';
import {
  BOOT_TIMEOUT_MS_DEFAULT,
  createSession,
  dispatchToSession,
  getSessionSnapshot,
  reattachSession,
  taggedError,
  waitForFirstIdle,
} from './pty-manager.js';
import { normalizeSessionProvider } from './session-launch.js';
import { createWorkspace } from './workspace.js';

/**
 * Resolve a target session and write a prompt into it. Used by the rules
 * engine's legacy `dispatch_claude` action and by the
 * `send_prompt_to_session` MCP tool.
 *
 * Exactly one of `session_id`, `pr_id`, `workspace_id`, `work_item_id`, or
 * `global: true` must be provided.
 *
 * Resolution rules:
 *  - `session_id` selects a specific session row. Detached work-item root
 *    sessions are reattached; other detached sessions remain unsupported.
 *    Killed/missing rows error `no_session`. `autoCreate` does not apply: a
 *    session id implies a specific session.
 *  - `pr_id` resolves to its owning work-item session when linked, otherwise
 *    to a legacy PR workspace session. With `autoCreate`, new local PR work
 *    is created as a one-repository work item when the work-item service is available.
 *  - `workspace_id` resolves to the workspace's session. The workspace
 *    itself must already exist (we don't create workspaces from raw ids).
 *  - `work_item_id` resolves to a ready work item's root session. With
 *    `autoCreate`, a missing root session is created at the work-item path.
 *  - `global: true` resolves only when zero or one global session exists.
 *    `autoCreate` spawns one in `global_terminal_cwd` if missing; multiple
 *    sessions error `ambiguous_target` so callers must use `session_id`.
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
 *   `no_workspace`, `work_item_not_found`, `work_item_resolving`,
 *   `work_item_preparing`, `work_item_error`, `work_item_destroying`,
 *   `work_item_destroyed`, `session_detached`, `self_target`, `session_busy`,
 *   `ambiguous_target`, `boot_timeout`, `session_exited`.
 *
 * @param {object} args
 * @param {string} [args.session_id]
 * @param {string} [args.pr_id]
 * @param {string} [args.workspace_id]
 * @param {string} [args.work_item_id]
 * @param {boolean} [args.global]
 * @param {'claude'|'codex'} [args.provider]
 * @param {string} args.prompt
 * @param {boolean} [args.autoCreate=false]
 * @param {string|null} [args.callerSessionId=null]
 * @param {boolean} [args.waitForBusy=false] - if the resolved session is mid-turn,
 *   wait for it to go idle (up to BUSY_WAIT_TIMEOUT_MS) instead of throwing
 *   session_busy. Used by the manual "Run Now" path; natural triggers leave
 *   this off so they retain the busy-as-cooldown-retry contract.
 * @returns {Promise<{session_id: string, workspace_id: string|null, work_item_id: string|null, provider: 'claude'|'codex', dispatched_at: number}>}
 */
const BUSY_WAIT_TIMEOUT_MS = 15 * 60_000;

export async function ensureSessionAndSend(
  {
    session_id,
    pr_id,
    workspace_id,
    work_item_id,
    global: isGlobal,
    provider: rawProvider,
    prompt,
    autoCreate = false,
    callerSessionId = null,
    waitForBusy = false,
  },
  dependencies = {},
) {
  const resolveDb = dependencies.getDb ?? getDb;
  const resolveConfig = dependencies.getConfig ?? getCurrentConfig;
  const launchSession = dependencies.createSession ?? createSession;
  const restoreSession = dependencies.reattachSession ?? reattachSession;
  const sessionSnapshot = dependencies.getSessionSnapshot ?? getSessionSnapshot;
  const waitForSessionIdle = dependencies.waitForFirstIdle ?? waitForFirstIdle;
  const sendToSession = dependencies.dispatchToSession ?? dispatchToSession;
  const workItemService = dependencies.workItemService ?? null;
  const requestedProvider = rawProvider === undefined ? null : normalizeSessionProvider(rawProvider);
  const targetCount =
    (session_id ? 1 : 0) + (pr_id ? 1 : 0) + (workspace_id ? 1 : 0) + (work_item_id ? 1 : 0) + (isGlobal ? 1 : 0);
  if (targetCount === 0) {
    throw taggedError('no_target', 'one of session_id, pr_id, workspace_id, work_item_id, global is required');
  }
  if (targetCount > 1) {
    throw taggedError(
      'multiple_targets',
      'only one of session_id, pr_id, workspace_id, work_item_id, global may be set',
    );
  }

  // Prompt validation lives upstream: the MCP zod schema enforces min(1) and
  // the rules engine config loader does the same. Trust the caller here.

  const db = resolveDb();
  let resolvedSessionId;
  let resolvedWorkspaceId = null;
  let resolvedWorkItemId = null;
  let isFresh = false;
  let wasReattached = false;
  let resolvedProvider;

  const findReadyWorkItem = (id) => {
    const item = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    if (!item) throw taggedError('work_item_not_found', `work item ${id} not found`);
    if (item.state !== 'ready') {
      throw taggedError(`work_item_${item.state}`, `work item ${id} is ${item.state}`);
    }
    return item;
  };

  const restoreDetachedWorkItemSession = (row, { replaceDead = false } = {}) => {
    try {
      restoreSession(row.id);
      wasReattached = true;
      return db.prepare('SELECT * FROM sessions WHERE id = ?').get(row.id) ?? { ...row, status: 'active' };
    } catch {
      const current = db.prepare('SELECT status FROM sessions WHERE id = ?').get(row.id);
      if (replaceDead && current?.status === 'killed') return null;
      throw taggedError('session_detached', `work-item session ${row.id} could not be reattached`);
    }
  };

  if (session_id) {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
    if (!row || row.status === 'killed') throw taggedError('no_session', `session ${session_id} not found`);
    if (row.workspace_id) {
      const workspace = db.prepare('SELECT work_item_id FROM workspaces WHERE id = ?').get(row.workspace_id);
      if (workspace?.work_item_id) {
        throw taggedError('unsupported_target', 'Patrol dispatch is unavailable for work-item child sessions');
      }
    }
    if (row.status === 'detached' && !row.work_item_id) {
      throw taggedError('session_detached', `session ${session_id} is detached`);
    }
    if (requestedProvider && requestedProvider !== row.provider) {
      throw taggedError('provider_conflict', `session ${row.id} uses ${row.provider}, not ${requestedProvider}`);
    }
    const sessionRow = row.status === 'detached' ? restoreDetachedWorkItemSession(row) : row;
    resolvedSessionId = sessionRow.id;
    resolvedWorkspaceId = sessionRow.workspace_id;
    resolvedWorkItemId = sessionRow.work_item_id;
    resolvedProvider = sessionRow.provider;
  } else {
    let workspace = null;
    let workItem = null;
    if (pr_id) {
      const owner = db.prepare('SELECT work_item_id FROM work_item_pull_requests WHERE pr_id = ?').get(pr_id);
      if (owner) {
        workItem = findReadyWorkItem(owner.work_item_id);
        resolvedWorkItemId = workItem.id;
      } else {
        workspace = db
          .prepare(
            "SELECT * FROM workspaces WHERE pr_id = ? AND work_item_id IS NULL AND status = 'active' AND operation_state = 'ready'",
          )
          .get(pr_id);
        if (!workspace) {
          if (!autoCreate) throw taggedError('no_workspace', `no active workspace for pr ${pr_id}`);
          if (workItemService) {
            const created = workItemService.create({ source: 'pull_request', pr_id });
            await workItemService.waitForIdle(created.id);
            workItem = findReadyWorkItem(created.id);
            resolvedWorkItemId = workItem.id;
          } else {
            const created = await createWorkspace(pr_id, resolveConfig());
            workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(created.id);
          }
        }
      }
    } else if (workspace_id) {
      workspace = db
        .prepare(
          "SELECT * FROM workspaces WHERE id = ? AND work_item_id IS NULL AND status = 'active' AND operation_state = 'ready'",
        )
        .get(workspace_id);
      if (!workspace) throw taggedError('no_workspace', `workspace ${workspace_id} not found or not active`);
    } else if (work_item_id) {
      workItem = findReadyWorkItem(work_item_id);
      resolvedWorkItemId = workItem.id;
    }
    // workspace stays null for the global path

    let sessionRow;
    if (workItem) {
      sessionRow = db
        .prepare("SELECT * FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .get(workItem.id);
    } else if (workspace) {
      sessionRow = db
        .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')")
        .get(workspace.id);
      resolvedWorkspaceId = workspace.id;
    } else {
      const globalSessions = db
        .prepare(
          `SELECT * FROM sessions
            WHERE workspace_id IS NULL
              AND work_item_id IS NULL
              AND status IN ('active', 'detached')
            LIMIT 2`,
        )
        .all();
      if (globalSessions.length > 1) {
        throw taggedError(
          'ambiguous_target',
          'multiple global sessions are live; use list_sessions and target one by session_id',
        );
      }
      sessionRow = globalSessions[0];
    }

    if (sessionRow && requestedProvider && sessionRow.provider !== requestedProvider) {
      throw taggedError(
        'provider_conflict',
        `${sessionRow.provider} session ${sessionRow.id} is already active for this target`,
      );
    }

    if (sessionRow?.status === 'detached') {
      if (!workItem) throw taggedError('session_detached', `target session ${sessionRow.id} is detached`);
      sessionRow = restoreDetachedWorkItemSession(sessionRow, { replaceDead: autoCreate });
    }

    if (!sessionRow) {
      if (!autoCreate) throw taggedError('no_session', 'no active session at target');
      const cwd = workItem
        ? workItem.path
        : workspace
          ? workspace.path
          : resolveConfig().global_terminal_cwd || process.cwd();
      const target = workItem
        ? { type: 'work_item', id: workItem.id }
        : workspace
          ? { type: 'workspace', id: workspace.id }
          : { type: 'global' };
      const provider = requestedProvider ?? resolveConfig().default_session_provider ?? 'claude';
      const created = launchSession(target, cwd, provider);
      const createdSession =
        created.status === 'detached' && workItem ? restoreDetachedWorkItemSession(created) : created;
      resolvedSessionId = createdSession.id;
      resolvedProvider = createdSession.provider;
      isFresh = !wasReattached;
    } else {
      resolvedSessionId = sessionRow.id;
      resolvedProvider = sessionRow.provider;
    }
  }

  if (callerSessionId && callerSessionId === resolvedSessionId) {
    throw taggedError('self_target', 'cannot send prompt to your own session');
  }

  // Wait for first idle when the session has no activity signal yet:
  // either we just created it (isFresh) or it exists in memory but has
  // never tripped the activity detector (state === null, e.g. brand-new
  // session that hasn't finished booting). Without this, bytes can land
  // in an agent TUI that's still painting boot output and get eaten.
  // For sessions already in 'idle' state, waitForFirstIdle resolves
  // immediately. For 'working' state we don't wait here; the busy check
  // in dispatchToSession will throw session_busy.
  const snap = isFresh ? null : sessionSnapshot(resolvedSessionId);
  if (isFresh || (!wasReattached && snap?.activityState === null)) {
    await waitForSessionIdle(resolvedSessionId, BOOT_TIMEOUT_MS_DEFAULT);
  } else if (snap?.activityState === 'working' && waitForBusy) {
    // Manual Run Now opts into queueing: rather than failing fast, wait for
    // the current turn to finish before writing the prompt. Capped so a stuck
    // session can't hang the caller forever.
    await waitForSessionIdle(resolvedSessionId, BUSY_WAIT_TIMEOUT_MS);
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
    dispatched_at = await sendToSession(resolvedSessionId, cleaned);
  } catch (e) {
    // Attach the resolved session id so callers can record which session
    // blocked (e.g. rule_runs.session_id for a session_busy error row).
    if (!e.session_id) e.session_id = resolvedSessionId;
    throw e;
  }

  return {
    session_id: resolvedSessionId,
    workspace_id: resolvedWorkspaceId,
    work_item_id: resolvedWorkItemId,
    provider: resolvedProvider,
    dispatched_at,
  };
}
