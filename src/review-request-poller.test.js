import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { githubClient } from './github-client.js';
import { createReviewPoller, fairReviewQueue } from './review-request-poller.js';
import { reviewRequestService } from './review-request-service.js';
import { reviewStore } from './review-request-store.js';

const viewer = { id: 'u1', login: 'alice' };
const poll = { orgs: ['org'], repos: [], interval_seconds: 60, review_requests: { users: ['@me', 'bob'], teams: [] } };
const node = (number = 1) => ({
  id: `PR_${number}`,
  number,
  title: `PR ${number}`,
  body: 'description',
  state: 'OPEN',
  repository: { name: 'repo', owner: { login: 'org' } },
  author: { login: 'carol' },
  url: `https://github.com/org/repo/pull/${number}`,
  headRefName: 'branch',
  headRefOid: 'abc',
  baseRefName: 'main',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
});
const page = (nodes) => ({ nodes, issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } });
const event = (id, login, createdAt = '2026-09-01T00:00:00Z') => ({
  id,
  createdAt,
  requestedReviewer: { __typename: 'User', id: login === 'alice' ? 'u1' : 'u2', login },
});
let service;
beforeEach(() => {
  initDb(':memory:');
  getDb()
    .prepare('UPDATE sync_state SET viewer_id = ?, viewer_login = ?, viewer_verified = 1')
    .run(viewer.id, viewer.login);
  reviewStore().reconcile(poll, viewer);
  service = createReviewPoller({ db: getDb(), poll, viewer, assertCurrent: () => {} });
});
afterEach(closeDb);

function discover(nodes = [node()]) {
  const context = service.begin();
  try {
    service.settleSearch({ data: { review0: page(nodes), review1: page(nodes) } }, service.firstPages(), context);
  } finally {
    service.end(context);
  }
}

test('failed event probes advance independently of successful reviewer confirmations', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-07T10:00:00Z') });
  const nodes = Array.from({ length: 30 }, (_, index) => node(index + 1));
  discover(nodes);
  const seen = new Set();
  for (let cycle = 0; cycle < 5; cycle++) {
    t.mock.timers.tick(60_000);
    await service.verify(async (_query, variables) => {
      const probes = Object.entries(variables).filter(([name]) => name.startsWith('probeId'));
      for (const [, id] of probes) seen.add(id);
      return {
        data: {
          confirm: nodes.map((value) => ({
            ...value,
            reviewRequests: {
              nodes: [event('E', 'alice'), event('E2', 'bob')],
              pageInfo: { hasNextPage: false },
            },
          })),
        },
        errors: probes.map((_, index) => ({ message: 'Probe unavailable', path: [`probe${index}`] })),
      };
    });
  }
  assert.equal(seen.size, 30);
});

test('interactive collapse preserves state and makes no request when quota is unknown', async () => {
  const client = githubClient();
  client.configure(poll);
  discover();
  const row = reviewStore().list(poll).rows[0];
  await assert.rejects(reviewRequestService().acknowledge(poll, row.id, row.state_version, true), {
    code: 'review_verification_failed',
  });
  assert.equal(client.diagnostics().attempts, 0);
  assert.equal(reviewStore().list(poll).rows[0].collapsed, false);
});

test('interactive verification rechecks admission between event pages', async () => {
  const client = githubClient();
  client.configure(poll);
  const resetAt = new Date(Date.now() + 3600_000).toISOString();
  await client.request(
    'query {}',
    {},
    {
      run: async () => ({
        data: {
          viewer,
          rateLimit: { cost: 1, remaining: 4900, resetAt },
        },
      }),
    },
  );
  client.budget().cycle(true, 3);
  discover();
  const row = reviewStore().list(poll).rows[0];
  const request = client.request;
  let calls = 0;
  client.request = (query, variables, options) =>
    request(query, variables, {
      ...options,
      run: async () => {
        calls++;
        return {
          data: {
            viewer,
            rateLimit: { cost: 1, remaining: 1, resetAt },
            probe0: {
              ...node(),
              timelineItems: { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: 'older' } },
            },
          },
        };
      },
    });
  try {
    await assert.rejects(reviewRequestService().acknowledge(poll, row.id, row.state_version, true), {
      code: 'review_verification_failed',
    });
    assert.equal(calls, 1);
    assert.equal(reviewStore().list(poll).rows[0].collapsed, false);
  } finally {
    client.request = request;
  }
});

test('successful alias commits while a sibling fails; named-user hints stay hidden', () => {
  const scopes = service.firstPages().sort((a, b) => a.target_id.localeCompare(b.target_id));
  const context = service.begin();
  service.settleSearch(
    { data: { review0: page([node()]) }, errors: [{ path: ['review1'], message: 'failed' }] },
    scopes,
    context,
  );
  service.end(context);
  const list = reviewStore().list(poll);
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].targets.length, 1);
  assert.equal(list.source.errors.length, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM pr_authored_state').get().n, 0);
});

