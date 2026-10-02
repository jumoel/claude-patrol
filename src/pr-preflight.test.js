import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { githubClient } from './github-client.js';
import { githubPullRequestReference, preflightPullRequest, resolvePullRequest } from './pr-preflight.js';

const config = { poll: { orgs: ['acme'], repos: [] } };
const url = 'https://github.com/acme/alpha/pull/42';
const head = 'a'.repeat(40);
const node = (patch = {}) => ({
  id: 'PR_42',
  number: 42,
  title: 'Repair release',
  state: 'OPEN',
  url,
  repository: { name: 'alpha', owner: { login: 'acme' } },
  author: { login: 'octocat' },
  headRefName: 'repair',
  headRefOid: head,
  baseRefName: 'main',
  isDraft: false,
  isCrossRepository: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  ...patch,
});

beforeEach(() => initDb(':memory:'));
afterEach(closeDb);

function response(pr) {
  return { data: { repository: { pullRequest: pr } }, errors: [] };
}

test('recognizes GitHub PR URLs with tabs, fragments, query parameters and surrounding whitespace', () => {
  for (const reference of [url, ` ${url} `, `${url}/files`, `${url}?diff=split#discussion_r123`]) {
    assert.equal(githubPullRequestReference(reference)?.id, 'acme/alpha#42');
  }
  for (const reference of [
    'ECO-4448',
    'acme/alpha#42',
    'https://linear.app/acme/issue/ECO-4448',
    'https://github.com/acme/alpha/issues/42',
    'https://github.com.evil.test/acme/alpha/pull/42',
    'https://user:password@github.com/acme/alpha/pull/42',
    'http://github.com/acme/alpha/pull/42',
  ])
    assert.equal(githubPullRequestReference(reference), null);
});

test('resolves an uncached PR through GitHub and pins the returned head without authored membership', async (t) => {
  t.mock.method(githubClient(), 'request', async (_query, variables) => {
    assert.deepEqual(variables, { owner: 'acme', repo: 'alpha', number: 42 });
    return response(node());
  });
  const pr = await resolvePullRequest(url, config);
  assert.equal(pr.head_oid, head);
  assert.equal(pr.id, 'acme/alpha#42');
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM authored_prs').get().n, 0);
});

test('URL resolution rejects missing, closed and merged PRs and invalid head commits', async (t) => {
  for (const pr of [null, node({ state: 'CLOSED' }), node({ state: 'MERGED' }), node({ headRefOid: 'bad' })]) {
    const mock = t.mock.method(githubClient(), 'request', async () => response(pr));
    await assert.rejects(() => resolvePullRequest(url, config));
    mock.mock.restore();
  }
});

test('GitHub errors propagate without inventing PR data', async (t) => {
  t.mock.method(githubClient(), 'request', async () => {
    throw new Error('GitHub unavailable');
  });
  await assert.rejects(() => resolvePullRequest(url, config), /GitHub unavailable/);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM prs').get().n, 0);
});

test('displayed-head preflight still rejects a GitHub head change', async (t) => {
  const mock = t.mock.method(githubClient(), 'request', async () => response(node()));
  const pr = await resolvePullRequest(url, config);
  mock.mock.restore();
  t.mock.method(githubClient(), 'request', async () => response(node({ headRefOid: 'b'.repeat(40) })));
  await assert.rejects(() => preflightPullRequest(pr.id, head, config), { code: 'invalid_state' });
});
