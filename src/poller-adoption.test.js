import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { adoptScratchWorkspaces, resetStatements } from './poller.js';

afterEach(() => {
  resetStatements();
  closeDb();
});

function insertPr(id, branch) {
  const now = '2026-08-27T12:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO prs (
        id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at
      ) VALUES (?, ?, ?, 'mono', 'chainguard-dev', 'jumoel', ?, ?, ?, ?, ?)`,
    )
    .run(id, Number(id.split('#').at(-1)), `PR ${id}`, `https://example.test/${id}`, branch, now, now, now);
}

function insertScratch(id, bookmark) {
  const now = '2026-08-27T12:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO workspaces (
        id, name, path, bookmark, repo, status, created_at, operation_state
      ) VALUES (?, ?, ?, ?, 'chainguard-dev/mono', 'active', ?, 'ready')`,
    )
    .run(id, id, `/tmp/${id}`, bookmark, now);
}

test('scratch adoption requires one exact repository and branch match', () => {
  initDb(':memory:');
  insertPr('chainguard-dev/mono#1', 'exact-branch');
  insertPr('chainguard-dev/mono#2', 'owner/suffix-only');
  insertPr('chainguard-dev/mono#3', 'shared-branch');
  insertPr('chainguard-dev/mono#4', 'shared-branch');
  insertScratch('exact', 'exact-branch');
  insertScratch('suffix', 'suffix-only');
  insertScratch('ambiguous', 'shared-branch');

  const results = adoptScratchWorkspaces();

  assert.deepEqual(results, [
    {
      workspace_id: 'ambiguous',
      workspace_name: 'ambiguous',
      status: 'ambiguous',
      candidate_pr_ids: ['chainguard-dev/mono#3', 'chainguard-dev/mono#4'],
    },
    {
      workspace_id: 'exact',
      workspace_name: 'exact',
      status: 'adopted',
      pr_id: 'chainguard-dev/mono#1',
    },
    { workspace_id: 'suffix', workspace_name: 'suffix', status: 'not_found' },
  ]);
  assert.deepEqual(
    getDb()
      .prepare('SELECT id, pr_id, repo FROM workspaces ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'ambiguous', pr_id: null, repo: 'chainguard-dev/mono' },
      { id: 'exact', pr_id: 'chainguard-dev/mono#1', repo: 'chainguard-dev/mono' },
      { id: 'suffix', pr_id: null, repo: 'chainguard-dev/mono' },
    ],
  );
});
