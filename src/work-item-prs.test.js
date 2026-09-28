import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { ensureSessionAndSend } from './dispatcher.js';
import { markTestPrAuthored } from './test-support/authored-prs.js';
import { insertTestWorkItem } from './test-support/work-items.js';
import {
  getPullRequestOwner,
  linkWorkItemPullRequest,
  listWorkItemPullRequests,
  listWorkItemPullRequestsBatch,
  parsePullRequestReference,
  reconcileWorkItemPullRequests,
  unlinkWorkItemPullRequest,
} from './work-item-prs.js';
import { createWorkspace } from './workspace.js';

afterEach(() => closeDb());

function insertWorkItem(id, repositories, createdAt = '2026-08-20T00:00:00.000Z') {
  insertTestWorkItem(getDb(), { id, repositories, createdAt });
}

function insertPullRequest(id, headOid = null, createdAt = '2026-08-22T00:00:00.000Z') {
  const [repository, numberText] = id.split('#');
  const [org, repo] = repository.split('/');
  const number = Number(numberText);
  getDb()
    .prepare(
      `INSERT INTO prs (
        id, number, title, repo, org, author, url, branch, head_oid,
        created_at, updated_at, synced_at
      ) VALUES (?, ?, ?, ?, ?, 'octocat', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      number,
      `PR ${number}`,
      repo,
      org,
      `https://github.com/${repository}/pull/${number}`,
      `feature-${number}`,
      headOid,
      createdAt,
      createdAt,
      createdAt,
    );
  markTestPrAuthored(getDb(), id);
}

function insertChildWorkspace(id, workItemId, path) {
  const now = '2026-08-21T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO workspaces (
        id, work_item_id, name, path, bookmark, repo, status, created_at,
        operation_state, operation_updated_at, base_commit
      ) VALUES (?, ?, ?, ?, ?, 'acme/widgets', 'active', ?, 'ready', ?, ?)`,
    )
    .run(id, workItemId, id, path, `patrol/${id}`, now, now, 'b'.repeat(64));
}

test('a work item owns multiple pull requests without requiring poller rows', async () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets', 'acme/tools']);
  insertWorkItem('two', ['acme/widgets']);
  insertPullRequest('acme/tools#12');

  assert.deepEqual(parsePullRequestReference('https://github.com/acme/widgets/pull/11?notification_referrer_id=1'), {
    id: 'acme/widgets#11',
    org: 'acme',
    repo: 'widgets',
    repository: 'acme/widgets',
    number: 11,
    url: 'https://github.com/acme/widgets/pull/11',
  });

  const beforePoll = linkWorkItemPullRequest('one', 'acme/widgets#11');
  const tracked = linkWorkItemPullRequest('one', 'https://github.com/acme/tools/pull/12');
  assert.equal(beforePoll.tracked, false);
  assert.equal(beforePoll.github_state, null);
  assert.equal(beforePoll.stack_root, null);
  assert.equal(tracked.tracked, true);
  assert.equal(tracked.stack_root, tracked.id);
  assert.equal(listWorkItemPullRequests('one').length, 2);
  assert.equal(getPullRequestOwner('acme/widgets#11').id, 'one');
  assert.equal(linkWorkItemPullRequest('one', 'acme/widgets#11').id, 'acme/widgets#11');

  assert.throws(
    () => linkWorkItemPullRequest('two', 'acme/widgets#11'),
    (error) => error.code === 'pull_request_owned',
  );
  assert.throws(
    () => linkWorkItemPullRequest('one', 'acme/other#1'),
    (error) => error.code === 'repository_not_in_work_item',
  );
  await assert.rejects(createWorkspace('acme/tools#12', {}), (error) => error.code === 'pr_owned_by_work_item');

  assert.deepEqual(unlinkWorkItemPullRequest('one', 'acme/tools#12'), {
    removed: true,
    pr_id: 'acme/tools#12',
    work_item_id: 'one',
  });
  assert.ok(getDb().prepare("SELECT 1 FROM prs WHERE id = 'acme/tools#12'").get());
});

test('linked PR summaries preserve merged and closed states after authored tracking ends', () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets']);
  for (const [number, state] of [
    [41, 'MERGED'],
    [42, 'CLOSED'],
  ]) {
    const id = `acme/widgets#${number}`;
    insertPullRequest(id);
    linkWorkItemPullRequest('one', id);
    getDb().prepare('UPDATE prs SET github_state = ? WHERE id = ?').run(state, id);
    getDb().prepare('DELETE FROM pr_authored_state WHERE pr_id = ?').run(id);
  }
  const links = listWorkItemPullRequests('one');
  assert.deepEqual(
    links.map((link) => [link.id, link.github_state, link.tracked]),
    [
      ['acme/widgets#41', 'MERGED', true],
      ['acme/widgets#42', 'CLOSED', true],
    ],
  );
  assert.deepEqual(listWorkItemPullRequestsBatch(['one']).get('one'), links);
  assert.equal(getDb().prepare("SELECT state FROM work_items WHERE id = 'one'").get().state, 'ready');
});