test('refreshing a first page does not discard persisted overflow progress', () => {
  const scope = service.firstPages()[0];
  getDb().prepare('UPDATE review_watch_scopes SET cursor = ? WHERE id = ?').run('page-five', scope.id);
  const selected = service.firstPages().find((value) => value.id === scope.id);
  const context = service.begin();
  service.settleSearch(
    {
      data: {
        review0: {
          nodes: [],
          issueCount: 500,
          pageInfo: { hasNextPage: true, endCursor: 'page-one' },
        },
      },
    },
    [selected],
    context,
  );
  service.end(context);
  assert.equal(
    getDb().prepare('SELECT cursor FROM review_watch_scopes WHERE id = ?').get(scope.id).cursor,
    'page-five',
  );
});

test('named-user confirmation requires an exact match and complete absence before removal', () => {
  discover();
  assert.equal(reviewStore().list(poll).rows[0].targets.length, 1);
  let context = service.begin();
  service.settleConfirmations(
    {
      data: {
        confirm: [
          {
            ...node(),
            reviewRequests: {
              nodes: [{ requestedReviewer: event('e', 'bob').requestedReviewer }],
              pageInfo: { hasNextPage: true },
            },
          },
        ],
      },
    },
    context,
  );
  service.end(context);
  assert.equal(reviewStore().list(poll).rows[0].targets.length, 2);
  context = service.begin();
  service.settleConfirmations(
    {
      data: {
        confirm: [
          {
            ...node(),
            reviewRequests: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        ],
      },
    },
    context,
  );
  service.end(context);
  assert.equal(reviewStore().list(poll).rows.length, 0);
});

test('backwards event scan persists resolved targets and never replaces their newest event', () => {
  discover();
  const selected = service.probes()[0];
  let context = service.begin();
  service.settleProbe(
    {
      ...node(),
      timelineItems: {
        nodes: [event('alice-new', 'alice')],
        pageInfo: { hasPreviousPage: true, startCursor: 'older' },
      },
    },
    selected,
    context,
  );
  service.end(context);
  assert.equal(getDb().prepare('SELECT cursor FROM pr_review_probe_state').get().cursor, 'older');
  const next = service.probes()[0];
  context = service.begin();
  service.settleProbe(
    {
      ...node(),
      timelineItems: {
        nodes: [event('alice-old', 'alice'), event('bob-new', 'bob')],
        pageInfo: { hasPreviousPage: false, startCursor: null },
      },
    },
    next,
    context,
  );
  service.end(context);
  const states = getDb().prepare('SELECT target_id, event_id FROM pr_review_request_state ORDER BY target_id').all();
  assert.deepEqual(
    states.map((row) => row.event_id),
    ['alice-new', 'bob-new'],
  );
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM pr_review_probe_state').get().n, 0);
});

test('missing event produces an explicit verification failure, not a token', () => {
  discover();
  const selected = service.probes()[0];
  const context = service.begin();
  service.settleProbe(
    { ...node(), timelineItems: { nodes: [], pageInfo: { hasPreviousPage: false } } },
    selected,
    context,
  );
  service.end(context);
  const row = getDb().prepare('SELECT * FROM pr_review_request_state LIMIT 1').get();
  assert.equal(row.event_id, null);
  assert.equal(row.verification_status, 'error');
});

test('reserved queues progress even when discoveries outnumber capacity', () => {
  const fresh = Array.from({ length: 100 }, (_, i) => ({ id: `fresh${i}` }));
  const pending = Array.from({ length: 20 }, (_, i) => ({ id: `pending${i}`, last_attempt_at: 'yesterday' }));
  const chosen = fairReviewQueue([fresh, pending], [10, 10], 20);
  assert.equal(chosen.filter((row) => row.id.startsWith('pending')).length, 10);
  assert.equal(new Set(chosen.map((row) => row.id)).size, 20);
});

test('a body edit discovered by a probe reopens an acknowledged row and completes verification', () => {
  discover();
  let context = service.begin();
  service.settleProbe(
    {
      ...node(),
      timelineItems: {
        nodes: [event('e1', 'alice'), event('e2', 'bob')],
        pageInfo: { hasPreviousPage: false },
      },
    },
    service.probes()[0],
    context,
  );
  service.end(context);
  const store = reviewStore();
  let row = store.rows(['org/repo#1'], poll)[0];
  context = store.begin();
  store.acknowledge(poll, row.id, row.state_version, true, context);
  service.end(context);
  context = service.begin();
  service.settleProbe(
    {
      ...node(),
      body: 'edited',
      updatedAt: '2026-09-02T00:00:00Z',
      timelineItems: {
        nodes: [event('e3', 'alice'), event('e2', 'bob')],
        pageInfo: { hasPreviousPage: false },
      },
    },
    service.probes(true)[0],
    context,
  );
  service.end(context);
  row = store.rows(['org/repo#1'], poll)[0];
  assert.equal(row.collapsed, false);
  assert.equal(row.verification_pending, false);
});
