import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { insertTestWorkItem } from './test-support/work-items.js';
import { execFile } from './utils.js';
import { createPullRequestChild, createWorkItemChild, destroyWorkItemChild } from './workspace.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSource(path) {
  mkdirSync(path, { recursive: true });
  execFileSync('jj', ['git', 'init', '--colocate', path], { stdio: 'ignore' });
}

test('PR preparation checks out the immutable commit without snapshotting a dirty source and cleans refs', async () => {
  initDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'patrol-pr-exact-'));
  temporaryDirectories.push(root);
  const source = join(root, 'sources', 'acme', 'app');
  createSource(source);
  writeFileSync(join(source, 'content.txt'), 'reviewed content\n');
  execFileSync('jj', ['describe', '-m', 'Test commit', '-R', source], { stdio: 'ignore' });
  const head = execFileSync('jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id', '-R', source], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(join(source, 'content.txt'), 'unsnapshotted local edit\n');
  const before = execFileSync(
    'jj',
    ['log', '-r', '@', '--no-graph', '-T', 'commit_id', '--ignore-working-copy', '-R', source],
    { encoding: 'utf8' },
  ).trim();
  const config = {
    work_dir: join(root, 'sources'),
    workspace_base_path: join(root, 'workspaces'),
    repos: {},
    symlink_memory: false,
  };
  insertTestWorkItem(getDb(), { id: 'exact-item', repositories: ['acme/app'], state: 'preparing' });
  const child = join(root, 'workspaces', 'child');
  const result = await createPullRequestChild({
    id: 'exact-child',
    workItemId: 'exact-item',
    repo: 'acme/app',
    name: 'exact-child',
    workspacePath: child,
    bookmark: 'patrol/exact-item',
    config,
    startRevision: head,
    sourcePrNumber: 42,
  });
  assert.equal(result.base_commit, head);
  assert.equal(readFileSync(join(child, 'content.txt'), 'utf8'), 'reviewed content\n');
  assert.equal(readFileSync(join(source, 'content.txt'), 'utf8'), 'unsnapshotted local edit\n');
  assert.equal(
    execFileSync('jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id', '--ignore-working-copy', '-R', source], {
      encoding: 'utf8',
    }).trim(),
    before,
  );
  assert.equal(
    execFileSync('git', ['-C', source, 'for-each-ref', '--format=%(refname)', 'refs/heads/patrol-pr-'], {
      encoding: 'utf8',
    }).trim(),
    '',
  );
  assert.equal(
    execFileSync('jj', ['bookmark', 'list', 'glob:patrol-pr-*', '--ignore-working-copy', '-R', source], {
      encoding: 'utf8',
    }).trim(),
    '',
  );
});

test('PR preparation fetches the canonical pull ref into a non-colocated source and rejects head drift', async () => {
  initDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'patrol-pr-fetch-'));
  temporaryDirectories.push(root);
  const remote = join(root, 'remote');
  createSource(remote);
  writeFileSync(join(remote, 'review.txt'), 'remote PR content\n');
  execFileSync('jj', ['describe', '-m', 'Remote fixture', '-R', remote], { stdio: 'ignore' });
  const head = execFileSync('jj', ['log', '-r', '@', '--no-graph', '-T', 'commit_id', '-R', remote], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', ['-C', remote, 'update-ref', 'refs/pull/42/head', head]);
  const config = {
    work_dir: join(root, 'sources'),
    workspace_base_path: join(root, 'workspaces'),
    repos: {},
    symlink_memory: false,
  };
  const calls = [];
  const runExec = async (command, args, options) => {
    calls.push([command, ...args]);
    if (command === 'gh' && args[0] === 'config') return { stdout: 'https\n' };
    if (command === 'gh' && args[0] === 'api')
      return { stdout: JSON.stringify({ clone_url: 'https://github.com/acme/canonical.git' }) };
    if (command === 'git' && args.includes('fetch')) {
      assert.ok(args.includes('https://github.com/acme/canonical.git'));
      return execFile(
        command,
        args.map((value) => (value === 'https://github.com/acme/canonical.git' ? remote : value)),
        options,
      );
    }
    return execFile(command, args, options);
  };
  for (const [name, expected] of [
    ['success', head],
    ['mismatch', 'f'.repeat(40)],
  ]) {
    const repo = `acme/${name}`;
    const source = join(config.work_dir, repo);
    mkdirSync(source, { recursive: true });
    execFileSync('jj', ['git', 'init', source], { stdio: 'ignore' });
    execFileSync('jj', [
      'git',
      'remote',
      'add',
      'origin',
      '/not-the-base-repository',
      '--ignore-working-copy',
      '-R',
      source,
    ]);
    insertTestWorkItem(getDb(), { id: name, repositories: [repo], state: 'preparing' });
    const input = {
      id: `child-${name}`,
      workItemId: name,
      repo,
      name: `child-${name}`,
      workspacePath: join(config.workspace_base_path, name),
      bookmark: `patrol/${name}`,
      config,
      startRevision: expected,
      sourcePrNumber: 42,
    };
    if (name === 'success') {
      const result = await createPullRequestChild(input, { runExec });
      assert.equal(result.base_commit, head);
      assert.equal(readFileSync(join(input.workspacePath, 'review.txt'), 'utf8'), 'remote PR content\n');
    } else {
      await assert.rejects(createPullRequestChild(input, { runExec }), (error) => error.code === 'invalid_state');
      assert.equal(existsSync(input.workspacePath), false);
    }
    assert.equal(
      execFileSync('jj', ['bookmark', 'list', 'glob:patrol-pr-*', '--ignore-working-copy', '-R', source], {
        encoding: 'utf8',
      }).trim(),
      '',
    );
  }
  assert.equal(calls.filter(([command, ...args]) => command === 'git' && args.includes('fetch')).length, 2);
});