test('work item pull requests sort by repository, numeric PR ID, and stack position', () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets', 'acme/tools']);
  for (const id of [
    'acme/widgets#100',
    'acme/widgets#10',
    'acme/widgets#30',
    'acme/tools#12',
    'acme/widgets#2',
    'acme/widgets#20',
  ]) {
    insertPullRequest(id);
    linkWorkItemPullRequest('one', id);
  }
  linkWorkItemPullRequest('one', 'acme/widgets#3');
  getDb().prepare('UPDATE prs SET base_branch = ? WHERE id = ?').run('feature-30', 'acme/widgets#10');

  const expected = [
    'acme/widgets#30',
    'acme/widgets#10',
    'acme/tools#12',
    'acme/widgets#2',
    'acme/widgets#3',
    'acme/widgets#20',
    'acme/widgets#100',
  ];
  const links = listWorkItemPullRequests('one');
  assert.deepEqual(
    links.map((pr) => pr.id),
    expected,
  );
  assert.deepEqual(
    links.filter((pr) => pr.is_stacked).map((pr) => pr.stack_position),
    [1, 2],
  );
  assert.deepEqual(listWorkItemPullRequestsBatch(['one']).get('one'), links);
});

test('declared cross-repository stack order comes before free PRs, including merged members', () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/js', 'acme/mono']);
  for (const id of ['acme/js#1477', 'acme/mono#61314', 'acme/mono#61657', 'acme/js#1470', 'acme/mono#61673']) {
    insertPullRequest(id);
    linkWorkItemPullRequest('one', id);
  }
  const sequence =
    '> 1. acme/js#1470: First change\n> 2. acme/mono#61314: Second change\n> 3. acme/js#1477: Last change';
  for (const [id, position] of [
    ['acme/js#1477', 3],
    ['acme/mono#61314', 2],
    ['acme/js#1470', 1],
  ]) {
    getDb()
      .prepare('UPDATE prs SET body = ? WHERE id = ?')
      .run(`## References\n\n> Part ${position} of 3.\n\n${sequence}`, id);
  }
  getDb().prepare("UPDATE prs SET github_state = 'MERGED' WHERE id = 'acme/js#1470'").run();
  const links = listWorkItemPullRequests('one');
  assert.deepEqual(
    links.map((pr) => pr.id),
    ['acme/js#1470', 'acme/mono#61314', 'acme/js#1477', 'acme/mono#61657', 'acme/mono#61673'],
  );
  assert.deepEqual(
    links.slice(0, 3).map((pr) => [pr.is_stacked, pr.stack_root, pr.stack_position, pr.stack_size]),
    [
      [true, 'acme/js#1470', 1, 3],
      [true, 'acme/js#1470', 2, 3],
      [true, 'acme/js#1470', 3, 3],
    ],
  );
  assert.equal(links[3].is_stacked, false);
  assert.deepEqual(listWorkItemPullRequestsBatch(['one']).get('one'), links);
});

test('part markers order a stack even without a sequence list', () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/js', 'acme/mono']);
  for (const [id, part] of [
    ['acme/js#20', 2],
    ['acme/mono#90', 1],
  ]) {
    insertPullRequest(id);
    linkWorkItemPullRequest('one', id);
    getDb().prepare('UPDATE prs SET body = ? WHERE id = ?').run(`## References\n\n> Part ${part} of 2.`, id);
  }
  assert.deepEqual(
    listWorkItemPullRequests('one').map((pr) => [pr.id, pr.stack_position]),
    [
      ['acme/mono#90', 1],
      ['acme/js#20', 2],
    ],
  );
});

