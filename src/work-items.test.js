import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { insertTestWorkItem } from './test-support/work-items.js';
import {
  createWorkItemService,
  deterministicBookmark,
  recoverInterruptedWorkItems,
  removeWorkItemRoot,
} from './work-items.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture({
  resolver,
  sessionAlive = true,
  stopSession,
  addedRepositoryError = null,
  logger = { log() {}, warn() {} },
} = {}) {
  initDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'patrol-work-items-'));
  temporaryDirectories.push(root);
  const config = {
    workspace_base_path: join(root, 'workspaces'),
    work_dir: join(root, 'sources'),
    repos: {
      'acme/alpha': { defaultRevision: 'main@origin' },
      'acme/beta': { defaultRevision: 'main@origin' },
      'acme/gamma': {},
    },
    work_items: {
      repositories: ['acme/alpha', 'acme/beta'],
      resolver: {
        provider: undefined,
        instructions: 'Resolve the reference.',
        server: {
          name: 'work-reference',
          transport: 'http',
          url: 'https://mcp.example.test/readonly',
          enabled_tools: ['get_issue'],
        },
      },
    },
  };
  for (const repository of Object.keys(config.repos)) {
    const [owner, name] = repository.split('/');
    mkdirSync(join(config.work_dir, owner, name, '.jj'), { recursive: true });
  }
  const childPolicies = [];
  const sessionOptions = [];
  let sessionNumber = 0;
  const service = createWorkItemService({
    getConfig: () => config,
    providerCapabilities: {
      claude: { refresh: async () => ({ available: true }) },
      codex: { refresh: async () => ({ available: true }) },
    },
    getSessionStates: () => [],
    resolver: resolver ?? {
      resolve: async () => ({
        title: 'Cross-repository repair',
        summary: 'Change both repositories.',
        repositories: ['acme/alpha', 'acme/beta'],
      }),
    },
    createChild: async ({
      id,
      workItemId,
      repo,
      name,
      workspacePath,
      bookmark,
      config: childConfig,
      startRevision,
    }) => {
      if (repo === 'acme/beta' && addedRepositoryError) throw addedRepositoryError;
      mkdirSync(workspacePath, { recursive: true });
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO workspaces (
            id, work_item_id, name, path, bookmark, repo, status, created_at,
            operation_state, operation_step, operation_updated_at, start_revision,
            base_commit, setup_warnings_json
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'ready', 'create:complete', ?, ?, ?, '[]')`,
        )
        .run(
          id,
          workItemId,
          name,
          workspacePath,
          bookmark,
          repo,
          now,
          now,
          startRevision ?? childConfig.repos[repo].defaultRevision,
          repo === 'acme/alpha' ? 'a'.repeat(64) : 'b'.repeat(64),
        );
      return getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    },
    destroyChild: async (id, _config, policy) => {
      const child = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
      childPolicies.push({ repo: child.repo, ...policy });
      rmSync(child.path, { recursive: true, force: true });
      getDb()
        .prepare(
          `UPDATE workspaces
           SET status = 'destroyed', operation_state = 'destroyed', operation_step = 'destroy:complete', destroyed_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), id);
    },
    launchSession: (target, cwd, provider, options) => {
      sessionNumber += 1;
      const id = `session-${sessionNumber}`;
      sessionOptions.push({ target, cwd, provider, options });
      getDb()
        .prepare(
          `INSERT INTO sessions (id, work_item_id, pid, provider, status, started_at)
           VALUES (?, ?, 123, ?, 'active', ?)`,
        )
        .run(id, target.id, provider, new Date().toISOString());
      return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    },
    sessionAlive: (id) => (typeof sessionAlive === 'function' ? sessionAlive(id) : sessionAlive),
    stopSession:
      stopSession ??
      (async (id) => {
        getDb()
          .prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?")
          .run(new Date().toISOString(), id);
      }),
    startupDelay: async () => {},
    logger,
  });
  return { service, config, childPolicies, sessionOptions };
}

