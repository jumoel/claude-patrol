import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { closeDb, getDb, initDb, withTransaction } from './db.js';
import { prStore } from './pr-store.js';
import { reviewStore } from './review-request-store.js';

const viewer = { id: 'u1', login: 'alice' };
const poll = { orgs: ['org'], repos: [], interval_seconds: 30, review_requests: { users: ['@me'], teams: [] } };
const node = (number = 1, patch = {}) => ({
  id: `PR_${number}`,
  number,
  title: `PR ${number}`,
  body: 'body',
  state: 'OPEN',
  repository: { name: 'repo', owner: { login: 'org' } },
  author: { login: 'bob' },
  url: `https://github.com/org/repo/pull/${number}`,
  headRefName: 'branch',
  headRefOid: 'abc',
  baseRefName: 'main',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
  ...patch,
});

beforeEach(() => {
  initDb(':memory:');
  getDb()
    .prepare('UPDATE sync_state SET viewer_id = ?, viewer_login = ?, viewer_verified = 1')
    .run(viewer.id, viewer.login);
  reviewStore().reconcile(poll, viewer);
});
afterEach(closeDb);

function observe(pr = node()) {
  const store = reviewStore();
  const context = store.begin();
  const keys = [];
  try {
    const row = withTransaction(getDb(), () => {
      const row = prStore().write(prStore().prepare(pr, 'body', context));
      keys.push(`pr:${row.id}`, store.discover(row.id, store.targets()[0], viewer, context, 'now'));
      return row;
    });
    prStore().fence.accept(context.read, keys);
    return row;
  } finally {
    prStore().end(context);
  }
}

function event(id = 'org/repo#1', eventId = 'E1') {
  const store = reviewStore();
  const context = store.begin();
  try {
    const row = getDb().prepare('SELECT * FROM prs WHERE id = ?').get(id);
    const key = withTransaction(getDb(), () =>
      store.verifyEvent(
        id,
        store.targets()[0],
        { id: eventId, createdAt: row.updated_at },
        row.updated_at,
        context,
        'now',
      ),
    );
    prStore().fence.accept(context.read, [key]);
  } finally {
    prStore().end(context);
  }
}

function acknowledge(collapsed) {
  const store = reviewStore();
  const context = store.begin();
  try {
    const row = store.rows(['org/repo#1'], poll)[0];
    const result = store.acknowledge(poll, row.id, row.state_version, collapsed, context);
    prStore().fence.accept(context.read, result.keys ?? []);
    return result;
  } finally {
    prStore().end(context);
  }
}

test('collapse requires a verified tuple and request event', () => {
  observe();
  assert.throws(() => acknowledge(true), /need verification/);
  event();
  assert.equal(acknowledge(true).row.collapsed, true);
  assert.equal(reviewStore().list(poll).rows[0].collapsed, true);
});

test('a proven edit followed by a revert stays expanded', () => {
  observe();
  event();
  acknowledge(true);
  observe(node(1, { title: 'Changed' }));
  assert.equal(reviewStore().list(poll).rows[0].collapsed, false);
  observe();
  assert.equal(reviewStore().list(poll).rows[0].collapsed, false);
  assert.equal(acknowledge(true).row.collapsed, true);
});

test('request removal retains an acknowledgement and a later event reopens it', () => {
  observe();
  event();
  acknowledge(true);
  const store = reviewStore();
  const context = store.begin();
  const key = withTransaction(getDb(), () =>
    store.verifyMatch('org/repo#1', store.targets()[0], false, viewer, context, 'later'),
  );
  prStore().fence.accept(context.read, [key]);
  prStore().end(context);
  prStore().collect();
  assert.equal(store.list(poll).rows[0].collapsed, true);
  event('org/repo#1', 'E2');
  assert.equal(store.list(poll).rows[0].collapsed, false);
  assert.equal(acknowledge(true).row.collapsed, true);
  assert.equal(acknowledge(false).removed, true);
});

test('local pagination survives verification-only changes but rejects order changes', () => {
  observe();
  observe(node(2));
  const store = reviewStore();
  const page = store.list(poll, { limit: 1 });
  assert.equal(page.total_count, 2);
  event();
  assert.equal(store.list(poll, { cursor: page.next_cursor, limit: 1 }).rows[0].id, 'org/repo#2');
  acknowledge(true);
  assert.throws(() => store.list(poll, { cursor: page.next_cursor }), /ordering changed/);
  assert.deepEqual(store.list(poll, { ids: ['org/repo#1', 'missing'] }).missing_ids, ['missing']);
});

test('explicit expansion removes an inactive acknowledgement already reopened by a change', () => {
  observe();
  event();
  acknowledge(true);
  const store = reviewStore();
  const context = store.begin();
  const key = withTransaction(getDb(), () =>
    store.verifyMatch('org/repo#1', store.targets()[0], false, viewer, context, 'later'),
  );
  prStore().fence.accept(context.read, [key]);
  prStore().end(context);
  event('org/repo#1', 'E2');
  assert.equal(store.list(poll).rows[0].collapsed, false);
  assert.equal(acknowledge(false).removed, true);
});

test('unverified identity and removed configuration hide cached review rows', () => {
  observe();
  getDb().prepare('UPDATE sync_state SET viewer_verified = 0').run();
  assert.equal(reviewStore().list(poll).rows.length, 0);
  getDb().prepare('UPDATE sync_state SET viewer_verified = 1').run();
  reviewStore().reconcile({ ...poll, review_requests: { users: [], teams: [] } }, viewer);
  assert.equal(reviewStore().list(poll).rows.length, 0);
});