test('work-item children are independent jj workspaces under one non-repository parent', async () => {
  initDb(':memory:');
  const root = mkdtempSync(join(tmpdir(), 'patrol-work-item-workspaces-'));
  temporaryDirectories.push(root);
  const workDir = join(root, 'sources');
  const parent = join(root, 'work-items', 'item-1');
  const alphaSource = join(workDir, 'acme', 'alpha');
  const betaSource = join(workDir, 'acme', 'beta');
  createSource(alphaSource);
  createSource(betaSource);
  const now = new Date().toISOString();
  const bookmark = 'patrol/work-item-item1';
  insertTestWorkItem(getDb(), {
    id: 'item-1',
    repositories: ['acme/alpha', 'acme/beta'],
    path: parent,
    bookmark,
    state: 'preparing',
    stage: 'child_creation',
    progressTotal: 2,
    createdAt: now,
  });
  const config = {
    work_dir: workDir,
    workspace_base_path: join(root, 'workspaces'),
    symlink_memory: false,
    repos: {
      'acme/alpha': { defaultRevision: '@' },
      'acme/beta': { defaultRevision: '@' },
    },
  };
  const children = [
    { id: 'child-alpha', repo: 'acme/alpha', name: 'item-alpha', path: join(parent, 'repos', 'alpha') },
    { id: 'child-beta', repo: 'acme/beta', name: 'item-beta', path: join(parent, 'repos', 'beta') },
  ];

  for (const child of children) {
    await createWorkItemChild({
      id: child.id,
      workItemId: 'item-1',
      repo: child.repo,
      name: child.name,
      workspacePath: child.path,
      bookmark,
      config,
    });
  }

  assert.equal(existsSync(join(parent, '.jj')), false);
  assert.equal(existsSync(join(children[0].path, '.jj')), true);
  assert.equal(existsSync(join(children[1].path, '.jj')), true);
  assert.match(execFileSync('jj', ['workspace', 'list', '-R', alphaSource], { encoding: 'utf8' }), /item-alpha/);
  assert.match(execFileSync('jj', ['workspace', 'list', '-R', betaSource], { encoding: 'utf8' }), /item-beta/);
  assert.match(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', alphaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
  assert.match(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', betaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
  assert.deepEqual(
    getDb()
      .prepare('SELECT repo, operation_state FROM workspaces ORDER BY repo')
      .all()
      .map((row) => ({ ...row })),
    [
      { repo: 'acme/alpha', operation_state: 'ready' },
      { repo: 'acme/beta', operation_state: 'ready' },
    ],
  );
  assert.deepEqual(getDb().prepare('SELECT * FROM workspace_claims').all(), []);

  await assert.rejects(
    destroyWorkItemChild(children[0].id, config, {
      deleteBookmark: false,
      runExec: async (command, args, options) => {
        if (command === 'jj' && args[0] === 'workspace' && args[1] === 'forget') {
          const error = new Error('injected forget failure');
          error.code = 'injected_failure';
          throw error;
        }
        return execFile(command, args, options);
      },
    }),
    (error) => error.code === 'workspace_forget_failed',
  );
  assert.equal(existsSync(children[0].path), true);
  assert.match(execFileSync('jj', ['workspace', 'list', '-R', alphaSource], { encoding: 'utf8' }), /item-alpha/);
  assert.deepEqual(
    {
      ...getDb().prepare('SELECT operation_state, operation_step FROM workspaces WHERE id = ?').get(children[0].id),
    },
    { operation_state: 'error', operation_step: 'destroy:forget_workspace' },
  );

  execFileSync('jj', ['bookmark', 'delete', bookmark, '-R', alphaSource]);
  await destroyWorkItemChild(children[0].id, config, { deleteBookmark: true });
  await destroyWorkItemChild(children[1].id, config, { deleteBookmark: false });
  assert.equal(existsSync(children[0].path), false);
  assert.equal(existsSync(children[1].path), false);
  assert.doesNotMatch(execFileSync('jj', ['workspace', 'list', '-R', alphaSource], { encoding: 'utf8' }), /item-alpha/);
  assert.doesNotMatch(execFileSync('jj', ['workspace', 'list', '-R', betaSource], { encoding: 'utf8' }), /item-beta/);
  assert.doesNotMatch(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', alphaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
  assert.match(
    execFileSync('jj', ['bookmark', 'list', bookmark, '-R', betaSource], { encoding: 'utf8' }),
    /patrol\/work-item-item1/,
  );
});
