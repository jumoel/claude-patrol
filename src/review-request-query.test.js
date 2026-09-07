import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  composeReviewSearch,
  exactReviewer,
  reviewReserve,
  reviewShards,
  reviewTargets,
} from './review-request-query.js';

const viewer = { id: 'U1', login: 'Alice' };

test('viewer literals coalesce and exact teams search only their own scope', () => {
  const poll = {
    orgs: ['acme', 'elsewhere'],
    repos: ['acme/covered', 'other/repo'],
    review_requests: { users: ['@me', 'alice', 'bob'], teams: ['acme/reviewers'] },
  };
  const targets = reviewTargets(poll, viewer);
  assert.equal(targets.length, 3);
  assert.deepEqual(targets.find((target) => target.name === 'alice').configured_values, ['@me', 'alice']);
  const shards = reviewShards(poll, viewer);
  assert.match(shards.find((shard) => shard.target_id === 'user:alice').query, /user-review-requested:@me/);
  assert.match(shards.find((shard) => shard.target_id === 'user:bob').query, /user-review-requested:bob/);
  const team = shards.find((shard) => shard.target_id.startsWith('team:'));
  assert.match(team.query, /org:acme team-review-requested:acme\/reviewers/);
  assert.doesNotMatch(team.query, /elsewhere|other\/repo|covered/);
  assert.ok(shards.every((shard) => !/(?:^| )review-requested:|team-review-requested-user:/.test(shard.query)));
});

test('empty scope and disabled targets issue no search shards', () => {
  assert.deepEqual(reviewShards({ orgs: [], repos: [] }, viewer), []);
  assert.deepEqual(reviewShards({ orgs: ['org'], review_requests: { users: [], teams: [] } }, viewer), []);
});

test('large scopes are sharded, and GraphQL composition uses bounded numeric aliases', () => {
  const shards = reviewShards({ orgs: Array.from({ length: 11 }, (_, i) => `org${i}`), repos: [] }, viewer);
  assert.equal(shards.length, 3);
  assert.ok(shards.every((shard) => (shard.query.match(/org:/g) ?? []).length <= 5));
  const composed = composeReviewSearch(
    'query($q: String!) { search(query: $q, type: ISSUE, first: 50) { issueCount } }',
    { q: 'authored' },
    shards,
  );
  assert.match(composed.query, /review0: search/);
  assert.equal(composed.variables.reviewQ0, shards[0].query);
  assert.doesNotMatch(composed.query, /user-review-requested/);
  assert.throws(() => composeReviewSearch('query($q:String!){x}', {}, Array(33).fill(shards[0])), /bounds/);
});

test('matching reviewers requires the exact requested identity, not team membership', () => {
  assert.equal(
    exactReviewer(
      { __typename: 'Team', slug: 'team', organization: { login: 'acme' } },
      { kind: 'user', name: 'alice' },
    ),
    false,
  );
  assert.equal(
    exactReviewer({ __typename: 'User', id: 'U1', login: 'Alice' }, { kind: 'user', name: 'alice', viewer_id: 'U1' }),
    true,
  );
  assert.equal(
    exactReviewer(
      { __typename: 'Team', slug: 'team', organization: { login: 'acme' } },
      { kind: 'team', name: 'acme/other-team' },
    ),
    false,
  );
});

test('the quota reserve is conservative and missing telemetry is not zero', () => {
  const input = {
    remaining: 5000,
    resetAt: '2026-09-05T22:00:00Z',
    now: Date.parse('2026-09-05T21:00:00Z'),
    interval: 30,
    incrementalCost: 4,
    fullCost: 10,
  };
  assert.equal(reviewReserve(input), Math.ceil(1.25 * (118 * 4 + 3 * 10)) + 10);
  assert.equal(reviewReserve({ ...input, fullCost: null }), null);
  assert.equal(reviewReserve({ ...input, remaining: null }), null);
});
