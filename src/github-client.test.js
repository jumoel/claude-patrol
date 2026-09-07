import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { githubClient } from './github-client.js';

const poll = {
  orgs: ['org'],
  repos: [],
  interval_seconds: 60,
  review_requests: { users: ['@me', 'alice'], teams: [] },
};
const alice = { id: 'u1', login: 'alice' };
const bob = { id: 'u2', login: 'bob' };
const response = (viewer, remaining = 4900) => ({
  data: {
    viewer,
    rateLimit: {
      cost: 3,
      remaining,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  },
});
beforeEach(() => initDb(':memory:'));
afterEach(closeDb);

test('optional requests cannot spend unknown quota or the authored reserve', async () => {
  const client = githubClient();
  client.configure(poll);
  let calls = 0;
  const run = async () => {
    calls++;
    return response(alice);
  };
  await assert.rejects(client.request('query {}', {}, { optional: true, run }), { code: 'review_verification_failed' });
  assert.equal(calls, 0);
  assert.equal(client.diagnostics().attempts, 0);
  await client.request('query {}', {}, { run });
  client.budget().cycle(true, 3);
  assert.equal(client.budget().admits(60, 1), true);
  await client.request(
    'query {}',
    {},
    {
      optional: true,
      run: async () => {
        calls++;
        return response(alice, 1);
      },
    },
  );
  const attempts = client.diagnostics().attempts;
  await assert.rejects(client.request('query {}', {}, { optional: true, run }), { code: 'review_verification_failed' });
  assert.equal(calls, 2);
  assert.equal(client.diagnostics().attempts, attempts);
});

test('first successful operation establishes identity without an extra identity request', async () => {
  const client = githubClient();
  client.configure(poll);
  let calls = 0;
  await client.request(
    'query {}',
    {},
    {
      run: async () => {
        calls++;
        return response(alice);
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(client.identity().id, alice.id);
  assert.equal(client.identity().verified, 1);
  assert.deepEqual(
    getDb()
      .prepare('SELECT id FROM review_watch_targets')
      .all()
      .map((row) => row.id),
    ['user:alice'],
  );
});

test('a late response cannot change identity or quota after a config edit', async () => {
  const client = githubClient();
  client.configure(poll);
  let finish;
  const pending = client.request(
    'query {}',
    {},
    {
      run: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    },
  );
  client.configure({ ...poll, review_requests: { users: ['bob'], teams: [] } });
  finish(response(alice));
  await assert.rejects(pending, { kind: 'obsolete' });
  assert.equal(client.identity(), null);
  assert.equal(client.budget().remaining, null);
});

test('account changes retire @me but keep an explicit old login literal and reset coverage', async () => {
  const client = githubClient();
  client.configure(poll);
  await client.request('query {}', {}, { run: async () => response(alice) });
  getDb().prepare("UPDATE sync_state SET last_sweep_at = 'old', last_full_sweep_at = 'old'").run();
  const old = client.capture();
  await assert.rejects(client.request('query {}', {}, { run: async () => response(bob) }), {
    kind: 'identity_changed',
  });
  assert.throws(() => old.assertCurrent(alice), { kind: 'obsolete' });
  assert.equal(client.identity().id, bob.id);
  assert.equal(client.identity().verified, 0);
  assert.equal(client.budget().remaining, null);
  assert.equal(getDb().prepare('SELECT last_sweep_at FROM sync_state').get().last_sweep_at, null);
  const targets = getDb().prepare('SELECT id, configured_values FROM review_watch_targets ORDER BY id').all();
  assert.deepEqual(
    targets.map((row) => [row.id, JSON.parse(row.configured_values)]),
    [
      ['user:alice', ['alice']],
      ['user:bob', ['@me']],
    ],
  );
  await client.request('query {}', {}, { run: async () => response(bob) });
  assert.equal(client.identity().verified, 1);
});

test('review-only edits preserve authored coverage and measured cycle maxima', async () => {
  const client = githubClient();
  client.configure(poll);
  await client.request('query {}', {}, { run: async () => response(alice) });
  client.budget().cycle(true, 3);
  getDb().prepare("UPDATE sync_state SET last_sweep_at = 'saved', last_full_sweep_at = 'saved'").run();
  assert.equal(client.configure({ ...poll, review_requests: { users: [], teams: [] } }).scopeChanged, false);
  assert.equal(client.budget().fullCost, 3);
  assert.equal(getDb().prepare('SELECT last_sweep_at FROM sync_state').get().last_sweep_at, 'saved');
});