test('a two-repository item creates sibling children and waits for the root session', async () => {
  const messages = [];
  const { service, sessionOptions } = fixture({
    logger: {
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
  });
  const created = service.create({ reference: '  ECO-3632  ', workProvider: 'codex' });
  assert.equal(created.reference, 'ECO-3632');
  assert.equal(created.state, 'resolving');
  await service.waitForIdle(created.id);

  const detail = service.detail(created.id);
  assert.equal(detail.state, 'ready');
  assert.equal(detail.stage, 'complete');
  assert.deepEqual(detail.repositories, ['acme/alpha', 'acme/beta']);
  assert.equal(detail.repository_workspaces.length, 2);
  assert.equal(new Set(detail.repository_workspaces.map((child) => child.bookmark)).size, 1);
  assert.equal(detail.repository_workspaces[0].bookmark, deterministicBookmark(created.id));
  assert.equal(detail.has_session_history, false);
  assert.equal(sessionOptions.length, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM sessions WHERE workspace_id IS NOT NULL').get().count, 0);
  const listed = service.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].repository_workspaces.length, 2);
  assert.deepEqual(
    listed[0].repository_workspaces.map((child) => child.identifier),
    ['acme/alpha', 'acme/beta'],
  );

  const agents = readFileSync(join(detail.root_path, 'AGENTS.md'), 'utf8');
  const task = JSON.parse(readFileSync(join(detail.root_path, 'TASK.json'), 'utf8'));
  assert.match(agents, /acme\/alpha/);
  assert.match(agents, /acme\/beta/);
  assert.equal(task.reference, 'ECO-3632');

  const logId = created.id.replaceAll('-', '').slice(0, 8);
  assert.deepEqual(messages, [
    `[work-items] ${logId} provider_check: codex availability`,
    `[work-items] ${logId} reference_resolution: ECO-3632 via codex`,
    `[work-items] ${logId} root_generation: generating files for 2 repos`,
    `[work-items] ${logId} child_creation: creating 2 workspaces`,
    `[work-items] ${logId} child_creation: creating 1/2 acme/alpha`,
    `[work-items] ${logId} child_creation: creating 2/2 acme/beta`,
    `[work-items] ${logId} complete: ready with 2 workspaces`,
  ]);
});

test('manual work creates one aggregate for multiple configured repositories without a reference', async () => {
  const { service } = fixture();
  const created = service.create({
    source: 'manual',
    title: 'Coordinate the release',
    repositories: ['acme/alpha', 'acme/beta'],
  });
  assert.equal(created.creation_source, 'manual');
  assert.equal(created.reference, null);
  assert.equal(created.resolver_provider, null);
  await service.waitForIdle(created.id);

  const detail = service.detail(created.id);
  assert.equal(detail.state, 'ready');
  assert.equal(detail.title, 'Coordinate the release');
  assert.deepEqual(detail.repositories, ['acme/alpha', 'acme/beta']);
  assert.equal(detail.repository_workspaces[0].bookmark, deterministicBookmark(created.id));
  const task = JSON.parse(readFileSync(join(detail.root_path, 'TASK.json'), 'utf8'));
  assert.equal(Object.hasOwn(task, 'reference'), false);
  assert.equal(task.title, 'Coordinate the release');
});

