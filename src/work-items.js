import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb, withTransaction } from './db.js';
import { taggedError } from './errors.js';
import { createKeyedLock } from './keyed-lock.js';
import { providerSetup } from './provider-setup.js';
import { createSession, isSessionAlive, killSessionAndWait } from './pty-manager.js';
import { sanitizePublicText } from './public-errors.js';
import { runTask, updateTaskProgress } from './tasks.js';
import { archiveTranscript } from './transcripts.js';
import { claudeProjectDir, execFile, expandPath } from './utils.js';
import { generatedRootFileNames, publishRootFiles, writeTemporaryRootFiles } from './work-item-files.js';
import { listWorkItemPullRequests, listWorkItemPullRequestsBatch } from './work-item-prs.js';
import { createWorkItemResolver } from './work-item-resolver.js';
import {
  createWorkItemChild,
  destroyWorkItemChild,
  ensureManualSourceRepository,
  sourceRepositoryPath,
} from './workspace.js';

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

const workItemError = (code, message, failedProvider = null) =>
  taggedError(code, sanitizePublicText(message), { failedProvider });

const WORK_ITEM_SELECT = `
  SELECT wi.*,
         wr.reference,
         wr.reference_display,
         wr.reference_system,
         wr.reference_url,
         wr.resolver_provider
    FROM work_items wi
    LEFT JOIN work_item_references wr ON wr.work_item_id = wi.id
`;

function getWorkItem(id) {
  return getDb().prepare(`${WORK_ITEM_SELECT} WHERE wi.id = ?`).get(id);
}

function repositoryMemberships(id) {
  return getDb()
    .prepare(
      `SELECT * FROM work_item_repositories
       WHERE work_item_id = ?
       ORDER BY position, created_at, repo`,
    )
    .all(id);
}

