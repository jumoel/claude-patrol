import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { dockerComposeDown } from './workspace.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'patrol-compose-'));
  roots.push(root);
  for (const [directory, contents] of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Compose interpolation
    ['tests', 'services:\n  test:\n    image: ${IMAGE}\n'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal package recipe interpolation
    ['os', 'package:\n  name: docker-compose\npipeline:\n  - runs: echo ${{package.version}}\n'],
  ]) {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, 'docker-compose.yaml'), contents);
  }
  return root;
}

function docker(stacks, failure) {
  const calls = [];
  return {
    calls,
    runExec: async (command, args, options) => {
      assert.equal(command, 'docker');
      assert.equal(options.timeout, 60_000);
      calls.push(args);
      if (args[1] === 'ls') return { stdout: JSON.stringify(stacks) };
      if (failure) throw new Error(failure);
      return { stdout: '' };
    },
  };
}

const listArgs = ['compose', 'ls', '-a', '--format', 'json'];

test('unused Compose fixtures and package recipes do not trigger teardown', async () => {
  const root = fixture();
  const runtime = docker([]);
  assert.equal(await dockerComposeDown(root, runtime), null);
  assert.deepEqual(runtime.calls, [listArgs]);
});

test('teardown uses recorded project names once, including stopped projects and multiple config files', async () => {
  const root = fixture();
  const runtime = docker([
    {
      Name: 'custom-running-project',
      Status: 'running(2)',
      ConfigFiles: `${root}/tests/docker-compose.yaml,${root}/tests/override.yaml`,
    },
    { Name: 'custom-stopped-project', Status: 'exited(1)', ConfigFiles: `${root}/tests/docker-compose.yaml` },
    { Name: 'other-workspace', ConfigFiles: `${root}-other/tests/docker-compose.yaml` },
    { Name: 'parent-workspace', ConfigFiles: `${root}/../docker-compose.yaml` },
    { Name: 'unknown-owner', ConfigFiles: '' },
    { Name: 'relative-path', ConfigFiles: 'tests/docker-compose.yaml' },
  ]);
  assert.equal(await dockerComposeDown(root, runtime), null);
  assert.deepEqual(runtime.calls, [
    listArgs,
    ['compose', '-p', 'custom-running-project', 'down', '-v', '--remove-orphans'],
    ['compose', '-p', 'custom-stopped-project', 'down', '-v', '--remove-orphans'],
  ]);
});

test('a project shared with another workspace blocks cleanup without tearing it down', async () => {
  const root = fixture();
  const runtime = docker([
    { Name: 'shared-project', ConfigFiles: `${root}/tests/docker-compose.yaml,/other/compose.yaml` },
  ]);
  assert.match(await dockerComposeDown(root, runtime), /shared-project: .*outside this workspace/);
  assert.deepEqual(runtime.calls, [listArgs]);
});

test('Docker discovery failure blocks cleanup', async () => {
  const warning = await dockerComposeDown(fixture(), {
    runExec: async () => {
      throw new Error('daemon unavailable');
    },
  });
  assert.match(warning, /discovery failed: daemon unavailable/);
});

test('invalid Docker discovery output blocks cleanup', async () => {
  const root = fixture();
  for (const stdout of ['invalid json', '{}', 'null', '[null]', '[{"Name":"project"}]']) {
    assert.match(
      await dockerComposeDown(root, { runExec: async () => ({ stdout }) }),
      /Docker compose project discovery failed:/,
    );
  }
});

test('owned project teardown failures remain visible and other owned projects are attempted', async () => {
  const root = fixture();
  const runtime = docker(
    ['first', 'second'].map((Name) => ({ Name, ConfigFiles: `${root}/tests/docker-compose.yaml` })),
    'removal denied',
  );
  const warning = await dockerComposeDown(root, runtime);
  assert.match(warning, /first: removal denied/);
  assert.match(warning, /second: removal denied/);
  assert.equal(runtime.calls.length, 3);
});

test('workspaces without Compose files do not require Docker', async () => {
  const root = fixture();
  rmSync(join(root, 'tests'), { recursive: true });
  rmSync(join(root, 'os'), { recursive: true });
  const runtime = docker([]);
  assert.equal(await dockerComposeDown(root, runtime), null);
  assert.deepEqual(runtime.calls, []);
});