test('pull-request local work creates a one-repository aggregate and owns the PR', async () => {
  const { service } = fixture();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO prs (
        id, number, title, repo, org, author, url, branch, head_oid,
        created_at, updated_at, synced_at
      ) VALUES ('acme/alpha#42', 42, 'Repair the release', 'alpha', 'acme', 'octocat',
        'https://github.com/acme/alpha/pull/42', 'repair-release', ?, ?, ?, ?)`,
    )
    .run('a'.repeat(64), now, now, now);

  const created = service.create({ source: 'pull_request', pr_id: 'acme/alpha#42' });
  assert.equal(created.creation_source, 'pull_request');
  assert.equal(created.reference, null);
  await service.waitForIdle(created.id);

  const detail = service.detail(created.id);
  assert.deepEqual(detail.repositories, ['acme/alpha']);
  assert.equal(detail.repository_workspaces[0].start_revision, 'a'.repeat(64));
  assert.equal(detail.pull_requests[0].id, 'acme/alpha#42');
  assert.equal(
    getDb().prepare("SELECT work_item_id FROM work_item_pull_requests WHERE pr_id = 'acme/alpha#42'").get()
      .work_item_id,
    created.id,
  );
});

test('provider-native work-reference metadata is persisted without UI-specific normalization', async () => {
  const { service } = fixture({
    resolver: {
      resolve: async () => ({
        title: 'Reference metadata',
        summary: 'Preserve provider fields.',
        repositories: ['acme/alpha'],
        work_reference: {
          display: 'ECO-3351',
          system: 'linear.app',
          url: 'https://linear.app/acme/issue/ECO-3351/title',
        },
      }),
    },
  });
  const created = service.create({ reference: 'eco-3351', workProvider: 'codex' });
  await service.waitForIdle(created.id);

  const listed = service.list()[0];
  assert.equal(listed.reference, 'eco-3351');
  assert.equal(listed.reference_display, 'ECO-3351');
  assert.equal(listed.reference_system, 'linear.app');
  assert.equal(listed.reference_url, 'https://linear.app/acme/issue/ECO-3351/title');
});

test('a repository can be added to a ready work item and duplicate additions are no-ops', async () => {
  const { service } = fixture({
    resolver: {
      resolve: async () => ({
        title: 'Expand the repair',
        summary: 'Start in alpha and add beta when needed.',
        repositories: ['acme/alpha'],
      }),
    },
  });
  const created = service.create({ reference: 'PROJECT-ADD', workProvider: 'codex' });
  await service.waitForIdle(created.id);

  const result = await service.addRepository(created.id, 'acme/beta');
  assert.equal(result.added, true);
  assert.equal(result.repository_workspace.identifier, 'acme/beta');
  assert.equal(result.repository_workspace.state, 'ready');
  assert.deepEqual(result.work_item.repositories, ['acme/alpha', 'acme/beta']);
  assert.match(readFileSync(join(result.work_item.root_path, 'AGENTS.md'), 'utf8'), /acme\/beta/);
  assert.match(readFileSync(join(result.work_item.root_path, 'CLAUDE.md'), 'utf8'), /acme\/beta/);

  const duplicate = await service.addRepository(created.id, 'acme/beta');
  assert.equal(duplicate.added, false);
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM workspaces WHERE work_item_id = ? AND repo = 'acme/beta'")
      .get(created.id).count,
    1,
  );
});

test('repository discovery reflects additions immediately in the running work item', async () => {
  const { service } = fixture({
    resolver: {
      resolve: async () => ({
        title: 'Discover more work',
        summary: 'Start with alpha.',
        repositories: ['acme/alpha'],
      }),
    },
  });
  const created = service.create({ source: 'reference', reference: 'PROJECT-DISCOVERY', resolver_provider: 'codex' });
  await service.waitForIdle(created.id);

  let available = service.availableRepositories(created.id);
  assert.equal(available.find((entry) => entry.repository === 'acme/alpha').attached, true);
  assert.equal(available.find((entry) => entry.repository === 'acme/beta').attached, false);
  assert.equal(available.find((entry) => entry.repository === 'acme/gamma').default_revision, null);

  await service.addRepository(created.id, 'acme/beta');
  available = service.availableRepositories(created.id);
  const beta = available.find((entry) => entry.repository === 'acme/beta');
  assert.equal(beta.attached, true);
  assert.equal(beta.membership_state, 'ready');
});

test('repository additions reject repositories outside the configured repos', async () => {
  const { service } = fixture({
    resolver: {
      resolve: async () => ({
        title: 'Scoped repair',
        summary: 'Only alpha is needed.',
        repositories: ['acme/alpha'],
      }),
    },
  });
  const created = service.create({ reference: 'PROJECT-SCOPE', workProvider: 'claude' });
  await service.waitForIdle(created.id);

  await assert.rejects(
    service.addRepository(created.id, 'acme/unconfigured'),
    (error) => error.code === 'repository_not_configured',
  );
  assert.deepEqual(service.detail(created.id).repositories, ['acme/alpha']);
});

test('a configured repository outside the resolver candidates can be added from an explicit revision', async () => {
  const { service } = fixture({
    resolver: {
      resolve: async () => ({
        title: 'Cross-repository follow-up',
        summary: 'Add gamma only when the agent discovers it is needed.',
        repositories: ['acme/alpha'],
      }),
    },
  });
  const created = service.create({ reference: 'PROJECT-REVISION', workProvider: 'codex' });
  await service.waitForIdle(created.id);

  await assert.rejects(service.addRepository(created.id, 'acme/gamma'), (error) => error.code === 'revision_required');
  const result = await service.addRepository(created.id, 'acme/gamma', 'feature@git');
  assert.equal(result.added, true);
  assert.equal(result.repository_workspace.start_revision, 'feature@git');
  assert.deepEqual(result.work_item.repositories, ['acme/alpha', 'acme/gamma']);
});

test('a failed repository addition restores the ready work item and its root files', async () => {
  const failure = Object.assign(new Error('beta source is unavailable'), { code: 'repository_unavailable' });
  const { service } = fixture({
    addedRepositoryError: failure,
    resolver: {
      resolve: async () => ({
        title: 'Resilient repair',
        summary: 'Keep alpha usable if beta cannot be added.',
        repositories: ['acme/alpha'],
      }),
    },
  });
  const created = service.create({ reference: 'PROJECT-ROLLBACK', workProvider: 'codex' });
  await service.waitForIdle(created.id);

  await assert.rejects(service.addRepository(created.id, 'acme/beta'), failure);
  const detail = service.detail(created.id);
  assert.equal(detail.state, 'ready');
  assert.deepEqual(detail.repositories, ['acme/alpha']);
  assert.doesNotMatch(readFileSync(join(detail.root_path, 'AGENTS.md'), 'utf8'), /acme\/beta/);
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM work_item_repositories WHERE work_item_id = ? AND repo = 'acme/beta'")
      .get(created.id).count,
    0,
  );
});

test('destruction removes owned checkouts, preserves bookmark policy, and retains detail and history', async () => {
  const { service, childPolicies } = fixture();
  const created = service.create({ reference: 'PROJECT-1', workProvider: 'claude' });
  await service.waitForIdle(created.id);
  const ready = service.detail(created.id);
  const dirtyDirectory = join(ready.root_path, 'repos', 'unmanaged-checkout');
  mkdirSync(dirtyDirectory, { recursive: true });
  writeFileSync(join(dirtyDirectory, 'dirty.txt'), 'uncommitted work\n');
  mkdirSync(join(ready.root_path, '.pnpm-store'), { recursive: true });
  writeFileSync(join(ready.root_path, '.pnpm-store', 'index.db'), 'cache\n');
  assert.equal(service.destroy(created.id).accepted, true);
  await service.waitForIdle(created.id);

  const detail = service.detail(created.id);
  assert.equal(detail.state, 'destroyed');
  assert.equal(detail.stage, 'complete');
  assert.equal(existsSync(ready.root_path), false);
  assert.equal(service.list().length, 0);
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE work_item_id = ? AND status = 'killed'")
      .get(created.id).count,
    0,
  );
  assert.deepEqual(
    childPolicies.map((entry) => entry.deleteBookmark),
    [false, false],
  );
  assert.equal(
    detail.repository_workspaces.every((child) => child.state === 'removed'),
    true,
  );
});

test('dirty-root cleanup removes nested Git worktrees even when deregistration warns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'patrol-dirty-root-'));
  temporaryDirectories.push(root);
  const worktree = join(root, 'repos', 'manual-worktree');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: /tmp/source/.git/worktrees/manual-worktree\n');
  writeFileSync(join(worktree, 'dirty.txt'), 'uncommitted work\n');
  mkdirSync(join(root, '.pnpm-store'), { recursive: true });
  const calls = [];

  const warnings = await removeWorkItemRoot(root, {
    runExec: async (command, args) => {
      calls.push([command, args]);
      throw new Error('injected deregistration failure');
    },
  });

  assert.deepEqual(calls, [['git', ['-C', worktree, 'worktree', 'remove', '--force', worktree]]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /injected deregistration failure/);
  assert.equal(existsSync(root), false);
});

test('dirty-root cleanup force-removes and deregisters a dirty nested Git worktree', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'patrol-dirty-git-root-'));
  temporaryDirectories.push(fixtureRoot);
  const source = join(fixtureRoot, 'source');
  const root = join(fixtureRoot, 'work-item');
  const worktree = join(root, 'repos', 'manual-worktree');
  mkdirSync(join(root, 'repos'), { recursive: true });
  execFileSync('git', ['init', source], { stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-C',
      source,
      '-c',
      'user.name=Patrol Test',
      '-c',
      'user.email=patrol@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-m',
      'initial',
    ],
    { stdio: 'ignore' },
  );
  execFileSync('git', ['-C', source, 'worktree', 'add', '-b', 'feature', worktree], { stdio: 'ignore' });
  writeFileSync(join(worktree, 'dirty.txt'), 'uncommitted work\n');

  const warnings = await removeWorkItemRoot(root);

  assert.deepEqual(warnings, []);
  assert.equal(existsSync(root), false);
  assert.doesNotMatch(execFileSync('git', ['-C', source, 'worktree', 'list'], { encoding: 'utf8' }), /manual-worktree/);
});

test('resolver failure creates no child rows and is retryable as resolution', async () => {
  const failure = Object.assign(new Error('provider returned\nmalformed output \u001b[2J'), {
    code: 'invalid_provider_output',
  });
  const warnings = [];
  const { service } = fixture({
    resolver: {
      resolve: async () => {
        throw failure;
      },
    },
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });
  const created = service.create({ reference: 'PROJECT-2', workProvider: 'claude' });
  await service.waitForIdle(created.id);

  const detail = service.detail(created.id);
  assert.equal(detail.state, 'error');
  assert.equal(detail.stage, 'reference_resolution');
  assert.equal(detail.error.code, 'resolver_output_invalid');
  assert.equal(detail.error.retry_action, 'resolution');
  assert.equal(
    getDb().prepare('SELECT COUNT(*) AS count FROM workspaces WHERE work_item_id = ?').get(created.id).count,
    0,
  );
  const logId = created.id.replaceAll('-', '').slice(0, 8);
  assert.deepEqual(warnings, [
    `[work-items] ${logId} reference_resolution failed: provider returned malformed output [2J`,
  ]);
});

test('detail DTO sanitizes persisted warnings and lifecycle errors at the API boundary', async () => {
  const { service } = fixture();
  const created = service.create({ reference: 'PROJECT-REDACTION', workProvider: 'codex' });
  await service.waitForIdle(created.id);
  const child = getDb().prepare('SELECT id FROM workspaces WHERE work_item_id = ? LIMIT 1').get(created.id);
  getDb()
    .prepare('UPDATE workspaces SET setup_warnings_json = ? WHERE id = ?')
    .run(JSON.stringify([`api_key=super-secret-value ${'x'.repeat(5000)}`]), child.id);
  getDb()
    .prepare("UPDATE work_items SET state = 'error', error_code = 'setup_failed', error_detail = ? WHERE id = ?")
    .run(`Authorization: Bearer abcdefghijklmnop ${'y'.repeat(20_000)}`, created.id);

  const detail = service.detail(created.id);
  const warning = detail.repository_workspaces.find((repository) => repository.workspace_id === child.id).warnings[0];
  assert.doesNotMatch(warning, /super-secret-value/);
  assert.ok(Buffer.byteLength(warning, 'utf8') <= 4096);
  assert.doesNotMatch(detail.error.detail, /abcdefghijklmnop/);
  assert.ok(Buffer.byteLength(detail.error.detail, 'utf8') <= 16 * 1024);
});

test('terminal retry cleans a stale failed launch and starts its replacement once', async () => {
  let stopAttempts = 0;
  const { service, sessionOptions } = fixture({
    sessionAlive: true,
    stopSession: async (id) => {
      stopAttempts += 1;
      getDb()
        .prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    },
  });
  const created = service.create({ reference: 'PROJECT-TERMINAL', workProvider: 'codex' });
  await service.waitForIdle(created.id);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, work_item_id, pid, provider, status, started_at)
       VALUES ('stale-session', ?, 123, 'codex', 'active', ?)`,
    )
    .run(created.id, now);
  getDb()
    .prepare(
      `UPDATE work_items
       SET state = 'error', stage = 'session_launch', error_code = 'session_launch_failed',
           error_detail = 'Interrupted session launch', updated_at = ?
       WHERE id = ?`,
    )
    .run(now, created.id);
  let detail = service.detail(created.id);
  assert.equal(detail.state, 'error');
  assert.equal(detail.stage, 'session_launch');
  assert.equal(detail.error.code, 'session_launch_failed');
  assert.equal(detail.error.retry_action, 'terminal');

  service.retry(created.id);
  await service.waitForIdle(created.id);
  detail = service.detail(created.id);
  assert.equal(detail.state, 'ready');
  assert.equal(detail.has_session_history, true);
  assert.equal(stopAttempts, 1);
  assert.equal(sessionOptions.length, 1);
  assert.deepEqual(sessionOptions[0].options, { enablePatrolMcp: true });
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE work_item_id = ? AND status IN ('active', 'detached')")
      .get(created.id).count,
    1,
  );
});

