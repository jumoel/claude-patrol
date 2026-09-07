import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { closeDb, getDb, initDb, withTransaction } from './db.js';
import { githubClient } from './github-client.js';
import { prStore } from './pr-store.js';
import { reviewStore } from './review-request-store.js';
import { registerReviewRequestRoutes } from './routes/review-requests.js';

const poll = { orgs: ['org'], repos: [], interval_seconds: 60 };
const viewer = { id: 'u1', login: 'alice' };
let app;
beforeEach(async () => {
  initDb(':memory:');
  const db = getDb();
  db.prepare('UPDATE sync_state SET viewer_id = ?, viewer_login = ?, viewer_verified = 1').run(viewer.id, viewer.login);
  githubClient().configure(poll);
  const store = reviewStore();
  let context = store.begin();
  const now = new Date().toISOString();
  const node = {
    id: 'PR_1',
    number: 1,
    state: 'OPEN',
    title: 'Review this',
    body: '',
    headRefName: 'feature',
    headRefOid: 'a'.repeat(40),
    baseRefName: 'main',
    url: 'https://github.com/org/repo/pull/1',
    author: { login: 'bob' },
    repository: { name: 'repo', owner: { login: 'org' } },
    createdAt: now,
    updatedAt: now,
  };
  withTransaction(db, () => {
    const pr = prStore().write(prStore().prepare(node, 'body', context));
    store.discover(pr.id, store.targets()[0], viewer, context, now);
  });
  prStore().end(context);
  context = store.begin();
  withTransaction(db, () =>
    store.verifyEvent('org/repo#1', store.targets()[0], { id: 'E1', createdAt: now }, now, context, now),
  );
  prStore().end(context);
  app = Fastify();
  app.decorate('appContext', { getDb, getConfig: () => ({ poll }) });
  registerReviewRequestRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  closeDb();
});

test('encoded PR IDs, local pagination, versioned acknowledgement and no-op retry share the API envelope', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/review-requests?limit=1' });
  assert.equal(response.statusCode, 200);
  const row = response.json().rows[0];
  const url = '/api/review-requests/org%2Frepo%231/acknowledgement';
  const collapsed = await app.inject({
    method: 'POST',
    url,
    payload: { expected_version: row.state_version, collapsed: true },
  });
  assert.equal(collapsed.statusCode, 200);
  assert.equal(collapsed.json().row.collapsed, true);
  const stale = await app.inject({
    method: 'POST',
    url,
    payload: { expected_version: row.state_version, collapsed: false },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'invalid_state');
  assert.equal(JSON.parse(stale.json().error.detail).row.collapsed, true);
  const retry = await app.inject({
    method: 'POST',
    url,
    payload: { expected_version: collapsed.json().row.state_version, collapsed: true },
  });
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().row.state_version, collapsed.json().row.state_version);
  assert.equal(githubClient().budget().attempts, 0);
});

test('invalid query/body input cannot expand target scope or launch GitHub work', async () => {
  for (const request of [
    { method: 'GET', url: '/api/review-requests?limit=101' },
    { method: 'GET', url: '/api/review-requests?team=outside/team' },
    {
      method: 'POST',
      url: '/api/review-requests/org%2Frepo%231/acknowledgement',
      payload: { expected_version: 'v', collapsed: true, targets: ['user:someone'] },
    },
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_request');
  }
  assert.equal(githubClient().budget().attempts, 0);
});
