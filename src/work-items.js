import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { providerSetup } from './provider-setup.js';
import { createSession, isSessionAlive, killSessionAndWait } from './pty-manager.js';
import { sanitizePublicText } from './public-errors.js';
import { runTask, updateTaskProgress } from './tasks.js';
import { archiveTranscript } from './transcripts.js';
import { expandPath, toClaudeProjectKey } from './utils.js';
import { generatedRootFileNames, publishRootFiles, writeTemporaryRootFiles } from './work-item-files.js';
import { createWorkItemResolver } from './work-item-resolver.js';
import { createWorkItemChild, destroyWorkItemChild } from './workspace.js';

const workItemLocks = new Map();
const WORK_ITEM_STATES = new Set(['resolving', 'preparing', 'ready', 'error', 'destroying', 'destroyed']);
const WORK_ITEM_STAGES = new Set([
  'provider_check',
  'reference_resolution',
  'root_generation',
  'child_creation',
  'child_compensation',
  'session_launch',
  'session_stop',
  'transcript_archive',
  'child_destruction',
  'root_destruction',
  'complete',
]);

function workItemError(code, message, failedProvider = null) {
  const error = new Error(sanitizePublicText(message));
  error.code = code;
  error.failedProvider = failedProvider;
  return error;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function mutateWorkItem(id, patch, expectedStates = null) {
  const db = getDb();
  const allowed = new Set([
    'title',
    'summary',
    'resolved_repositories_json',
    'state',
    'stage',
    'progress_current',
    'progress_total',
    'error_code',
    'error_detail',
    'error_provider',
    'destroyed_at',
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported work-item mutation: ${key}`);
  }
  if (patch.state && !WORK_ITEM_STATES.has(patch.state)) throw new TypeError(`Invalid work-item state: ${patch.state}`);
  if (patch.stage && !WORK_ITEM_STAGES.has(patch.stage)) throw new TypeError(`Invalid work-item stage: ${patch.stage}`);
  const now = new Date().toISOString();
  const assignments = [...Object.keys(patch).map((key) => `${key} = ?`), 'updated_at = ?'];
  const values = [...Object.values(patch), now, id];
  let stateClause = '';
  if (expectedStates?.length) {
    stateClause = ` AND state IN (${expectedStates.map(() => '?').join(', ')})`;
    values.push(...expectedStates);
  }
  const result = transaction(db, () =>
    db.prepare(`UPDATE work_items SET ${assignments.join(', ')} WHERE id = ?${stateClause}`).run(...values),
  );
  if (expectedStates?.length && result.changes !== 1) {
    throw workItemError('invalid_state', 'Work item state changed before this operation could start');
  }
  emitLocalChange();
  return db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
}

function clearErrorPatch() {
  return { error_code: null, error_detail: null, error_provider: null };
}

function retryAction(row) {
  if (!row || row.state !== 'error') return null;
  if (['provider_check', 'reference_resolution'].includes(row.stage)) return 'resolution';
  if (['root_generation', 'child_creation'].includes(row.stage)) return 'preparation';
  if (row.stage === 'child_compensation') return 'cleanup';
  if (row.stage === 'session_launch') return 'terminal';
  if (['session_stop', 'transcript_archive', 'child_destruction', 'root_destruction'].includes(row.stage)) {
    return 'cleanup';
  }
  return null;
}

function repositoriesFor(row) {
  if (!row?.resolved_repositories_json) return [];
  try {
    const parsed = JSON.parse(row.resolved_repositories_json);
    return Array.isArray(parsed) ? parsed.filter((repo) => typeof repo === 'string').slice(0, 32) : [];
  } catch {
    return [];
  }
}

function latestSession(db, workItemId) {
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE work_item_id = ? AND status IN ('active', 'detached')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId);
}

function hasSessionHistory(db, workItemId) {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE work_item_id = ? LIMIT 1').get(workItemId));
}

function activityMap(getSessionStates) {
  return new Map(getSessionStates().map((entry) => [entry.sessionId, entry.state]));
}

export function workItemListItem(row, { getSessionStates = () => [] } = {}) {
  const db = getDb();
  const session = latestSession(db, row.id);
  const activities = activityMap(getSessionStates);
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    work_provider: row.work_provider,
    resolver_provider: row.resolver_provider,
    state: row.state,
    stage: row.stage,
    progress: { current: row.progress_current, total: row.progress_total },
    repositories: repositoriesFor(row),
    updated_at: row.updated_at,
    has_session_history: hasSessionHistory(db, row.id),
    session: session
      ? { id: session.id, status: session.status, activity_state: activities.get(session.id) ?? null }
      : null,
    error: row.error_code
      ? {
          code: row.error_code,
          failed_provider: row.error_provider,
          retry_action: retryAction(row),
        }
      : null,
  };
}

function recoveryActions(row, config) {
  if (!row.error_code) return [];
  const actions = [];
  if (row.error_provider && ['provider_unavailable', 'authentication_required'].includes(row.error_code)) {
    const setup = providerSetup(config)[row.error_provider];
    actions.push({ kind: 'command', label: `Authenticate ${row.error_provider}`, command: setup.model_login_command });
    if (row.error_code === 'authentication_required') {
      for (const command of setup.resolver_mcp_commands) {
        actions.push({ kind: 'command', label: 'Configure reference resolver', command });
      }
    }
  }
  if (row.error_provider) {
    actions.push({ kind: 'settings', label: 'Open Work Items settings', href: '#/setup?section=work-items' });
  }
  return actions;
}

function repositoryState(workspace) {
  if (!workspace) return 'pending';
  if (workspace.status === 'destroyed' || workspace.operation_state === 'destroyed') return 'removed';
  if (workspace.operation_state === 'destroying') return 'removing';
  if (workspace.operation_state === 'error') return 'error';
  if (workspace.operation_state === 'ready') return 'ready';
  return 'pending';
}

function parseWarnings(value) {
  try {
    const warnings = JSON.parse(value ?? '[]');
    return Array.isArray(warnings)
      ? warnings
          .filter((item) => typeof item === 'string')
          .slice(0, 32)
          .map((warning) => sanitizePublicText(warning, { maxBytes: 4096 }))
      : [];
  } catch {
    return [];
  }
}

export function workItemDetail(row, { config, getSessionStates = () => [] }) {
  const list = workItemListItem(row, { getSessionStates });
  const children = getDb()
    .prepare('SELECT rowid, * FROM workspaces WHERE work_item_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(row.id);
  const byRepo = new Map();
  for (const child of children) {
    if (!byRepo.has(child.repo)) byRepo.set(child.repo, child);
  }
  const bookmark = deterministicBookmark(row.id);
  return {
    ...list,
    summary: row.summary,
    root_path: row.path,
    created_at: row.created_at,
    destroyed_at: row.destroyed_at,
    error: row.error_code
      ? {
          code: row.error_code,
          detail: row.error_detail ? sanitizePublicText(row.error_detail, { maxBytes: 16 * 1024 }) : null,
          failed_provider: row.error_provider,
          retry_action: retryAction(row),
          recovery_actions: recoveryActions(row, config),
        }
      : null,
    repository_workspaces: repositoriesFor(row).map((identifier) => {
      const child = byRepo.get(identifier) ?? null;
      return {
        identifier,
        workspace_id: child?.id ?? null,
        state: repositoryState(child),
        path: child?.path ?? null,
        checkout_available: Boolean(
          child && child.status === 'active' && child.operation_state !== 'destroyed' && existsSync(child.path),
        ),
        bookmark: child?.bookmark ?? bookmark,
        start_revision: child?.start_revision ?? config.repos?.[identifier]?.defaultRevision ?? '',
        base_commit: child?.base_commit ?? null,
        warnings: parseWarnings(child?.setup_warnings_json),
      };
    }),
  };
}

export function deterministicBookmark(id) {
  return `patrol/work-item-${id.replaceAll('-', '').slice(0, 12)}`;
}

function childDescriptor(workItem, repo) {
  const id = randomUUID();
  const [owner, name] = repo.split('/');
  const short = id.replaceAll('-', '').slice(0, 8);
  const stable = createHash('sha256').update(`${workItem.id}\0${repo}`).digest('hex').slice(0, 8);
  return {
    id,
    repo,
    directory: `${owner}--${name}--${short}`,
    name: `work-item-${workItem.id.replaceAll('-', '').slice(0, 12)}-${stable}`,
  };
}

function mapLifecycleError(error) {
  const code = error?.code;
  const mappings = {
    resolver_call_limit: 'resolver_limit',
    resolver_output_limit: 'resolver_limit',
    resolver_tool_violation: 'resolver_limit',
    invalid_provider_output: 'resolver_output_invalid',
    resolution_failed: 'resolver_output_invalid',
    provider_unsupported: 'provider_unavailable',
    repository_unavailable: 'repo_not_local',
    unsafe_repository_path: 'repo_not_local',
    jj_required: 'repo_not_local',
    revision_unresolved: 'revision_not_found',
    bookmark_exists: 'bookmark_conflict',
    workspace_conflict: 'bookmark_conflict',
  };
  const stable = mappings[code] ?? code;
  const allowed = new Set([
    'provider_unavailable',
    'authentication_required',
    'resolver_timeout',
    'resolver_limit',
    'resolver_output_invalid',
    'repo_not_local',
    'revision_not_found',
    'revision_ambiguous',
    'bookmark_conflict',
    'setup_failed',
    'compensation_failed',
    'session_launch_failed',
    'interrupted',
    'cleanup_failed',
    'root_not_empty',
  ]);
  return allowed.has(stable) ? stable : 'setup_failed';
}

function recordFailure(id, error, { code = null, provider = null, stage = null } = {}) {
  return mutateWorkItem(id, {
    state: 'error',
    ...(stage ? { stage } : {}),
    error_code: code ?? mapLifecycleError(error),
    error_detail: sanitizePublicText(error?.message ?? String(error)),
    error_provider: provider ?? error?.failedProvider ?? null,
  });
}

async function withWorkItemLock(id, fn) {
  const previous = workItemLocks.get(id);
  const current = (async () => {
    if (previous) await previous.catch(() => {});
    return fn();
  })();
  workItemLocks.set(id, current);
  try {
    return await current;
  } finally {
    if (workItemLocks.get(id) === current) workItemLocks.delete(id);
  }
}

function validateReference(value) {
  if (typeof value !== 'string') throw workItemError('invalid_reference', 'Reference must be a string');
  const reference = value.trim();
  const bytes = Buffer.byteLength(reference, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(reference)) {
    throw workItemError('invalid_reference', 'Reference must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return reference;
}

async function checkProvider(provider, capabilities) {
  const capability = await capabilities[provider].refresh();
  if (capability.available) return;
  const authentication = /auth|log\s*in/i.test(capability.reason ?? '');
  throw workItemError(
    authentication ? 'authentication_required' : 'provider_unavailable',
    capability.reason ?? `${provider} is unavailable`,
    provider,
  );
}

export function createWorkItemService({
  getConfig,
  providerCapabilities,
  getSessionStates,
  resolver = createWorkItemResolver(),
  schedule = (fn) => setImmediate(fn),
  createChild = createWorkItemChild,
  destroyChild = destroyWorkItemChild,
  launchSession = createSession,
  sessionAlive = isSessionAlive,
  stopSession = killSessionAndWait,
  startupDelay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
  const pending = new Map();

  const queue = (id, kind, operation) => {
    schedule(() => {
      const promise = withWorkItemLock(id, () =>
        runTask(
          {
            kind,
            label: kind === 'work-item.destroy' ? 'Destroy work item' : 'Prepare work item',
            context: { workItemId: id },
          },
          operation,
        ),
      )
        .catch((error) => console.warn(`[work-items] ${kind} ${id} failed: ${sanitizePublicText(error.message)}`))
        .finally(() => pending.delete(id));
      pending.set(id, promise);
    });
  };

  const launchTerminal = async (id, { replaceExisting = false } = {}) => {
    let session = null;
    try {
      const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      await checkProvider(item.work_provider, providerCapabilities);
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'session_launch',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      const existing = latestSession(getDb(), id);
      if (existing) {
        if (!replaceExisting) throw workItemError('session_exists', 'A session is already running for this work item');
        await stopSession(existing.id);
      }
      session = launchSession({ type: 'work_item', id }, item.path, item.work_provider, {
        enablePatrolMcp: false,
      });
      await startupDelay(1000);
      if (!sessionAlive(session.id))
        throw workItemError('session_launch_failed', 'Work-item session exited during startup');
      mutateWorkItem(id, {
        state: 'ready',
        stage: 'complete',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
    } catch (error) {
      const live = getDb()
        .prepare("SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .all(id);
      let cleanupError = null;
      for (const row of live) {
        try {
          await stopSession(row.id);
        } catch (caught) {
          cleanupError = caught;
          break;
        }
      }
      const remaining = getDb()
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .get(id).count;
      const failure =
        cleanupError || remaining > 0
          ? workItemError('cleanup_failed', 'Failed to clean up the work-item session after startup failed')
          : error;
      recordFailure(id, failure, {
        code: ['authentication_required', 'provider_unavailable'].includes(failure.code)
          ? failure.code
          : failure.code === 'cleanup_failed'
            ? 'cleanup_failed'
            : 'session_launch_failed',
        provider: error.failedProvider ?? null,
        stage: 'session_launch',
      });
      throw failure;
    }
  };

  const compensateChildren = async (id, originalError, task) => {
    const rows = getDb()
      .prepare(
        "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
      )
      .all(id);
    mutateWorkItem(id, {
      state: 'preparing',
      stage: 'child_compensation',
      progress_current: 0,
      progress_total: rows.length,
      error_code: null,
      error_detail: null,
      error_provider: null,
    });
    updateTaskProgress(task.id, { current: 0, total: rows.length });
    let current = 0;
    try {
      for (const child of rows) {
        await destroyChild(child.id, getConfig(), { deleteBookmark: true });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: rows.length });
        updateTaskProgress(task.id, { current, total: rows.length });
      }
    } catch (error) {
      recordFailure(id, error, { code: 'compensation_failed', stage: 'child_compensation' });
      throw error;
    }
    const repositories = repositoriesFor(getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id));
    recordFailure(id, originalError, { stage: 'child_creation' });
    mutateWorkItem(id, { progress_current: 0, progress_total: repositories.length });
  };

  const prepare = async (id, task) => {
    const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    const repositories = repositoriesFor(item);
    const children = repositories.map((repo) => childDescriptor(item, repo));
    const rootPath = item.path;
    let childCreationStarted = false;
    try {
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'root_generation',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      await mkdir(resolve(rootPath, 'repos'), { recursive: true });
      writeTemporaryRootFiles(rootPath, children, {
        reference: item.reference,
        title: item.title,
        summary: item.summary,
      });
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'child_creation',
        progress_current: 0,
        progress_total: repositories.length,
      });
      childCreationStarted = true;
      updateTaskProgress(task.id, { current: 0, total: repositories.length });
      let current = 0;
      for (const child of children) {
        await createChild({
          id: child.id,
          workItemId: id,
          repo: child.repo,
          name: child.name,
          workspacePath: resolve(rootPath, 'repos', child.directory),
          bookmark: deterministicBookmark(id),
          config: getConfig(),
        });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: repositories.length });
        updateTaskProgress(task.id, { current, total: repositories.length });
      }
      publishRootFiles(rootPath);
      mutateWorkItem(id, {
        state: 'ready',
        stage: 'complete',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
    } catch (error) {
      if (childCreationStarted) await compensateChildren(id, error, task);
      else recordFailure(id, error, { stage: 'root_generation' });
      throw error;
    }
  };

  const resolveAndPrepare = async (id, task) => {
    try {
      let item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      mutateWorkItem(id, {
        state: 'resolving',
        stage: 'provider_check',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      await checkProvider(item.resolver_provider, providerCapabilities);
      mutateWorkItem(id, { state: 'resolving', stage: 'reference_resolution' });
      const result = await resolver.resolve({
        reference: item.reference,
        provider: item.resolver_provider,
        workProvider: item.work_provider,
        config: getConfig().work_items,
      });
      item = mutateWorkItem(id, {
        title: result.title,
        summary: result.summary,
        resolved_repositories_json: JSON.stringify(result.repositories),
        state: 'preparing',
        stage: 'root_generation',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      await prepare(item.id, task);
    } catch (error) {
      const current = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      if (current?.state !== 'error') {
        recordFailure(id, error, {
          provider:
            error.failedProvider ?? (current?.stage === 'reference_resolution' ? current.resolver_provider : null),
        });
      }
      throw error;
    }
  };

  const finishCompensation = async (id, task) => {
    const item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
    const rows = getDb()
      .prepare(
        "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
      )
      .all(id);
    const total = item.progress_total || rows.length;
    let current = item.progress_current;
    try {
      for (const child of rows) {
        await destroyChild(child.id, getConfig(), { deleteBookmark: true });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: total });
        updateTaskProgress(task.id, { current, total });
      }
      mutateWorkItem(id, {
        state: 'error',
        stage: 'child_creation',
        progress_current: 0,
        progress_total: repositoriesFor(item).length,
        error_code: 'setup_failed',
        error_detail: 'Failed preparation cleanup completed. Retry preparation.',
        error_provider: null,
      });
    } catch (error) {
      recordFailure(id, error, { code: 'compensation_failed', stage: 'child_compensation' });
      throw error;
    }
  };

  const archiveRootSessions = async (item) => {
    const sessions = getDb().prepare('SELECT * FROM sessions WHERE work_item_id = ? ORDER BY started_at').all(item.id);
    for (const session of sessions) {
      if (session.provider === 'claude' && session.claude_project_dir && !session.transcript_path) {
        archiveTranscript(session.id, session.claude_project_dir, session.started_at, session.ended_at);
      }
    }
    const claudeProject = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(item.path));
    if (existsSync(claudeProject)) {
      await rm(claudeProject, { recursive: true, force: true });
    }
  };

  const destroyLifecycle = async (id, task) => {
    try {
      let item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      const resumedStage = item.stage;
      const resumedCurrent = item.progress_current;
      const resumedTotal = item.progress_total;
      mutateWorkItem(id, { state: 'destroying', stage: 'session_stop', ...clearErrorPatch() });
      const sessions = getDb()
        .prepare("SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
        .all(id);
      for (const session of sessions) await stopSession(session.id);

      mutateWorkItem(id, { state: 'destroying', stage: 'transcript_archive' });
      await archiveRootSessions(item);

      item = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      const children = getDb()
        .prepare(
          "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
        )
        .all(id);
      const resumingChildren = resumedStage === 'child_destruction';
      const total = resumingChildren ? resumedTotal : children.length;
      let current = resumingChildren ? resumedCurrent : 0;
      mutateWorkItem(id, {
        state: 'destroying',
        stage: 'child_destruction',
        progress_current: current,
        progress_total: total,
      });
      updateTaskProgress(task.id, { current, total });
      for (const child of children) {
        await destroyChild(child.id, getConfig(), { deleteBookmark: false });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: total });
        updateTaskProgress(task.id, { current, total });
      }

      mutateWorkItem(id, {
        state: 'destroying',
        stage: 'root_destruction',
        progress_current: 0,
        progress_total: 0,
      });
      for (const name of generatedRootFileNames()) {
        await unlink(resolve(item.path, name)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
      const reposPath = resolve(item.path, 'repos');
      if (existsSync(reposPath)) {
        const childrenLeft = await readdir(reposPath);
        if (childrenLeft.length > 0)
          throw workItemError('root_not_empty', 'The work-item repository directory is not empty');
        await rmdir(reposPath);
      }
      const unexpected = existsSync(item.path) ? readdirSync(item.path) : [];
      if (unexpected.length > 0)
        throw workItemError('root_not_empty', 'The work-item root contains files not owned by Patrol');
      if (existsSync(item.path)) await rmdir(item.path);
      mutateWorkItem(id, {
        state: 'destroyed',
        stage: 'complete',
        progress_current: 0,
        progress_total: 0,
        destroyed_at: new Date().toISOString(),
        ...clearErrorPatch(),
      });
    } catch (error) {
      const row = getDb().prepare('SELECT stage FROM work_items WHERE id = ?').get(id);
      recordFailure(id, error, {
        code: error.code === 'root_not_empty' ? 'root_not_empty' : 'cleanup_failed',
        stage: row?.stage,
      });
      throw error;
    }
  };

  return {
    create({ reference: rawReference, workProvider }) {
      const config = getConfig();
      if (!config.work_items) throw workItemError('work_items_not_configured', 'Work items are not configured');
      const reference = validateReference(rawReference);
      if (!['claude', 'codex'].includes(workProvider)) {
        throw workItemError('invalid_provider', 'work_provider must be claude or codex');
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const path = resolve(expandPath(config.workspace_base_path), 'work-items', id);
      const resolverProvider = config.work_items.resolver.provider ?? workProvider;
      getDb()
        .prepare(
          `INSERT INTO work_items (
            id, reference, path, work_provider, resolver_provider, state, stage,
            progress_current, progress_total, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'resolving', 'provider_check', 0, 0, ?, ?)`,
        )
        .run(id, reference, path, workProvider, resolverProvider, now, now);
      emitLocalChange();
      queue(id, 'work-item.create', (task) => resolveAndPrepare(id, task));
      return workItemListItem(getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id), {
        getSessionStates,
      });
    },

    retry(id) {
      const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      if (!row) throw workItemError('work_item_not_found', 'Work item not found');
      const action = retryAction(row);
      if (!action) throw workItemError('invalid_state', 'Work item has no retryable operation');
      if (action === 'resolution') {
        mutateWorkItem(id, { state: 'resolving', stage: 'provider_check', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) => resolveAndPrepare(id, task));
      } else if (action === 'preparation') {
        mutateWorkItem(id, { state: 'preparing', stage: 'root_generation', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) => prepare(id, task));
      } else if (action === 'terminal') {
        mutateWorkItem(id, { state: 'preparing', stage: 'session_launch', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', () => launchTerminal(id, { replaceExisting: true }));
      } else if (row.stage === 'child_compensation') {
        mutateWorkItem(id, { state: 'preparing', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) => finishCompensation(id, task));
      } else {
        mutateWorkItem(id, { state: 'destroying', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.destroy', (task) => destroyLifecycle(id, task));
      }
      return workItemListItem(getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id), {
        getSessionStates,
      });
    },

    destroy(id) {
      const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      if (!row) throw workItemError('work_item_not_found', 'Work item not found');
      if (row.state === 'destroyed') return { accepted: false, row };
      if (['resolving', 'preparing', 'destroying'].includes(row.state)) {
        throw workItemError('work_item_busy', 'Work item is busy');
      }
      const resumingCleanup = retryAction(row) === 'cleanup';
      mutateWorkItem(
        id,
        {
          state: 'destroying',
          ...(resumingCleanup ? {} : { stage: 'session_stop', progress_current: 0, progress_total: 0 }),
          ...clearErrorPatch(),
        },
        ['ready', 'error'],
      );
      queue(id, 'work-item.destroy', (task) => destroyLifecycle(id, task));
      return { accepted: true, row: getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id) };
    },

    list() {
      return getDb()
        .prepare("SELECT * FROM work_items WHERE state != 'destroyed' ORDER BY updated_at DESC")
        .all()
        .map((row) => workItemListItem(row, { getSessionStates }));
    },

    detail(id) {
      const row = getDb().prepare('SELECT * FROM work_items WHERE id = ?').get(id);
      return row ? workItemDetail(row, { config: getConfig(), getSessionStates }) : null;
    },

    async waitForIdle(id) {
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      await pending.get(id);
    },
  };
}

export function recoverInterruptedWorkItems() {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, state, stage, progress_current, progress_total FROM work_items WHERE state IN ('resolving', 'preparing', 'destroying')",
    )
    .all();
  if (rows.length === 0) return [];
  transaction(db, () => {
    const now = new Date().toISOString();
    const fail = db.prepare(
      `UPDATE work_items
       SET state = 'error', stage = ?, progress_current = ?, progress_total = ?,
           error_code = 'interrupted', error_detail = ?, error_provider = NULL, updated_at = ?
       WHERE id = ?`,
    );
    const completeTerminalLaunch = db.prepare(
      `UPDATE work_items
       SET state = 'ready', stage = 'complete', progress_current = 0, progress_total = 0,
           error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
       WHERE id = ?`,
    );
    const liveSession = db.prepare(
      "SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached') LIMIT 1",
    );
    const activeChildren = db.prepare(
      "SELECT COUNT(*) AS count FROM workspaces WHERE work_item_id = ? AND status != 'destroyed'",
    );
    for (const row of rows) {
      if (row.state === 'preparing' && row.stage === 'session_launch' && liveSession.get(row.id)) {
        completeTerminalLaunch.run(now, row.id);
        continue;
      }

      const childCount = activeChildren.get(row.id).count;
      const needsChildCompensation = row.state === 'preparing' && row.stage === 'child_creation' && childCount > 0;
      const stage = needsChildCompensation ? 'child_compensation' : row.stage;
      const current = needsChildCompensation ? 0 : row.progress_current;
      const total = needsChildCompensation ? childCount : row.progress_total;
      fail.run(stage, current, total, `Interrupted during ${row.stage}`, now, row.id);
    }
    db.exec(
      `DELETE FROM workspace_claims
       WHERE workspace_id IN (SELECT id FROM workspaces WHERE work_item_id IS NOT NULL)`,
    );
  });
  emitLocalChange();
  return rows.map(({ id, stage }) => ({ id, stage }));
}