test('invalid references fail synchronously without inserting a work item', () => {
  const { service } = fixture();
  assert.throws(
    () => service.create({ reference: '', workProvider: 'claude' }),
    (error) => error.code === 'invalid_reference',
  );
  assert.throws(
    () => service.create({ reference: 'bad\nreference', workProvider: 'claude' }),
    (error) => error.code === 'invalid_reference',
  );
  assert.throws(
    () => service.create({ reference: '\u00e9'.repeat(257), workProvider: 'claude' }),
    (error) => error.code === 'invalid_reference',
  );
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM work_items').get().count, 0);
});

test('startup converts interrupted work items into retryable errors', () => {
  fixture();
  const now = new Date().toISOString();
  insertTestWorkItem(getDb(), {
    id: 'interrupted',
    reference: 'PROJECT-3',
    path: '/tmp/interrupted',
    resolverProvider: 'claude',
    state: 'preparing',
    stage: 'child_creation',
    progressCurrent: 1,
    progressTotal: 2,
    createdAt: now,
  });
  const recovered = recoverInterruptedWorkItems();
  assert.deepEqual(
    recovered.map((row) => ({ ...row })),
    [{ id: 'interrupted', stage: 'child_creation' }],
  );
  const row = getDb().prepare('SELECT state, error_code, error_detail FROM work_items WHERE id = ?').get('interrupted');
  assert.equal(row.state, 'error');
  assert.equal(row.error_code, 'interrupted');
  assert.match(row.error_detail, /child_creation/);
});

