import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { closeDb, getDb, initDb, withTransaction } from './db.js';
import { prStore } from './pr-store.js';

const node = (patch = {}) => ({
  id: 'PR_1',
  number: 1,
  title: 'A PR',
  body: 'Description',
  state: 'OPEN',
  repository: { name: 'repo', owner: { login: 'owner' } },
  author: { login: 'alice' },
  url: 'https://github.com/owner/repo/pull/1',
  headRefName: 'change',
  headRefOid: 'abc',
  baseRefName: 'main',
  isDraft: true,
  isCrossRepository: false,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  labels: { nodes: [] },
  reviews: { nodes: [] },
  comments: { nodes: [] },
  commits: { nodes: [] },
  mergeable: 'MERGEABLE',
  ...patch,
});

beforeEach(() => initDb(':memory:'));
afterEach(closeDb);

function write(pr, kind = 'details', context = null) {
  const store = prStore();
  const own = !context;
  const observation = context ?? store.begin();
  try {
    const row = withTransaction(getDb(), () => store.write(store.prepare(pr, kind, observation)));
    store.fence.accept(observation.read, [`pr:${row.id}`]);
    return row;
  } finally {
    if (own) store.end(observation);
  }
}

test('summary insertion stays outside authored membership and never claims details', () => {
  const row = write(node(), 'summary');
  assert.equal(row.details_synced_at, null);
  assert.equal(row.review_revision, null);
  assert.ok(row.snapshot_version);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM authored_prs').get().n, 0);
});

test('summary refresh preserves coherent body and detail values', () => {
  const first = write(node({ bodyHTML: '<p>Description</p>' }));
  const next = write(node({ title: 'New title', updatedAt: '2026-09-02T00:00:00Z' }), 'summary');
  assert.equal(next.body, first.body);
  assert.equal(next.body_html, first.body_html);
  assert.equal(next.body_title, first.title);
  assert.equal(next.review_revision, first.review_revision);
  assert.equal(next.details_synced_at, first.details_synced_at);
  assert.notEqual(next.snapshot_version, first.snapshot_version);
});

test('older and equal-timestamp conflicting reads cannot replace a newer accepted read', () => {
  write(node());
  const store = prStore();
  const old = store.begin();
  write(node({ title: 'New' }));
  assert.throws(() => write(node({ title: 'Old' }), 'details', old), /superseded/);
  store.end(old);
  const pending = store.begin();
  write(node({ title: 'New' }));
  assert.throws(() => write(node({ title: 'Other' }), 'details', pending), /superseded/);
  store.end(pending);
});

test('remote identity preserves the local ID through a repository rename', () => {
  write(node());
  const moved = write(node({ repository: { name: 'renamed', owner: { login: 'owner' } } }));
  assert.equal(moved.id, 'owner/repo#1');
  assert.equal(moved.repo, 'renamed');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM prs').get().n, 1);
});

test('review-written draft state cannot consume an authored transition', () => {
  const store = prStore();
  const viewer = { id: 'user-alice', login: 'alice' };
  const first = write(node());
  assert.equal(store.authored(first, viewer, 'now').changes, null);
  write(node({ isDraft: false }), 'summary');
  const next = write(node({ isDraft: false }));
  assert.deepEqual(store.authored(next, viewer, 'later').changes, { draft: { from: true, to: false } });
  assert.equal(store.authored(next, viewer, 'later').changes, null);
});

test('garbage collection preserves explicit local-work references to review-only PRs', () => {
  write(node());
  getDb()
    .prepare(`INSERT INTO workspaces (id, pr_id, name, path, bookmark, status, created_at)
    VALUES ('ws', 'owner/repo#1', 'ws', '/tmp/ws', 'change', 'active', 'now')`)
    .run();
  prStore().collect();
  assert.ok(getDb().prepare('SELECT id FROM prs').get());
});
