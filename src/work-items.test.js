import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { createWorkItemService, deterministicBookmark, recoverInterruptedWorkItems } from './work-items.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture({ resolver, sessionAlive = true, stopSession } = {}) {
  initDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'patrol-work-items-'));
  temporaryDirectories.push(root);
  const config = {
    workspace_base_path: join(root, 'workspaces'),
    work_dir: join(root, 'sources'),
    repos: {
      'acme/alpha': { defaultRevision: 'main@origin' },
      'acme/beta': { defaultRevision: 'main@origin' },
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
    createChild: async ({ id, workItemId, repo, name, workspacePath, bookmark, config: childConfig }) => {
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
          childConfig.repos[repo].defaultRevision,
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
  });
  return { service, config, childPolicies, sessionOptions };
}

test('a two-repository item creates sibling children and one root session', async () => {
  const { service, sessionOptions } = fixture();
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
  assert.equal(sessionOptions.length, 1);
  assert.deepEqual(sessionOptions[0].target, { type: 'work_item', id: created.id });
  assert.equal(sessionOptions[0].cwd, detail.root_path);
  assert.equal(sessionOptions[0].provider, 'codex');
  assert.equal(sessionOptions[0].options.enablePatrolMcp, false);
  assert.match(sessionOptions[0].options.initialPrompt, /TASK\.json/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM sessions WHERE workspace_id IS NOT NULL').get().count, 0);

  const agents = readFileSync(join(detail.root_path, 'AGENTS.md'), 'utf8');
  const task = JSON.parse(readFileSync(join(detail.root_path, 'TASK.json'), 'utf8'));
  assert.match(agents, /acme\/alpha/);
  assert.match(agents, /acme\/beta/);
  assert.equal(task.reference, 'ECO-3632');
});

test('destruction removes owned checkouts, preserves bookmark policy, and retains detail and history', async () => {
  const { service, childPolicies } = fixture();
  const created = service.create({ reference: 'PROJECT-1', workProvider: 'claude' });
  await service.waitForIdle(created.id);
  assert.equal(service.destroy(created.id).accepted, true);
  await service.waitForIdle(created.id);

  const detail = service.detail(created.id);
  assert.equal(detail.state, 'destroyed');
  assert.equal(detail.stage, 'complete');
  assert.equal(service.list().length, 0);
  assert.equal(
    getDb()
      .prepare("SELECT COUNT(*) AS count FROM sessions WHERE work_item_id = ? AND status = 'killed'")
      .get(created.id).count,
    1,
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

test('resolver failure creates no child rows and is retryable as resolution', async () => {
  const failure = Object.assign(new Error('provider returned malformed output'), { code: 'invalid_provider_output' });
  const { service } = fixture({
    resolver: {
      resolve: async () => {
        throw failure;
      },
    },
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
  let launchHealthy = false;
  let stopAttempts = 0;
  const { service, sessionOptions } = fixture({
    sessionAlive: () => launchHealthy,
    stopSession: async (id) => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error('tmux did not stop');
      getDb()
        .prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?")
        .run(new Date().toISOString(), id);
    },
  });
  const created = service.create({ reference: 'PROJECT-TERMINAL', workProvider: 'codex' });
  await service.waitForIdle(created.id);
  let detail = service.detail(created.id);
  assert.equal(detail.state, 'error');
  assert.equal(detail.stage, 'session_launch');
  assert.equal(detail.error.code, 'cleanup_failed');
  assert.equal(detail.error.retry_action, 'terminal');

  launchHealthy = true;
  service.retry(created.id);
  await service.waitForIdle(created.id);
  detail = service.detail(created.id);
  assert.equal(detail.state, 'ready');
  assert.equal(stopAttempts, 2);
  assert.equal(sessionOptions.length, 2);
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
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, path, work_provider, resolver_provider, state, stage,
        progress_current, progress_total, created_at, updated_at
      ) VALUES ('interrupted', 'PROJECT-3', '/tmp/interrupted', 'claude', 'claude',
        'preparing', 'child_creation', 1, 2, ?, ?)`,
    )
    .run(now, now);
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
  const { service, config, childPolicies } = fixture();
  const now = new Date().toISOString();
  const itemPath = join(config.workspace_base_path, 'work-items', 'interrupted-child');
  const childPath = join(itemPath, 'repos', 'partial-child');
  mkdirSync(childPath, { recursive: true });
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, title, summary, resolved_repositories_json, path,
        work_provider, resolver_provider, state, stage, progress_current,
        progress_total, created_at, updated_at
      ) VALUES ('interrupted-child', 'PROJECT-4', 'Interrupted', 'Partial setup', ?, ?,
        'codex', 'codex', 'preparing', 'child_creation', 1, 2, ?, ?)`,
    )
    .run(JSON.stringify(['acme/alpha', 'acme/beta']), itemPath, now, now);
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

  service.retry('interrupted-child');
  await service.waitForIdle('interrupted-child');
  assert.equal(service.detail('interrupted-child').state, 'ready');
});

test('startup accepts a reattached root session as a completed terminal launch', () => {
  fixture();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO work_items (
        id, reference, path, work_provider, resolver_provider, state, stage,
        progress_current, progress_total, created_at, updated_at
      ) VALUES ('reattached', 'PROJECT-5', '/tmp/reattached', 'claude', 'claude',
        'preparing', 'session_launch', 0, 0, ?, ?)`,
    )
    .run(now, now);
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