test('startup requires partial child cleanup before preparation can retry', async () => {
  const messages = [];
  const { service, config, childPolicies } = fixture({
    logger: {
      log: (message) => messages.push(message),
      warn: (message) => messages.push(message),
    },
  });
  const now = new Date().toISOString();
  const itemPath = join(config.workspace_base_path, 'work-items', 'interrupted-child');
  const childPath = join(itemPath, 'repos', 'partial-child');
  mkdirSync(childPath, { recursive: true });
  insertTestWorkItem(getDb(), {
    id: 'interrupted-child',
    reference: 'PROJECT-4',
    title: 'Interrupted',
    summary: 'Partial setup',
    repositories: ['acme/alpha', 'acme/beta'],
    path: itemPath,
    state: 'preparing',
    stage: 'child_creation',
    progressCurrent: 1,
    progressTotal: 2,
    createdAt: now,
  });
  getDb()
    .prepare(
      `INSERT INTO workspaces (
        id, work_item_id, name, path, bookmark, repo, status, created_at,
        operation_state, operation_step, operation_updated_at, start_revision,
        base_commit, setup_warnings_json
      ) VALUES ('partial-child', 'interrupted-child', 'partial-child', ?,
        'patrol/work-item-interrupted', 'acme/alpha', 'active', ?, 'error',
        'create:add_workspace', ?, 'main@origin', ?, '[]')`,
    )
    .run(childPath, now, now, 'a'.repeat(64));

  recoverInterruptedWorkItems();
  let detail = service.detail('interrupted-child');
  assert.equal(detail.state, 'error');
  assert.equal(detail.stage, 'child_compensation');
  assert.deepEqual(detail.progress, { current: 0, total: 1 });
  assert.equal(detail.error.retry_action, 'cleanup');

  service.retry('interrupted-child');
  await service.waitForIdle('interrupted-child');
  detail = service.detail('interrupted-child');
  assert.equal(detail.stage, 'child_creation');
  assert.equal(detail.error.retry_action, 'preparation');
  assert.deepEqual(childPolicies, [{ repo: 'acme/alpha', deleteBookmark: true }]);
  assert.deepEqual(messages, [
    '[work-items] interrup child_compensation: resuming 1 workspace',
    '[work-items] interrup child_compensation: removing 1/1 acme/alpha',
  ]);

  service.retry('interrupted-child');
  await service.waitForIdle('interrupted-child');
  assert.equal(service.detail('interrupted-child').state, 'ready');
});

test('startup accepts a reattached root session as a completed terminal launch', () => {
  fixture();
  const now = new Date().toISOString();
  insertTestWorkItem(getDb(), {
    id: 'reattached',
    reference: 'PROJECT-5',
    path: '/tmp/reattached',
    resolverProvider: 'claude',
    state: 'preparing',
    stage: 'session_launch',
    createdAt: now,
  });
  getDb()
    .prepare(
      `INSERT INTO sessions (id, work_item_id, pid, provider, status, started_at)
       VALUES ('reattached-session', 'reattached', 123, 'claude', 'active', ?)`,
    )
    .run(now);

  recoverInterruptedWorkItems();
  const row = getDb().prepare('SELECT state, stage, error_code FROM work_items WHERE id = ?').get('reattached');
  assert.deepEqual({ ...row }, { state: 'ready', stage: 'complete', error_code: null });
});