function mutateWorkItem(id, patch, expectedStates = null) {
  const db = getDb();
  const allowed = new Set([
    'title',
    'summary',
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
  const result = withTransaction(db, () =>
    db.prepare(`UPDATE work_items SET ${assignments.join(', ')} WHERE id = ?${stateClause}`).run(...values),
  );
  if (expectedStates?.length && result.changes !== 1) {
    throw workItemError('invalid_state', 'Work item state changed before this operation could start');
  }
  emitLocalChange();
  return getWorkItem(id);
}

function mutateReference(id, patch) {
  const allowed = new Set(['reference_display', 'reference_system', 'reference_url', 'resolver_provider']);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported work-item reference mutation: ${key}`);
  }
  const assignments = Object.keys(patch).map((key) => `${key} = ?`);
  if (assignments.length === 0) return getWorkItem(id);
  getDb()
    .prepare(`UPDATE work_item_references SET ${assignments.join(', ')} WHERE work_item_id = ?`)
    .run(...Object.values(patch), id);
  return getWorkItem(id);
}

function clearErrorPatch() {
  return { error_code: null, error_detail: null, error_provider: null };
}

function retryAction(row) {
  if (!row || row.state !== 'error') return null;
  if (['child_creation', 'child_compensation'].includes(row.stage) && pendingRepositoryAddition(row)) {
    return 'repository_addition';
  }
  if (['provider_check', 'reference_resolution'].includes(row.stage)) return 'resolution';
  if (['root_generation', 'child_creation'].includes(row.stage)) return 'preparation';
  if (row.stage === 'child_compensation') return 'cleanup';
  if (row.stage === 'session_launch') return 'terminal';
  if (['session_stop', 'transcript_archive', 'child_destruction', 'root_destruction'].includes(row.stage)) {
    return 'cleanup';
  }
  return null;
}

function pendingRepositoryAddition(row) {
  return getDb()
    .prepare(
      `SELECT r.repo, r.start_revision,
              w.id, w.id AS persisted_workspace_id, w.status, w.operation_state,
              w.operation_step, w.operation_error
         FROM work_item_repositories r
         LEFT JOIN workspaces w
           ON w.rowid = (
             SELECT candidate.rowid FROM workspaces candidate
              WHERE candidate.work_item_id = r.work_item_id AND candidate.repo = r.repo
              ORDER BY candidate.created_at DESC, candidate.rowid DESC LIMIT 1
           )
        WHERE r.work_item_id = ?
          AND r.membership_source = 'addition'
          AND r.state IN ('adding', 'error')
        ORDER BY r.position LIMIT 1`,
    )
    .get(row.id);
}

function repositoriesFor(row) {
  return row?.id ? repositoryMemberships(row.id).map((membership) => membership.repo) : [];
}

function isDiscoveredRepository(repository, config) {
  if (config.repos?.[repository]) return true;
  if (config.poll?.repos?.includes(repository)) return true;
  const [scope] = repository.split('/');
  return config.poll?.orgs?.includes(scope) ?? false;
}

function validateRepository(value, config, { allowDiscovered = false } = {}) {
  if (typeof value !== 'string') throw workItemError('invalid_repository', 'Repository must be a string');
  const repository = value.trim();
  if (!/^[^\s/\\\u0000-\u001f\u007f-\u009f]+\/[^\s/\\\u0000-\u001f\u007f-\u009f]+$/u.test(repository)) {
    throw workItemError('invalid_repository', 'Repository must use owner/repo format');
  }
  if (!config.repos?.[repository] && !(allowDiscovered && isDiscoveredRepository(repository, config))) {
    throw workItemError(
      allowDiscovered ? 'repository_not_discovered' : 'repository_not_configured',
      allowDiscovered
        ? `Repository is not available through configured GitHub discovery: ${repository}`
        : `Repository is not configured in repos: ${repository}`,
    );
  }
  return repository;
}

/**
 * Start revision when neither the request nor `repos.<repo>.defaultRevision`
 * names one. jj's built-in `trunk()` alias resolves to the remote main, master
 * or trunk bookmark, so a repository only needs a `defaultRevision` when its
 * trunk is somewhere else.
 */
const DEFAULT_START_REVISION = 'trunk()';

function validateRevision(value, repository, config) {
  const rawRevision = value ?? config.repos?.[repository]?.defaultRevision ?? DEFAULT_START_REVISION;
  if (typeof rawRevision !== 'string') throw workItemError('invalid_revision', 'Revision must be a string');
  const revision = rawRevision.trim();
  const bytes = Buffer.byteLength(revision, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(revision)) {
    throw workItemError('invalid_revision', 'Revision must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return revision;
}

export async function removeWorkItemRoot(rootPath, { runExec = execFile } = {}) {
  const warnings = [];
  const reposPath = resolve(rootPath, 'repos');
  let entries = [];
  try {
    entries = await readdir(reposPath, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = resolve(reposPath, entry.name);
    let gitFile;
    try {
      gitFile = await readFile(resolve(childPath, '.git'), 'utf8');
    } catch {
      continue;
    }
    if (!/^gitdir:\s*\S+/mu.test(gitFile)) continue;
    try {
      await runExec('git', ['-C', childPath, 'worktree', 'remove', '--force', childPath]);
    } catch (error) {
      warnings.push(
        sanitizePublicText(`Git worktree deregistration failed for ${entry.name}: ${error.message}`, {
          maxBytes: 4096,
        }),
      );
    }
  }
  await rm(rootPath, { recursive: true, force: true });
  return warnings;
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
  return new Map(getSessionStates().map((entry) => [entry.sessionId, entry]));
}

export function workItemListItem(
  row,
  {
    getSessionStates = () => [],
    session: suppliedSession,
    hasSessionHistory: suppliedSessionHistory,
    pullRequests: suppliedPullRequests,
    repositoryWorkspaces = [],
  } = {},
) {
  const db = getDb();
  const session = suppliedSession === undefined ? latestSession(db, row.id) : suppliedSession;
  const activities = activityMap(getSessionStates);
  const pullRequests = suppliedPullRequests ?? listWorkItemPullRequests(row.id);
  const activity = session ? activities.get(session.id) : null;
  const activityChangedAt =
    activity?.state === 'idle'
      ? (session?.last_idle_at ?? activity.activity_changed_at)
      : (activity?.activity_changed_at ?? null);
  return {
    id: row.id,
    creation_source: row.creation_source,
    reference: row.reference ?? null,
    reference_display: row.reference_display ?? null,
    reference_system: row.reference_system ?? null,
    reference_url: row.reference_url ?? null,
    title: row.title,
    resolver_provider: row.resolver_provider ?? null,
    state: row.state,
    stage: row.stage,
    progress: { current: row.progress_current, total: row.progress_total },
    repositories: repositoriesFor(row),
    pull_request_count: pullRequests.length,
    pull_requests: pullRequests,
    repository_workspaces: repositoryWorkspaces,
    updated_at: row.updated_at,
    has_session_history: suppliedSessionHistory ?? hasSessionHistory(db, row.id),
    session: session
      ? {
          id: session.id,
          provider: session.provider,
          status: session.status,
          activity_state: activity?.state ?? null,
          activity_changed_at: activityChangedAt,
        }
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

function repositoryWorkspacesFor(row, children, config) {
  const byRepo = new Map();
  for (const child of children) {
    if (!byRepo.has(child.repo)) byRepo.set(child.repo, child);
  }
  return repositoryMemberships(row.id).map((membership) => {
    const identifier = membership.repo;
    const child = byRepo.get(identifier) ?? null;
    return {
      identifier,
      workspace_id: child?.id ?? null,
      state: child ? repositoryState(child) : membership.state === 'error' ? 'error' : 'pending',
      path: child?.path ?? null,
      checkout_available: Boolean(
        child && child.status === 'active' && child.operation_state !== 'destroyed' && existsSync(child.path),
      ),
      bookmark: child?.bookmark ?? row.bookmark,
      start_revision:
        child?.start_revision ?? membership.start_revision ?? config.repos?.[identifier]?.defaultRevision ?? '',
      base_commit: child?.base_commit ?? null,
      warnings: parseWarnings(child?.setup_warnings_json),
    };
  });
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
    repository_workspaces: repositoryWorkspacesFor(row, children, config),
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

const withWorkItemLock = createKeyedLock();

function validateReference(value) {
  if (typeof value !== 'string') throw workItemError('invalid_reference', 'Reference must be a string');
  const reference = value.trim();
  const bytes = Buffer.byteLength(reference, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(reference)) {
    throw workItemError('invalid_reference', 'Reference must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return reference;
}

function validateTitle(value) {
  if (typeof value !== 'string') throw workItemError('invalid_title', 'Title must be a string');
  const title = value.trim();
  const bytes = Buffer.byteLength(title, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
    throw workItemError('invalid_title', 'Title must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return title;
}

function validateBookmark(value, id) {
  if (value === undefined || value === null || value === '') return deterministicBookmark(id);
  if (typeof value !== 'string') throw workItemError('invalid_bookmark', 'Bookmark must be a string');
  const bookmark = value.trim();
  const bytes = Buffer.byteLength(bookmark, 'utf8');
  if (bytes < 1 || bytes > 255 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(bookmark)) {
    throw workItemError('invalid_bookmark', 'Bookmark must contain 1 to 255 bytes and no whitespace or controls');
  }
  return bookmark;
}

function validateRepositoryList(value, config, options) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw workItemError('invalid_repositories', 'repositories must contain 1 to 32 available repositories');
  }
  const repositories = value.map((repository) => validateRepository(repository, config, options));
  if (new Set(repositories).size !== repositories.length) {
    throw workItemError('invalid_repositories', 'repositories must not contain duplicates');
  }
  return repositories;
}

function workItemLogId(id) {
  return id.replaceAll('-', '').slice(0, 8);
}

function workspaceCount(count) {
  return `${count} workspace${count === 1 ? '' : 's'}`;
}

function sanitizeLogText(value) {
  return sanitizePublicText(value, { maxBytes: 512 })
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
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
  prepareSourceRepository = ensureManualSourceRepository,
  launchSession = createSession,
  sessionAlive = isSessionAlive,
  stopSession = killSessionAndWait,
  startupDelay = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  logger = console,
} = {}) {
  const pending = new Map();

  const logStage = (id, stage, message) => {
    logger.log(`[work-items] ${workItemLogId(id)} ${stage}: ${sanitizeLogText(message)}`);
  };

  const warnStage = (id, stage, error) => {
    const message = sanitizeLogText(error?.message ?? String(error));
    logger.warn(`[work-items] ${workItemLogId(id)} ${stage} failed: ${message}`);
  };

  const rootFileChildren = (item, repositories = repositoriesFor(item)) => {
    const rows = getDb()
      .prepare(
        `SELECT rowid, * FROM workspaces
         WHERE work_item_id = ? AND status = 'active'
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(item.id);
    const byRepository = new Map();
    for (const row of rows) {
      if (!byRepository.has(row.repo)) byRepository.set(row.repo, row);
    }
    return repositories.map((repository) => {
      const row = byRepository.get(repository);
      if (!row) throw workItemError('setup_failed', `Repository workspace is missing: ${repository}`);
      return { repo: repository, directory: basename(row.path) };
    });
  };

  const rootTask = (item) => ({
    ...(item.reference ? { reference: item.reference } : {}),
    ...(item.title ? { title: item.title } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
  });

  const publishCurrentRootFiles = (item, repositories) => {
    writeTemporaryRootFiles(item.path, rootFileChildren(item, repositories), rootTask(item));
    publishRootFiles(item.path);
  };

  const clearTemporaryRootFiles = async (rootPath) => {
    for (const name of generatedRootFileNames().filter((fileName) => fileName.startsWith('.'))) {
      await unlink(resolve(rootPath, name)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  };

  const beginRepositoryAddition = (item, child, startRevision) => {
    const db = getDb();
    const now = new Date().toISOString();
    withTransaction(db, () => {
      const nextPosition = db
        .prepare(
          'SELECT COALESCE(MAX(position), -1) + 1 AS position FROM work_item_repositories WHERE work_item_id = ?',
        )
        .get(item.id).position;
      db.prepare(
        `INSERT INTO work_item_repositories (
           work_item_id, repo, start_revision, position, membership_source, state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'addition', 'adding', ?, ?)
         ON CONFLICT(work_item_id, repo) DO UPDATE SET
           start_revision = excluded.start_revision,
           membership_source = 'addition',
           state = 'adding',
           updated_at = excluded.updated_at`,
      ).run(item.id, child.repo, startRevision, nextPosition, now, now);
      const result = db
        .prepare(
          `UPDATE work_items
           SET state = 'preparing', stage = 'child_creation', progress_current = 0, progress_total = 1,
               error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
           WHERE id = ? AND state = 'ready'`,
        )
        .run(now, item.id);
      if (result.changes !== 1) {
        throw workItemError('invalid_state', 'Work item state changed before repository creation could start');
      }
    });
    emitLocalChange();
  };

  const finishRepositoryAddition = (id, repository, { remove = false } = {}) => {
    const db = getDb();
    const now = new Date().toISOString();
    withTransaction(db, () => {
      if (remove) {
        db.prepare('DELETE FROM work_item_repositories WHERE work_item_id = ? AND repo = ?').run(id, repository);
      } else {
        db.prepare(
          `UPDATE work_item_repositories
              SET state = 'ready', updated_at = ?
            WHERE work_item_id = ? AND repo = ?`,
        ).run(now, id, repository);
      }
      db.prepare(
        `UPDATE work_items
         SET state = 'ready', stage = 'complete', progress_current = 0, progress_total = 0,
             error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(now, id);
    });
    emitLocalChange();
  };

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
        .catch((error) => {
          const row = getDb().prepare('SELECT stage FROM work_items WHERE id = ?').get(id);
          warnStage(id, row?.stage ?? kind, error);
        })
        .finally(() => pending.delete(id));
      pending.set(id, promise);
    });
  };

  const launchTerminal = async (id, { replaceExisting = false } = {}) => {
    let session = null;
    try {
      const item = getWorkItem(id);
      const existing = latestSession(getDb(), id);
      const provider = existing?.provider ?? item.error_provider ?? getConfig().default_session_provider;
      await checkProvider(provider, providerCapabilities);
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'session_launch',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      if (existing) {
        if (!replaceExisting) throw workItemError('session_exists', 'A session is already running for this work item');
        await stopSession(existing.id);
      }
      session = launchSession({ type: 'work_item', id }, item.path, provider, {
        enablePatrolMcp: true,
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
    logStage(id, 'child_compensation', `removing ${workspaceCount(rows.length)}`);
    updateTaskProgress(task.id, { current: 0, total: rows.length });
    let current = 0;
    try {
      for (const child of rows) {
        logStage(id, 'child_compensation', `removing ${current + 1}/${rows.length} ${child.repo}`);
        await destroyChild(child.id, getConfig(), { deleteBookmark: true });
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: rows.length });
        updateTaskProgress(task.id, { current, total: rows.length });
      }
    } catch (error) {
      recordFailure(id, error, { code: 'compensation_failed', stage: 'child_compensation' });
      throw error;
    }
    const repositories = repositoriesFor(getWorkItem(id));
    getDb()
      .prepare("UPDATE work_item_repositories SET state = 'error', updated_at = ? WHERE work_item_id = ?")
      .run(new Date().toISOString(), id);
    recordFailure(id, originalError, { stage: 'child_creation' });
    mutateWorkItem(id, { progress_current: 0, progress_total: repositories.length });
  };

  const prepare = async (id, task) => {
    const item = getWorkItem(id);
    const memberships = repositoryMemberships(id);
    const repositories = memberships.map((membership) => membership.repo);
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
      logStage(id, 'root_generation', `generating files for ${repositories.length} repos`);
      const config = getConfig();
      for (const membership of memberships) {
        if (config.repos?.[membership.repo]) continue;
        logStage(id, 'root_generation', `preparing source repository ${membership.repo}`);
        const prepared = await prepareSourceRepository(membership.repo, config);
        const startRevision = membership.start_revision ?? prepared.startRevision;
        validateRevision(startRevision, membership.repo, config);
        membership.start_revision = startRevision;
        getDb()
          .prepare(
            'UPDATE work_item_repositories SET start_revision = ?, updated_at = ? WHERE work_item_id = ? AND repo = ?',
          )
          .run(startRevision, new Date().toISOString(), id, membership.repo);
      }
      const children = memberships.map((membership) => ({
        ...childDescriptor(item, membership.repo),
        startRevision: membership.start_revision ?? config.repos?.[membership.repo]?.defaultRevision,
      }));
      await mkdir(resolve(rootPath, 'repos'), { recursive: true });
      writeTemporaryRootFiles(rootPath, children, rootTask(item));
      mutateWorkItem(id, {
        state: 'preparing',
        stage: 'child_creation',
        progress_current: 0,
        progress_total: repositories.length,
      });
      logStage(id, 'child_creation', `creating ${workspaceCount(repositories.length)}`);
      childCreationStarted = true;
      updateTaskProgress(task.id, { current: 0, total: repositories.length });
      let current = 0;
      for (const child of children) {
        logStage(id, 'child_creation', `creating ${current + 1}/${repositories.length} ${child.repo}`);
        await createChild({
          id: child.id,
          workItemId: id,
          repo: child.repo,
          name: child.name,
          workspacePath: resolve(rootPath, 'repos', child.directory),
          bookmark: item.bookmark,
          config: getConfig(),
          startRevision: child.startRevision,
        });
        getDb()
          .prepare(
            "UPDATE work_item_repositories SET state = 'ready', updated_at = ? WHERE work_item_id = ? AND repo = ?",
          )
          .run(new Date().toISOString(), id, child.repo);
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
      logStage(id, 'complete', `ready with ${workspaceCount(repositories.length)}`);
    } catch (error) {
      if (childCreationStarted) await compensateChildren(id, error, task);
      else recordFailure(id, error, { stage: 'root_generation' });
      throw error;
    }
  };

  const addRepositoryLifecycle = async (id, repository, startRevision, task) => {
    const item = getWorkItem(id);
    const repositories = repositoriesFor(item);
    const child = childDescriptor(item, repository);
    beginRepositoryAddition(item, child, startRevision);
    logStage(id, 'child_creation', `adding ${repository}`);
    updateTaskProgress(task.id, { current: 0, total: 1 });

    try {
      await createChild({
        id: child.id,
        workItemId: id,
        repo: repository,
        name: child.name,
        workspacePath: resolve(item.path, 'repos', child.directory),
        bookmark: item.bookmark,
        config: getConfig(),
        startRevision,
      });
      const updatedRepositories = [...repositories, repository];
      publishCurrentRootFiles(item, updatedRepositories);
      finishRepositoryAddition(id, repository);
      updateTaskProgress(task.id, { current: 1, total: 1 });
      logStage(id, 'complete', `ready with ${workspaceCount(updatedRepositories.length)}`);
      const workItem = workItemDetail(getWorkItem(id), {
        config: getConfig(),
        getSessionStates,
      });
      return {
        added: true,
        work_item: workItem,
        repository_workspace: workItem.repository_workspaces.find((workspace) => workspace.identifier === repository),
      };
    } catch (error) {
      let cleanupError = null;
      try {
        await clearTemporaryRootFiles(item.path);
        const workspace = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(child.id);
        if (workspace && (workspace.status !== 'destroyed' || workspace.operation_state !== 'destroyed')) {
          await destroyChild(child.id, getConfig(), { deleteBookmark: true });
        }
        publishCurrentRootFiles(item, repositories);
      } catch (caught) {
        cleanupError = caught;
      }
      if (cleanupError) {
        const failure = workItemError(
          'compensation_failed',
          `Failed to clean up repository workspace ${repository}: ${cleanupError.message}`,
        );
        getDb()
          .prepare(
            "UPDATE work_item_repositories SET state = 'error', updated_at = ? WHERE work_item_id = ? AND repo = ?",
          )
          .run(new Date().toISOString(), id, repository);
        recordFailure(id, failure, { code: 'compensation_failed', stage: 'child_compensation' });
        throw failure;
      }
      finishRepositoryAddition(id, repository, { remove: true });
      throw error;
    }
  };

  const recoverRepositoryAddition = async (id, repository, startRevision, task) => {
    const item = getWorkItem(id);
    const pendingWorkspace = pendingRepositoryAddition(item);
    try {
      if (pendingWorkspace?.persisted_workspace_id) {
        await destroyChild(pendingWorkspace.id, getConfig(), { deleteBookmark: true });
      }
      const previousRepositories = repositoriesFor(item).filter((candidate) => candidate !== repository);
      publishCurrentRootFiles(item, previousRepositories);
      finishRepositoryAddition(id, repository, { remove: true });
    } catch (error) {
      recordFailure(id, error, { code: 'compensation_failed', stage: 'child_compensation' });
      throw error;
    }
    return addRepositoryLifecycle(id, repository, startRevision, task);
  };

  const resolveAndPrepare = async (id, task) => {
    try {
      let item = getWorkItem(id);
      mutateWorkItem(id, {
        state: 'resolving',
        stage: 'provider_check',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      logStage(id, 'provider_check', `${item.resolver_provider} availability`);
      await checkProvider(item.resolver_provider, providerCapabilities);
      mutateWorkItem(id, { state: 'resolving', stage: 'reference_resolution' });
      logStage(id, 'reference_resolution', `${item.reference} via ${item.resolver_provider}`);
      const result = await resolver.resolve({
        reference: item.reference,
        provider: item.resolver_provider,
        config: getConfig().work_items,
      });
      mutateReference(id, {
        reference_display: result.work_reference?.display ?? null,
        reference_system: result.work_reference?.system ?? null,
        reference_url: result.work_reference?.url ?? null,
      });
      const now = new Date().toISOString();
      const config = getConfig();
      withTransaction(getDb(), () => {
        getDb().prepare('DELETE FROM work_item_repositories WHERE work_item_id = ?').run(id);
        const insert = getDb().prepare(
          `INSERT INTO work_item_repositories (
             work_item_id, repo, start_revision, position, membership_source, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'initial', 'adding', ?, ?)`,
        );
        result.repositories.forEach((repository, position) => {
          insert.run(id, repository, config.repos?.[repository]?.defaultRevision ?? null, position, now, now);
        });
      });
      item = mutateWorkItem(id, {
        title: result.title,
        summary: result.summary,
        state: 'preparing',
        stage: 'root_generation',
        progress_current: 0,
        progress_total: 0,
        ...clearErrorPatch(),
      });
      await prepare(item.id, task);
    } catch (error) {
      const current = getWorkItem(id);
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
    const item = getWorkItem(id);
    const rows = getDb()
      .prepare(
        "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
      )
      .all(id);
    const total = item.progress_total || rows.length;
    let current = item.progress_current;
    logStage(id, 'child_compensation', `resuming ${workspaceCount(rows.length)}`);
    try {
      for (const child of rows) {
        logStage(id, 'child_compensation', `removing ${current + 1}/${total} ${child.repo}`);
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
    const claudeProject = claudeProjectDir(item.path);
    if (existsSync(claudeProject)) {
      await rm(claudeProject, { recursive: true, force: true });
    }
  };

  const destroyLifecycle = async (id, task) => {
    try {
      let item = getWorkItem(id);
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

      item = getWorkItem(id);
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
      const warnings = await removeWorkItemRoot(item.path);
      mutateWorkItem(id, {
        state: 'destroyed',
        stage: 'complete',
        progress_current: 0,
        progress_total: 0,
        destroyed_at: new Date().toISOString(),
        ...clearErrorPatch(),
      });
      return { warnings };
    } catch (error) {
      const row = getDb().prepare('SELECT stage FROM work_items WHERE id = ?').get(id);
      recordFailure(id, error, {
        code: 'cleanup_failed',
        stage: row?.stage,
      });
      throw error;
    }
  };

  return {
    create(input) {
      const config = getConfig();
      const request =
        input?.source === undefined && Object.hasOwn(input ?? {}, 'reference')
          ? {
              source: 'reference',
              reference: input.reference,
              resolver_provider: input.resolver_provider ?? input.workProvider,
            }
          : input;
      if (!request || !['manual', 'reference', 'pull_request'].includes(request.source)) {
        throw workItemError('invalid_source', 'source must be manual, reference, or pull_request');
      }
      const id = randomUUID();
      const now = new Date().toISOString();
      const path = resolve(expandPath(config.workspace_base_path), 'work-items', id);
      const bookmark = validateBookmark(request.bookmark, id);
      let title = null;
      let state = 'preparing';
      let stage = 'root_generation';
      let reference = null;
      let resolverProvider = null;
      let repositories = [];
      let pullRequest = null;

      if (request.source === 'reference') {
        if (!config.work_items) throw workItemError('work_items_not_configured', 'Reference work is not configured');
        reference = validateReference(request.reference);
        resolverProvider =
          config.work_items.resolver.provider ?? request.resolver_provider ?? config.default_session_provider;
        if (!['claude', 'codex'].includes(resolverProvider)) {
          throw workItemError('invalid_provider', 'resolver_provider must be claude or codex');
        }
        state = 'resolving';
        stage = 'provider_check';
      } else if (request.source === 'manual') {
        title = validateTitle(request.title);
        repositories = validateRepositoryList(request.repositories, config, { allowDiscovered: true }).map((repo) => {
          const configured = Boolean(config.repos?.[repo]);
          if (configured) sourceRepositoryPath(repo, config);
          const requestedRevision = request.startRevisions?.[repo];
          return {
            repo,
            startRevision:
              configured || requestedRevision !== undefined ? validateRevision(requestedRevision, repo, config) : null,
          };
        });
      } else {
        if (typeof request.pr_id !== 'string' || !request.pr_id.trim()) {
          throw workItemError('invalid_pull_request', 'pr_id is required for pull_request work');
        }
        pullRequest = getDb().prepare('SELECT * FROM prs WHERE id = ?').get(request.pr_id.trim());
        if (!pullRequest) throw workItemError('pull_request_not_found', 'Pull request not found');
        const existingOwner = getDb()
          .prepare('SELECT work_item_id FROM work_item_pull_requests WHERE pr_id = ?')
          .get(pullRequest.id);
        if (existingOwner) {
          return workItemListItem(getWorkItem(existingOwner.work_item_id), { getSessionStates });
        }
        const legacyWorkspace = getDb()
          .prepare("SELECT id FROM workspaces WHERE pr_id = ? AND work_item_id IS NULL AND status = 'active' LIMIT 1")
          .get(pullRequest.id);
        if (legacyWorkspace) {
          throw workItemError('legacy_workspace_exists', 'Pull request already has a legacy workspace');
        }
        const repo = `${pullRequest.org}/${pullRequest.repo}`;
        sourceRepositoryPath(repo, config);
        title = validateTitle(pullRequest.title);
        repositories = [{ repo, startRevision: pullRequest.head_oid ?? pullRequest.branch }];
      }

      withTransaction(getDb(), () => {
        getDb()
          .prepare(
            `INSERT INTO work_items (
              id, title, summary, creation_source, path, bookmark, state, stage, progress_current, progress_total,
              created_at, updated_at
            ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          )
          .run(id, title, request.source, path, bookmark, state, stage, now, now);
        if (reference) {
          getDb()
            .prepare(
              `INSERT INTO work_item_references (work_item_id, reference, resolver_provider)
               VALUES (?, ?, ?)`,
            )
            .run(id, reference, resolverProvider);
        }
        const insertRepository = getDb().prepare(
          `INSERT INTO work_item_repositories (
             work_item_id, repo, start_revision, position, membership_source, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'initial', 'adding', ?, ?)`,
        );
        repositories.forEach((repository, position) => {
          insertRepository.run(id, repository.repo, repository.startRevision, position, now, now);
        });
        if (pullRequest) {
          getDb()
            .prepare(
              `INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at)
               VALUES (?, ?, 'explicit', ?)`,
            )
            .run(pullRequest.id, id, now);
        }
      });
      emitLocalChange();
      queue(id, 'work-item.create', (task) =>
        request.source === 'reference' ? resolveAndPrepare(id, task) : prepare(id, task),
      );
      return workItemListItem(getWorkItem(id), { getSessionStates });
    },

    retry(id) {
      const row = getWorkItem(id);
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
      } else if (action === 'repository_addition') {
        const pendingWorkspace = pendingRepositoryAddition(row);
        mutateWorkItem(id, { state: 'preparing', stage: 'child_compensation', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) =>
          recoverRepositoryAddition(id, pendingWorkspace.repo, pendingWorkspace.start_revision, task),
        );
      } else if (row.stage === 'child_compensation') {
        mutateWorkItem(id, { state: 'preparing', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.create', (task) => finishCompensation(id, task));
      } else {
        mutateWorkItem(id, { state: 'destroying', ...clearErrorPatch() }, ['error']);
        queue(id, 'work-item.destroy', (task) => destroyLifecycle(id, task));
      }
      return workItemListItem(getWorkItem(id), { getSessionStates });
    },

    availableRepositories(id) {
      const item = getWorkItem(id);
      if (!item) throw workItemError('work_item_not_found', 'Work item not found');
      if (item.state === 'destroyed') throw workItemError('work_item_destroyed', 'Work item is destroyed');
      const config = getConfig();
      const attached = new Map(repositoryMemberships(id).map((membership) => [membership.repo, membership.state]));
      return Object.keys(config.repos ?? {})
        .sort()
        .map((repository) => {
          let available = true;
          let unavailableCode = null;
          try {
            sourceRepositoryPath(repository, config);
          } catch (error) {
            available = false;
            unavailableCode = error.code ?? 'repository_unavailable';
          }
          return {
            repository,
            default_revision: config.repos?.[repository]?.defaultRevision ?? null,
            attached: attached.has(repository),
            membership_state: attached.get(repository) ?? null,
            available,
            unavailable_code: unavailableCode,
          };
        });
    },

    async addRepository(id, rawRepository, rawRevision) {
      const config = getConfig();
      return withWorkItemLock(id, async () => {
        const row = getWorkItem(id);
        if (!row) throw workItemError('work_item_not_found', 'Work item not found');
        const repository = validateRepository(rawRepository, config);
        const existingRepositories = repositoriesFor(row);
        const pendingWorkspace = pendingRepositoryAddition(row);
        if (row.state === 'error' && pendingWorkspace?.repo === repository) {
          return runTask(
            {
              kind: 'work-item.add-repository',
              label: `Add ${repository}`,
              context: { workItemId: id, repo: repository },
            },
            (task) => recoverRepositoryAddition(id, repository, pendingWorkspace.start_revision, task),
          );
        }
        if (existingRepositories.includes(repository)) {
          const workItem = workItemDetail(row, { config: getConfig(), getSessionStates });
          const repositoryWorkspace = workItem.repository_workspaces.find(
            (workspace) => workspace.identifier === repository,
          );
          if (repositoryWorkspace?.state !== 'ready') {
            throw workItemError('invalid_state', `Repository workspace is not ready: ${repository}`);
          }
          return {
            added: false,
            work_item: workItem,
            repository_workspace: repositoryWorkspace,
          };
        }
        if (row.state !== 'ready') throw workItemError('work_item_busy', 'Work item is not ready');
        if (existingRepositories.length >= 32) {
          throw workItemError('repository_limit', 'Work items can contain at most 32 repositories');
        }
        const startRevision = validateRevision(rawRevision, repository, config);
        return runTask(
          {
            kind: 'work-item.add-repository',
            label: `Add ${repository}`,
            context: { workItemId: id, repo: repository },
          },
          (task) => addRepositoryLifecycle(id, repository, startRevision, task),
        );
      });
    },

    async removeRepositoryWorkspace(id, workspaceId) {
      const config = getConfig();
      return withWorkItemLock(id, async () => {
        const item = getWorkItem(id);
        if (!item) throw workItemError('work_item_not_found', 'Work item not found');
        if (item.state !== 'ready') throw workItemError('work_item_busy', 'Work item is not ready');

        const workspace = getDb()
          .prepare('SELECT * FROM workspaces WHERE id = ? AND work_item_id = ?')
          .get(workspaceId, id);
        if (!workspace) {
          throw workItemError('repository_not_in_work_item', 'Workspace does not belong to this work item');
        }
        const membership = getDb()
          .prepare('SELECT 1 FROM work_item_repositories WHERE work_item_id = ? AND repo = ?')
          .get(id, workspace.repo);
        if (!membership) {
          throw workItemError('repository_not_in_work_item', `Repository is not attached: ${workspace.repo}`);
        }
        const liveSession = getDb()
          .prepare(
            `SELECT id FROM sessions
              WHERE status IN ('active', 'detached')
                AND (work_item_id = ? OR workspace_id = ?)
              LIMIT 1`,
          )
          .get(id, workspaceId);
        if (liveSession) {
          throw workItemError('session_exists', 'Stop the active LLM session before deleting this workspace');
        }

        const remainingRepositories = repositoriesFor(item).filter((repository) => repository !== workspace.repo);
        writeTemporaryRootFiles(item.path, rootFileChildren(item, remainingRepositories), rootTask(item));
        try {
          await destroyChild(workspaceId, config, { deleteBookmark: false });
          publishRootFiles(item.path);
          const now = new Date().toISOString();
          withTransaction(getDb(), () => {
            getDb()
              .prepare('DELETE FROM work_item_repositories WHERE work_item_id = ? AND repo = ?')
              .run(id, workspace.repo);
            getDb().prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, id);
          });
        } catch (error) {
          await clearTemporaryRootFiles(item.path);
          throw error;
        }
        emitLocalChange();
        return {
          removed: true,
          work_item: workItemDetail(getWorkItem(id), { config, getSessionStates }),
        };
      });
    },

    destroy(id) {
      const row = getWorkItem(id);
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
      return { accepted: true, row: getWorkItem(id) };
    },

    list() {
      const db = getDb();
      const rows = db.prepare(`${WORK_ITEM_SELECT} WHERE wi.state != 'destroyed' ORDER BY wi.updated_at DESC`).all();
      const ids = rows.map((row) => row.id);
      const latestSessions = new Map();
      for (const session of db
        .prepare(
          `SELECT * FROM sessions
           WHERE work_item_id IS NOT NULL AND status IN ('active', 'detached')
           ORDER BY started_at DESC`,
        )
        .all()) {
        if (!latestSessions.has(session.work_item_id)) latestSessions.set(session.work_item_id, session);
      }
      const sessionHistory = new Set(
        db
          .prepare('SELECT DISTINCT work_item_id FROM sessions WHERE work_item_id IS NOT NULL')
          .all()
          .map((entry) => entry.work_item_id),
      );
      const pullRequests = listWorkItemPullRequestsBatch(ids);
      const children = new Map(ids.map((id) => [id, []]));
      for (const child of db
        .prepare(
          `SELECT rowid, * FROM workspaces
           WHERE work_item_id IS NOT NULL
           ORDER BY work_item_id, created_at DESC, rowid DESC`,
        )
        .all()) {
        children.get(child.work_item_id)?.push(child);
      }
      const config = getConfig();
      return rows.map((row) =>
        workItemListItem(row, {
          getSessionStates,
          session: latestSessions.get(row.id) ?? null,
          hasSessionHistory: sessionHistory.has(row.id),
          pullRequests: pullRequests.get(row.id) ?? [],
          repositoryWorkspaces: repositoryWorkspacesFor(row, children.get(row.id) ?? [], config),
        }),
      );
    },

    detail(id) {
      const row = getWorkItem(id);
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
  withTransaction(db, () => {
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
