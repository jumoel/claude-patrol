import { existsSync } from 'node:fs';
import { mkdir, rm, unlink } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb, withTransaction } from './db.js';
import { runTask, updateTaskProgress } from './tasks.js';
import { archiveTranscript } from './transcripts.js';
import { claudeProjectDir } from './utils.js';
import { generatedRootFileNames, publishRootFiles, writeTemporaryRootFiles } from './work-item-files.js';
import {
  checkProvider,
  childDescriptor,
  clearErrorPatch,
  enterStage,
  getWorkItem,
  latestSession,
  liveChildWorkspaces,
  liveSessionIds,
  markReady,
  mutateReference,
  mutateWorkItem,
  pendingRepositoryAddition,
  recordFailure,
  removeWorkItemRoot,
  repositoriesFor,
  repositoryMemberships,
  sanitizeLogText,
  setMembershipState,
  validateRevision,
  withWorkItemLock,
  workItemDetail,
  workItemError,
  workItemLogId,
  workspaceCount,
} from './work-item-store.js';

/**
 * Work-item lifecycle operations: preparation, repository addition and its
 * compensation, resolution, terminal launch and destruction. Each function
 * drives the durable state machine in work_items/work_item_repositories and
 * runs under the per-item lock via `queue`. The service in work-items.js
 * composes these behind its public API.
 */
export function createWorkItemLifecycle({
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
}) {
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
    withTransaction(db, () => {
      if (remove) {
        db.prepare('DELETE FROM work_item_repositories WHERE work_item_id = ? AND repo = ?').run(id, repository);
      } else {
        setMembershipState(id, 'ready', repository);
      }
      markReady(id);
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
      enterStage(id, 'preparing', 'session_launch');
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
      enterStage(id, 'ready', 'complete');
    } catch (error) {
      let cleanupError = null;
      for (const sessionId of liveSessionIds(id)) {
        try {
          await stopSession(sessionId);
        } catch (caught) {
          cleanupError = caught;
          break;
        }
      }
      const remaining = liveSessionIds(id).length;
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
    const rows = liveChildWorkspaces(id);
    enterStage(id, 'preparing', 'child_compensation', { total: rows.length });
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
    setMembershipState(id, 'error');
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
      enterStage(id, 'preparing', 'root_generation');
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
        setMembershipState(id, 'ready', child.repo);
        current += 1;
        mutateWorkItem(id, { progress_current: current, progress_total: repositories.length });
        updateTaskProgress(task.id, { current, total: repositories.length });
      }
      publishRootFiles(rootPath);
      enterStage(id, 'ready', 'complete');
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
        setMembershipState(id, 'error', repository);
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
      enterStage(id, 'resolving', 'provider_check');
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
    const rows = liveChildWorkspaces(id);
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
      for (const sessionId of liveSessionIds(id)) await stopSession(sessionId);

      mutateWorkItem(id, { state: 'destroying', stage: 'transcript_archive' });
      await archiveRootSessions(item);

      item = getWorkItem(id);
      const children = liveChildWorkspaces(id);
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
    pending,
    logStage,
    rootFileChildren,
    rootTask,
    publishCurrentRootFiles,
    clearTemporaryRootFiles,
    queue,
    launchTerminal,
    prepare,
    addRepositoryLifecycle,
    recoverRepositoryAddition,
    resolveAndPrepare,
    finishCompensation,
    destroyLifecycle,
  };
}
