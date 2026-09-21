import { constants } from 'node:fs';
import { lstat, open, readdir, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from './utils.js';

async function prepareDirectoryForRemoval(path) {
  let directory;
  try {
    // Open the directory itself so chmod cannot follow a symlink.
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return;
    throw error;
  }

  try {
    const stat = await directory.stat();
    if ((stat.mode & 0o700) !== 0o700) await directory.chmod((stat.mode & 0o7777) | 0o700);
  } finally {
    await directory.close();
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await prepareDirectoryForRemoval(join(path, entry.name));
  }
}

async function removeDirectoryDeleteDenial(root, deniedPath) {
  const relation = relative(root, deniedPath);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) return false;

  // Check every component: a symlink inside the workspace must not redirect
  // ACL changes to an external directory. Files may have external hard links.
  let current = root;
  for (const component of ['', ...(relation ? relation.split(sep) : [])]) {
    current = join(current, component);
    if (!(await lstat(current)).isDirectory()) return false;
  }
  const user = userInfo();
  if ((await lstat(deniedPath)).uid !== user.uid) return false;

  // Remove only this user's delete denial, preserving all other ACL rights.
  // -h prevents following a symlink if the final component has been replaced.
  await execFile('/bin/chmod', ['-h', '-a', `user:${user.username} deny delete`, deniedPath], { timeout: 10_000 });
  return true;
}

/** Remove a workspace after its lifecycle has authorized deletion and stopped sessions. */
export async function removeWorkspaceDirectory(path) {
  // Frozen review snapshots and Go caches contain read-only directories.
  // Unlink requires writable directories; files can retain their original modes.
  await prepareDirectoryForRemoval(path);
  const root = resolve(path);
  const repairedPaths = new Set();
  while (true) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        process.platform !== 'darwin' ||
        !['EACCES', 'EPERM'].includes(error.code) ||
        error.syscall !== 'rmdir' ||
        typeof error.path !== 'string'
      ) {
        throw error;
      }
      const deniedPath = resolve(error.path);
      // A second failure on the same directory has another cause. Do not loop
      // indefinitely or erase unrelated ACLs to make the operation succeed.
      if (repairedPaths.has(deniedPath)) throw error;
      let repaired;
      try {
        repaired = await removeDirectoryDeleteDenial(root, deniedPath);
      } catch (cause) {
        error.cause = cause;
        throw error;
      }
      if (!repaired) throw error;
      repairedPaths.add(deniedPath);
    }
  }
}
