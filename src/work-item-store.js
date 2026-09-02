import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb, withTransaction } from './db.js';
import { taggedError } from './errors.js';
import { createKeyedLock } from './keyed-lock.js';
import { providerSetup } from './provider-setup.js';
import { sanitizePublicText } from './public-errors.js';
import { execFile } from './utils.js';
import { listWorkItemPullRequests } from './work-item-prs.js';

export const WORK_ITEM_STATES = new Set(['resolving', 'preparing', 'ready', 'error', 'destroying', 'destroyed']);
export const WORK_ITEM_STAGES = new Set([
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

export const workItemError = (code, message, failedProvider = null) =>
  taggedError(code, sanitizePublicText(message), { failedProvider });

export const WORK_ITEM_SELECT = `
  SELECT wi.*,
         wr.reference,
         wr.reference_display,
         wr.reference_system,
         wr.reference_url,
         wr.resolver_provider
    FROM work_items wi
    LEFT JOIN work_item_references wr ON wr.work_item_id = wi.id
`;

export function getWorkItem(id) {
  return getDb().prepare(`${WORK_ITEM_SELECT} WHERE wi.id = ?`).get(id);
}

export function repositoryMemberships(id) {
  return getDb()
    .prepare(
      `SELECT * FROM work_item_repositories
       WHERE work_item_id = ?
       ORDER BY position, created_at, repo`,
    )
    .all(id);
}

export function mutateWorkItem(id, patch, expectedStates = null) {
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

export function mutateReference(id, patch) {
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

export function clearErrorPatch() {
  return { error_code: null, error_detail: null, error_provider: null };
}

export function retryAction(row) {
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

export function pendingRepositoryAddition(row) {
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

export function repositoriesFor(row) {
  return row?.id ? repositoryMemberships(row.id).map((membership) => membership.repo) : [];
}

export function isDiscoveredRepository(repository, config) {
  if (config.repos?.[repository]) return true;
  if (config.poll?.repos?.includes(repository)) return true;
  const [scope] = repository.split('/');
  return config.poll?.orgs?.includes(scope) ?? false;
}

export function validateRepository(value, config, { allowDiscovered = false } = {}) {
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
export const DEFAULT_START_REVISION = 'trunk()';

export function validateRevision(value, repository, config) {
  const rawRevision = value ?? config.repos?.[repository]?.defaultRevision ?? DEFAULT_START_REVISION;
  if (typeof rawRevision !== 'string') throw workItemError('invalid_revision', 'Revision must be a string');
  const revision = rawRevision.trim();
  const bytes = Buffer.byteLength(revision, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(revision)) {
    throw workItemError('invalid_revision', 'Revision must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return revision;
}

export function latestSession(db, workItemId) {
  return db
    .prepare(
      `SELECT * FROM sessions
       WHERE work_item_id = ? AND status IN ('active', 'detached')
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(workItemId);
}

export function hasSessionHistory(db, workItemId) {
  return Boolean(db.prepare('SELECT 1 FROM sessions WHERE work_item_id = ? LIMIT 1').get(workItemId));
}

export function activityMap(getSessionStates) {
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

export function repositoryWorkspacesFor(row, children, config) {
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

export function recoveryActions(row, config) {
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

export function repositoryState(workspace) {
  if (!workspace) return 'pending';
  if (workspace.status === 'destroyed' || workspace.operation_state === 'destroyed') return 'removed';
  if (workspace.operation_state === 'destroying') return 'removing';
  if (workspace.operation_state === 'error') return 'error';
  if (workspace.operation_state === 'ready') return 'ready';
  return 'pending';
}

export function parseWarnings(value) {
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

export function childDescriptor(workItem, repo) {
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

export function mapLifecycleError(error) {
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

export function recordFailure(id, error, { code = null, provider = null, stage = null } = {}) {
  return mutateWorkItem(id, {
    state: 'error',
    ...(stage ? { stage } : {}),
    error_code: code ?? mapLifecycleError(error),
    error_detail: sanitizePublicText(error?.message ?? String(error)),
    error_provider: provider ?? error?.failedProvider ?? null,
  });
}

export const withWorkItemLock = createKeyedLock();

export function validateReference(value) {
  if (typeof value !== 'string') throw workItemError('invalid_reference', 'Reference must be a string');
  const reference = value.trim();
  const bytes = Buffer.byteLength(reference, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(reference)) {
    throw workItemError('invalid_reference', 'Reference must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return reference;
}

export function validateTitle(value) {
  if (typeof value !== 'string') throw workItemError('invalid_title', 'Title must be a string');
  const title = value.trim();
  const bytes = Buffer.byteLength(title, 'utf8');
  if (bytes < 1 || bytes > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
    throw workItemError('invalid_title', 'Title must contain 1 to 512 UTF-8 bytes and no control characters');
  }
  return title;
}

export function validateBookmark(value, id) {
  if (value === undefined || value === null || value === '') return deterministicBookmark(id);
  if (typeof value !== 'string') throw workItemError('invalid_bookmark', 'Bookmark must be a string');
  const bookmark = value.trim();
  const bytes = Buffer.byteLength(bookmark, 'utf8');
  if (bytes < 1 || bytes > 255 || /[\s\u0000-\u001f\u007f-\u009f]/u.test(bookmark)) {
    throw workItemError('invalid_bookmark', 'Bookmark must contain 1 to 255 bytes and no whitespace or controls');
  }
  return bookmark;
}

export function validateRepositoryList(value, config, options) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw workItemError('invalid_repositories', 'repositories must contain 1 to 32 available repositories');
  }
  const repositories = value.map((repository) => validateRepository(repository, config, options));
  if (new Set(repositories).size !== repositories.length) {
    throw workItemError('invalid_repositories', 'repositories must not contain duplicates');
  }
  return repositories;
}

export function workItemLogId(id) {
  return id.replaceAll('-', '').slice(0, 8);
}

export function workspaceCount(count) {
  return `${count} workspace${count === 1 ? '' : 's'}`;
}

export function sanitizeLogText(value) {
  return sanitizePublicText(value, { maxBytes: 512 })
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export async function checkProvider(provider, capabilities) {
  const capability = await capabilities[provider].refresh();
  if (capability.available) return;
  const authentication = /auth|log\s*in/i.test(capability.reason ?? '');
  throw workItemError(
    authentication ? 'authentication_required' : 'provider_unavailable',
    capability.reason ?? `${provider} is unavailable`,
    provider,
  );
}

/**
 * Move a work item into a lifecycle stage, resetting progress and clearing any
 * previous error. Every stage entry used to spell this six-key patch inline.
 * @param {string} id
 * @param {string} state
 * @param {string} stage
 * @param {{ current?: number, total?: number, expectedStates?: string[] | null }} [options]
 */
export function enterStage(id, state, stage, { current = 0, total = 0, expectedStates = null } = {}) {
  return mutateWorkItem(
    id,
    { state, stage, progress_current: current, progress_total: total, ...clearErrorPatch() },
    expectedStates,
  );
}

/** Child workspaces of a work item that have not been destroyed, newest first. */
export function liveChildWorkspaces(id) {
  return getDb()
    .prepare(
      "SELECT * FROM workspaces WHERE work_item_id = ? AND status != 'destroyed' ORDER BY created_at DESC, rowid DESC",
    )
    .all(id);
}

/** Ids of active or detached sessions attached to a work item. */
export function liveSessionIds(id) {
  return getDb()
    .prepare("SELECT id FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
    .all(id)
    .map((row) => row.id);
}

/**
 * Set the membership state for one repository, or for every repository of
 * the work item when `repo` is null.
 * @param {string} id
 * @param {'adding'|'ready'|'error'} state
 * @param {string | null} [repo]
 */
export function setMembershipState(id, state, repo = null) {
  const now = new Date().toISOString();
  if (repo === null) {
    getDb()
      .prepare('UPDATE work_item_repositories SET state = ?, updated_at = ? WHERE work_item_id = ?')
      .run(state, now, id);
  } else {
    getDb()
      .prepare('UPDATE work_item_repositories SET state = ?, updated_at = ? WHERE work_item_id = ? AND repo = ?')
      .run(state, now, id, repo);
  }
}

/** Return a work item to ready/complete with no progress and no error. */
export function markReady(id) {
  getDb()
    .prepare(
      `UPDATE work_items
       SET state = 'ready', stage = 'complete', progress_current = 0, progress_total = 0,
           error_code = NULL, error_detail = NULL, error_provider = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), id);
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
