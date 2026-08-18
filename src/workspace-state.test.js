import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { destroyWorkspace, inspectWorkspaceState } from './workspace.js';

afterEach(() => closeDb());

function insertWorkspace(overrides = {}) {
  const now = new Date().toISOString();
  const workspace = {
    id: overrides.id ?? 'workspace-1',
    pr_id: overrides.pr_id ?? null,
    name: overrides.name ?? 'test-workspace',
    path: overrides.path ?? '/path/that/does/not/exist',
    bookmark: 'feature',
    repo: overrides.repo ?? null,
    status: overrides.status ?? 'active',
    operation_state: overrides.operation_state ?? 'ready',
    operation_step: overrides.operation_step ?? 'create:complete',
    operation_error: overrides.operation_error ?? null,
    created_at: now,
    destroyed_at: overrides.destroyed_at ?? null,
    operation_updated_at: now,
  };
  getDb()
    .prepare(
      `INSERT INTO workspaces
        (id, pr_id, name, path, bookmark, repo, status, operation_state, operation_step,
         operation_error, created_at, destroyed_at, operation_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workspace.id,
      workspace.pr_id,
      workspace.name,
      workspace.path,
      workspace.bookmark,
      workspace.repo,
      workspace.status,
      workspace.operation_state,
      workspace.operation_step,
      workspace.operation_error,
      workspace.created_at,
      workspace.destroyed_at,
      workspace.operation_updated_at,
    );
  return workspace;
}

test('workspace inspection reports interrupted and missing states without changing rows', () => {
  initDb(':memory:');
  insertWorkspace();
  insertWorkspace({ id: 'workspace-2', operation_state: 'destroying', operation_step: 'destroy:directory' });

  const before = getDb().prepare('SELECT * FROM workspaces ORDER BY id').all();
  const issues = inspectWorkspaceState();
  const after = getDb().prepare('SELECT * FROM workspaces ORDER BY id').all();

  assert.deepEqual(after, before);
  assert.deepEqual(
    issues.map((issue) => [issue.workspace_id, issue.state]),
    [
      ['workspace-1', 'inconsistent'],
      ['workspace-2', 'destroying'],
    ],
  );
});

test('destroying an already-complete workspace is idempotent', async () => {
  initDb(':memory:');
  getDb()
    .prepare(
      `INSERT INTO prs
        (id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at)
       VALUES ('example/project#1', 1, 'Test', 'project', 'example', 'octocat',
               'https://example.test/pr/1', 'feature', ?, ?, ?)`,
    )
    .run(...Array(3).fill(new Date().toISOString()));
  insertWorkspace({
    pr_id: 'example/project#1',
    status: 'destroyed',
    operation_state: 'destroyed',
    operation_step: 'destroy:complete',
    destroyed_at: new Date().toISOString(),
  });

  assert.deepEqual(await destroyWorkspace('workspace-1', { work_dir: '/tmp' }), { ok: true, warnings: [] });
  assert.deepEqual(
    { ...getDb().prepare('SELECT pr_id, repo FROM workspaces WHERE id = ?').get('workspace-1') },
    {
      pr_id: null,
      repo: 'example/project',
    },
  );
});
