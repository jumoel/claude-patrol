import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb, withTransaction } from './db.js';
import { createSession, isSessionAlive, killSessionAndWait } from './pty-manager.js';
import { runTask } from './tasks.js';
import { expandPath } from './utils.js';
import { publishRootFiles, writeTemporaryRootFiles } from './work-item-files.js';
import { createWorkItemLifecycle } from './work-item-lifecycle.js';
import { listWorkItemPullRequestsBatch } from './work-item-prs.js';
import { createWorkItemResolver } from './work-item-resolver.js';
import {
  clearErrorPatch,
  getWorkItem,
  mutateWorkItem,
  pendingRepositoryAddition,
  repositoriesFor,
  repositoryMemberships,
  repositoryWorkspacesFor,
  retryAction,
  validateBookmark,
  validateReference,
  validateRepository,
  validateRepositoryList,
  validateRevision,
  validateTitle,
  WORK_ITEM_SELECT,
  withWorkItemLock,
  workItemDetail,
  workItemError,
  workItemListItem,
} from './work-item-store.js';
import {
  createWorkItemChild,
  destroyWorkItemChild,
  ensureManualSourceRepository,
  sourceRepositoryPath,
} from './workspace.js';

export {
  deterministicBookmark,
  removeWorkItemRoot,
  workItemDetail,
  workItemListItem,
} from './work-item-store.js';

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
  const lifecycle = createWorkItemLifecycle({
    getConfig,
    providerCapabilities,
    getSessionStates,
    resolver,
    schedule,
    createChild,
    destroyChild,
    prepareSourceRepository,
    launchSession,
    sessionAlive,
    stopSession,
    startupDelay,
    logger,
  });
  const {
    pending,
    rootFileChildren,
    rootTask,
    clearTemporaryRootFiles,
    queue,
    launchTerminal,
    prepare,
    addRepositoryLifecycle,
    recoverRepositoryAddition,
    resolveAndPrepare,
    finishCompensation,
    destroyLifecycle,
  } = lifecycle;

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