test('a declared child stays after its inferred stack parent', () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/js']);
  for (const id of ['acme/js#30', 'acme/js#10']) {
    insertPullRequest(id);
    linkWorkItemPullRequest('one', id);
  }
  getDb().prepare('UPDATE prs SET base_branch = ? WHERE id = ?').run('feature-30', 'acme/js#10');
  getDb()
    .prepare('UPDATE prs SET body = ? WHERE id = ?')
    .run('> Part 2 of 2.\n\n> 1. #30: Parent\n> 2. #10: Child', 'acme/js#10');
  assert.deepEqual(
    listWorkItemPullRequests('one').map((pr) => pr.id),
    ['acme/js#30', 'acme/js#10'],
  );
});

test('provenance reconciliation links only a unique immutable-history match', async () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets']);
  insertWorkItem('two', ['acme/widgets']);
  insertChildWorkspace('child-one', 'one', '/tmp/one/repos/widgets');
  insertChildWorkspace('child-two', 'two', '/tmp/two/repos/widgets');
  const uniqueOid = '1'.repeat(64);
  const ambiguousOid = '2'.repeat(64);
  insertPullRequest('acme/widgets#21', uniqueOid);
  insertPullRequest('acme/widgets#22', ambiguousOid);
  const warnings = [];

  const linked = await reconcileWorkItemPullRequests(['acme/widgets#21', 'acme/widgets#22'], {
    runExec: async (_command, args) => {
      const oid = args[args.indexOf('-r') + 1].split(' ')[0];
      const path = args[args.indexOf('-R') + 1];
      const matches = oid === uniqueOid ? path.includes('/one/') : oid === ambiguousOid;
      return { stdout: matches ? `${oid}\n` : '' };
    },
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(
    linked.map((pr) => pr.id),
    ['acme/widgets#21'],
  );
  assert.equal(getPullRequestOwner('acme/widgets#21').id, 'one');
  assert.equal(getPullRequestOwner('acme/widgets#22'), null);
  assert.match(warnings[0], /ambiguous/u);
});

test('PR dispatch resolves through the owning work item instead of a standalone workspace', async () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets']);
  insertPullRequest('acme/widgets#31');
  linkWorkItemPullRequest('one', 'acme/widgets#31');
  const now = '2026-08-22T00:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO workspaces (
        id, pr_id, name, path, bookmark, repo, status, created_at,
        operation_state, operation_updated_at
      ) VALUES ('legacy-pr-workspace', 'acme/widgets#31', 'legacy', '/tmp/legacy',
        'feature-31', 'acme/widgets', 'active', ?, 'ready', ?)`,
    )
    .run(now, now);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, pid, provider, status, started_at)
       VALUES ('legacy-session', 'legacy-pr-workspace', 1, 'claude', 'detached', ?)`,
    )
    .run(now);

  await assert.rejects(
    ensureSessionAndSend({ pr_id: 'acme/widgets#31', prompt: 'inspect it' }),
    (error) => error.code === 'no_session',
  );
});

test('provenance reconciliation does not re-run jj for pairs that already failed to match', async () => {
  initDb(':memory:');
  insertWorkItem('one', ['acme/widgets']);
  insertWorkItem('two', ['acme/widgets']);
  insertChildWorkspace('child-one', 'one', '/tmp/one/repos/widgets');
  insertChildWorkspace('child-two', 'two', '/tmp/two/repos/widgets');
  const headOid = '3'.repeat(64);
  insertPullRequest('acme/widgets#23', headOid);
  const missCache = new Map();
  let calls = 0;
  const options = {
    runExec: async () => {
      calls += 1;
      return { stdout: '' };
    },
    logger: { warn() {} },
    missCache,
  };

  assert.deepEqual(await reconcileWorkItemPullRequests(['acme/widgets#23'], options), []);
  assert.equal(calls, 2, 'one jj log per candidate checkout on the first cycle');
  assert.equal(missCache.size, 2);

  assert.deepEqual(await reconcileWorkItemPullRequests(['acme/widgets#23'], options), []);
  assert.equal(calls, 2, 'no jj log for pairs already known not to match');

  // A new head on the PR is a new question.
  getDb().prepare('UPDATE prs SET head_oid = ? WHERE id = ?').run('4'.repeat(64), 'acme/widgets#23');
  await reconcileWorkItemPullRequests(['acme/widgets#23'], options);
  assert.equal(calls, 4);
});
