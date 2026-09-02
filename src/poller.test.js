import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { pollerEvents, pollOnce, resetSweepCursors } from './poller.js';

const NOW = '2026-08-27T12:00:00.000Z';
const config = { poll: { orgs: ['acme'], repos: ['other/thing'], interval_seconds: 30 } };

function insertPr(id, org, repo) {
  getDb()
    .prepare(
      `INSERT INTO prs (id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, 'octocat', ?, 'feature', ?, ?, ?)`,
    )
    .run(id, Number(id.split('#').at(-1)), `PR ${id}`, repo, org, `https://example.test/${id}`, NOW, NOW, NOW);
}

function insertWorkspace(id, prId) {
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, pr_id, name, path, bookmark, status, created_at, operation_state)
       VALUES (?, ?, ?, ?, 'feature', 'active', ?, 'ready')`,
    )
    .run(id, prId, id, `/tmp/${id}`, NOW);
}

function setPersistedCursors(lastSweepAt, lastFullSweepAt) {
  getDb()
    .prepare('UPDATE sync_state SET last_sweep_at = ?, last_full_sweep_at = ? WHERE id = 1')
    .run(lastSweepAt, lastFullSweepAt);
}

function page(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return { data: { search: { pageInfo: { hasNextPage, endCursor }, nodes } } };
}

function idNode(org, repo, number) {
  return { number, repository: { name: repo, owner: { login: org } } };
}

function prNode(org, repo, number) {
  return {
    id: `node-${number}`,
    number,
    title: `PR ${number}`,
    body: '',
    url: `https://example.test/${org}/${repo}#${number}`,
    isDraft: false,
    headRefName: 'feature',
    headRefOid: 'abc',
    baseRefName: 'main',
    isCrossRepository: false,
    mergeable: 'MERGEABLE',
    createdAt: NOW,
    updatedAt: NOW,
    author: { login: 'octocat' },
    repository: { name: repo, owner: { login: org } },
    labels: { nodes: [] },
    reviews: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
  };
}

const isHeavy = (variables) => variables.q.includes('sort:updated-desc');

function fakeGraphql(handler) {
  const calls = [];
  const graphql = async (_query, variables) => {
    calls.push(variables);
    return handler(variables);
  };
  graphql.calls = calls;
  return graphql;
}

function deps(graphql, destroyed = []) {
  return {
    graphql,
    destroyWorkspace: async (id) => {
      destroyed.push(id);
      return { ok: true, warnings: [] };
    },
    reconcileWorkItemPullRequests: async () => [],
  };
}

function prIds() {
  return getDb()
    .prepare('SELECT id FROM prs ORDER BY id')
    .all()
    .map((row) => row.id);
}

const recentMinutesAgo = (minutes) => new Date(Date.parse(NOW_REAL) - minutes * 60_000).toISOString();
const NOW_REAL = new Date().toISOString();

beforeEach(() => {
  initDb(':memory:');
  resetSweepCursors({ hydrateFromDb: true });
  insertPr('acme/widgets#1', 'acme', 'widgets');
  insertPr('acme/widgets#2', 'acme', 'widgets');
  insertPr('other/thing#7', 'other', 'thing');
  insertWorkspace('ws-2', 'acme/widgets#2');
});

afterEach(() => closeDb());

test('an incremental cycle removes PRs missing from the complete open set and destroys their workspaces', async () => {
  setPersistedCursors(recentMinutesAgo(5), recentMinutesAgo(5));
  const destroyed = [];
  const graphql = fakeGraphql((variables) =>
    isHeavy(variables) ? page([]) : page([idNode('acme', 'widgets', 1), idNode('other', 'thing', 7)]),
  );
  const syncs = [];
  const onSync = (event) => syncs.push(event);
  pollerEvents.on('sync', onSync);
  try {
    await pollOnce(config, { deps: deps(graphql, destroyed) });
  } finally {
    pollerEvents.off('sync', onSync);
  }

  assert.deepEqual(prIds(), ['acme/widgets#1', 'other/thing#7']);
  assert.deepEqual(destroyed, ['ws-2']);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 0);
  assert.equal(graphql.calls.filter(isHeavy).length, 1);
  assert.equal(graphql.calls.filter((v) => !isHeavy(v)).length, 1);
  assert.match(graphql.calls.find(isHeavy).q, /updated:>=/);
  assert.equal(syncs.length, 1);
});

test('a search response without data.search fails the cycle and deletes nothing', async () => {
  setPersistedCursors(recentMinutesAgo(5), recentMinutesAgo(5));
  const destroyed = [];
  const graphql = fakeGraphql((variables) =>
    isHeavy(variables) ? page([]) : { data: null, errors: [{ message: 'Something went wrong' }] },
  );

  await assert.rejects(pollOnce(config, { deps: deps(graphql, destroyed) }), /GitHub refresh failed.*no search result/);

  assert.deepEqual(prIds(), ['acme/widgets#1', 'acme/widgets#2', 'other/thing#7']);
  assert.deepEqual(destroyed, []);
});

test('a bad page in the middle of the open-set enumeration is a failure, not a shorter set', async () => {
  setPersistedCursors(recentMinutesAgo(5), recentMinutesAgo(5));
  const destroyed = [];
  const graphql = fakeGraphql((variables) => {
    if (isHeavy(variables)) return page([]);
    if (!variables.cursor) return page([idNode('acme', 'widgets', 1)], { hasNextPage: true, endCursor: 'c1' });
    return { data: { search: null } };
  });

  await assert.rejects(pollOnce(config, { deps: deps(graphql, destroyed) }), /GitHub refresh failed/);

  assert.deepEqual(prIds(), ['acme/widgets#1', 'acme/widgets#2', 'other/thing#7']);
  assert.deepEqual(destroyed, []);
});

test('the first cycle without persisted cursors is a full sweep and later cycles are incremental', async () => {
  const graphql = fakeGraphql((variables) =>
    isHeavy(variables) ? page([prNode('acme', 'widgets', 1), prNode('other', 'thing', 7)]) : page([]),
  );

  await pollOnce(config, { deps: deps(graphql) });
  assert.equal(graphql.calls.length, 1, 'a full sweep does not need the id-only enumeration');
  assert.doesNotMatch(graphql.calls[0].q, /updated:>=/);
  assert.deepEqual(prIds(), ['acme/widgets#1', 'other/thing#7']);

  const persisted = getDb().prepare('SELECT last_sweep_at, last_full_sweep_at FROM sync_state WHERE id = 1').get();
  assert.ok(persisted.last_sweep_at, 'recordSync persists the sweep cursor');
  assert.equal(persisted.last_full_sweep_at, persisted.last_sweep_at);

  await pollOnce(config, { deps: deps(graphql) });
  assert.equal(graphql.calls.length, 3, 'an incremental cycle runs the heavy and the id-only query');
  assert.match(graphql.calls.find((v, i) => i > 0 && isHeavy(v)).q, /updated:>=/);
});

test('a fresh process resumes incremental polling from the persisted cursors', async () => {
  setPersistedCursors(recentMinutesAgo(3), recentMinutesAgo(10));
  const graphql = fakeGraphql((variables) =>
    isHeavy(variables)
      ? page([])
      : page([idNode('acme', 'widgets', 1), idNode('acme', 'widgets', 2), idNode('other', 'thing', 7)]),
  );

  await pollOnce(config, { deps: deps(graphql) });

  assert.equal(graphql.calls.length, 2);
  assert.match(graphql.calls.find(isHeavy).q, /updated:>=/);
  assert.deepEqual(prIds(), ['acme/widgets#1', 'acme/widgets#2', 'other/thing#7']);
});
