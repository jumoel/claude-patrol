import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { removeWorkspaceDirectory } from './workspace-directory.js';

function directoryAcl(path) {
  return execFileSync('/bin/ls', ['-lde', path], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => /^\s*\d+:/.test(line));
}

async function aclFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'patrol-remove-acl-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const protectedPaths = [];
  t.after(async () => {
    for (const path of protectedPaths) {
      if (await stat(path).catch(() => null)) execFileSync('/bin/chmod', ['-N', path]);
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    protect(path, permissions = 'delete', principal = `user:${userInfo().username}`) {
      execFileSync('/bin/chmod', ['+a', `${principal} deny ${permissions}`, path]);
      protectedPaths.push(path);
    },
  };
}

test('workspace removal handles macOS delete-denying ACLs on nested directories and the root', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const { workspace, protect } = await aclFixture(t);
  const modules = join(workspace, 'node_modules');
  const nested = join(modules, 'package');
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, 'package.json'), '{}\n');
  for (const path of [nested, modules, workspace]) {
    protect(path);
    assert.match(directoryAcl(path).join('\n'), /deny delete/);
  }

  await removeWorkspaceDirectory(workspace);

  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  await removeWorkspaceDirectory(workspace);
});

test('ACL repair preserves unrelated denials and fails when another ACL still blocks deletion', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const { workspace, protect } = await aclFixture(t);
  const aclEntries = () => directoryAcl(workspace).map((line) => line.replace(/^\s*\d+:\s*/u, ''));
  protect(workspace, 'delete,writeextattr');
  const [userDenial] = aclEntries();
  assert.ok(userDenial);
  const userPrincipal = userDenial.split(' deny ')[0];
  protect(workspace, 'delete', 'group:everyone');
  const before = aclEntries();
  const groupDenial = before.find((entry) => entry !== userDenial);
  assert.ok(groupDenial);

  await assert.rejects(removeWorkspaceDirectory(workspace), { code: 'EACCES', syscall: 'rmdir' });

  assert.deepEqual(aclEntries().sort(), [groupDenial, `${userPrincipal} deny writeextattr`].sort());
});

test('ACL repair leaves external symlink targets and hard-linked files unchanged', {
  skip: process.platform !== 'darwin',
}, async (t) => {
  const { root, workspace, protect } = await aclFixture(t);
  const external = join(root, 'external');
  const externalFile = join(external, 'sentinel');
  const modules = join(workspace, 'node_modules');
  await mkdir(external);
  await writeFile(externalFile, 'Keep me\n');
  await mkdir(modules);
  await symlink(external, join(modules, 'external'));
  await link(externalFile, join(modules, 'hard-link'));
  protect(external);
  protect(externalFile, 'writeextattr');
  protect(modules);
  const directoryBefore = directoryAcl(external);
  const fileBefore = directoryAcl(externalFile);

  await removeWorkspaceDirectory(workspace);

  await assert.rejects(stat(workspace), { code: 'ENOENT' });
  assert.deepEqual(directoryAcl(external), directoryBefore);
  assert.deepEqual(directoryAcl(externalFile), fileBefore);
  assert.equal(await readFile(externalFile, 'utf8'), 'Keep me\n');
});

test('workspace removal deletes frozen directories without changing linked files or external directories', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'patrol-remove-directory-'));
  const workspace = join(fixture, 'workspace');
  const context = join(workspace, '.reviews', 'context');
  const external = join(fixture, 'external');
  const sourceFile = join(external, 'CLAUDE.md');
  await mkdir(context, { recursive: true });
  await mkdir(external);
  await writeFile(sourceFile, 'Shared context\n', { mode: 0o444 });
  await link(sourceFile, join(context, 'CLAUDE.md'));
  await symlink(external, join(context, 'external'));
  await symlink(join(fixture, 'missing-target'), join(context, 'dangling'));
  const frozenDirectories = [workspace, join(workspace, '.reviews'), context, external];
  for (const path of frozenDirectories) await chmod(path, 0o555);

  try {
    await removeWorkspaceDirectory(workspace);

    await assert.rejects(stat(workspace), { code: 'ENOENT' });
    assert.equal((await stat(external)).mode & 0o777, 0o555);
    assert.equal((await stat(sourceFile)).mode & 0o777, 0o444);
    assert.equal(await readFile(sourceFile, 'utf8'), 'Shared context\n');
    await removeWorkspaceDirectory(workspace);
  } finally {
    for (const path of frozenDirectories) {
      await chmod(path, 0o755).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await rm(fixture, { recursive: true, force: true });
  }
});

test('workspace removal unlinks a symlink root without changing its target', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'patrol-remove-symlink-'));
  const external = join(fixture, 'external');
  const workspace = join(fixture, 'workspace');
  await mkdir(external);
  await writeFile(join(external, 'sentinel'), 'Keep me\n');
  await symlink(external, workspace);
  await chmod(external, 0o555);

  try {
    await removeWorkspaceDirectory(workspace);

    await assert.rejects(stat(workspace), { code: 'ENOENT' });
    assert.equal((await stat(external)).mode & 0o777, 0o555);
    assert.equal(await readFile(join(external, 'sentinel'), 'utf8'), 'Keep me\n');
  } finally {
    await chmod(external, 0o755);
    await rm(fixture, { recursive: true, force: true });
  }
});

test('workspace removal reports permission failures it cannot repair', { skip: process.getuid?.() === 0 }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'patrol-remove-denied-'));
  const workspace = join(fixture, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'sentinel'), 'Keep me\n');
  await chmod(workspace, 0o000);

  try {
    await assert.rejects(removeWorkspaceDirectory(workspace), { code: 'EACCES' });
  } finally {
    await chmod(workspace, 0o755);
    await rm(fixture, { recursive: true, force: true });
  }
});
