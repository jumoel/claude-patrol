import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { symlinkSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDb } from './db.js';
import { expandPath } from './utils.js';

const execFile = promisify(execFileCb);

/**
 * Create a jj workspace for a PR.
 * Uses a transaction with unique constraint to prevent concurrent creation.
 * @param {string} prId - e.g. 'org/repo#42'
 * @param {object} config - app config
 * @returns {Promise<object>} workspace record
 */
export async function createWorkspace(prId, config) {
  const db = getDb();

  // Get PR data for branch name
  const pr = db.prepare('SELECT * FROM prs WHERE id = ?').get(prId);
  if (!pr) {
    throw new Error(`PR not found: ${prId}`);
  }

  const id = randomUUID();
  const name = `${pr.org}-${pr.repo}-${pr.number}`;
  const basePath = expandPath(config.workspace_base_path);
  const workspacePath = resolve(basePath, name);
  const mainRepoPath = expandPath(config.main_repo_path);
  const now = new Date().toISOString();

  // Insert first to claim the slot (unique constraint on pr_id+active prevents races)
  try {
    db.prepare('INSERT INTO workspaces (id, pr_id, name, path, bookmark, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id, prId, name, workspacePath, pr.branch, 'active', now
    );
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      throw new Error(`Active workspace already exists for ${prId}`);
    }
    throw err;
  }

  // Create workspace via jj
  try {
    await execFile('jj', ['workspace', 'add', workspacePath, '--name', name, '-r', pr.branch, '-R', mainRepoPath]);
  } catch (err) {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    throw new Error(`jj workspace add failed: ${err.message}`);
  }

  // Run post-create setup (symlinks)
  try {
    setupSymlinks(workspacePath, config.symlinks || {});
  } catch (err) {
    // Cleanup on symlink failure
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    await execFile('jj', ['workspace', 'forget', name, '-R', mainRepoPath]).catch(() => {});
    rmSync(workspacePath, { recursive: true, force: true });
    throw new Error(`Symlink setup failed: ${err.message}`);
  }

  return { id, pr_id: prId, name, path: workspacePath, bookmark: pr.branch, status: 'active', created_at: now };
}

/**
 * Create symlinks inside the workspace directory.
 * Config symlinks map logical names to source paths. Target paths inside
 * the workspace are derived from the key name (prefixed with dot).
 * Special cases: claude_memory -> .claude/memory, jsgr_token -> .jsgr-token.
 * @param {string} workspacePath
 * @param {Record<string, string>} symlinks
 */
function setupSymlinks(workspacePath, symlinks) {
  const TARGET_MAP = {
    claude_memory: ['.claude', 'memory'],
    jsgr_token: ['.jsgr-token'],
  };

  for (const [key, sourcePath] of Object.entries(symlinks)) {
    const expanded = expandPath(sourcePath);
    if (!existsSync(expanded)) {
      throw new Error(`Symlink source does not exist: ${expanded} (for ${key})`);
    }

    const segments = TARGET_MAP[key] || [`.${key}`];
    const targetPath = resolve(workspacePath, ...segments);

    mkdirSync(dirname(targetPath), { recursive: true });
    symlinkSync(expanded, targetPath);
  }
}

/**
 * Destroy a workspace - kill sessions, docker down, jj forget, rm.
 * @param {string} workspaceId
 * @param {object} config
 * @returns {Promise<{ok: boolean, warnings: string[]}>}
 */
export async function destroyWorkspace(workspaceId, config) {
  const db = getDb();
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  if (workspace.status === 'destroyed') {
    throw new Error(`Workspace already destroyed: ${workspaceId}`);
  }

  const warnings = [];
  const mainRepoPath = expandPath(config.main_repo_path);

  // Mark as destroyed early to prevent concurrent destroy attempts
  db.prepare("UPDATE workspaces SET status = 'destroyed', destroyed_at = ? WHERE id = ?").run(new Date().toISOString(), workspaceId);

  // Step 1: Kill active sessions for this workspace
  const sessions = db.prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')").all(workspaceId);
  for (const session of sessions) {
    if (session.pid) {
      try {
        process.kill(session.pid, 'SIGTERM');
        await waitForExit(session.pid, 5000);
      } catch {
        try { process.kill(session.pid, 'SIGKILL'); } catch { /* already dead */ }
      }
    }
    db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(new Date().toISOString(), session.id);
  }

  // Step 2: Docker compose down if applicable
  if (existsSync(resolve(workspace.path, 'docker-compose.yml')) || existsSync(resolve(workspace.path, 'compose.yml'))) {
    try {
      await execFile('docker', ['compose', 'down', '-v'], { cwd: workspace.path, timeout: 30000 });
    } catch (err) {
      warnings.push(`Docker compose down failed: ${err.message}`);
    }
  }

  // Step 3: jj workspace forget
  try {
    await execFile('jj', ['workspace', 'forget', workspace.name, '-R', mainRepoPath]);
  } catch (err) {
    warnings.push(`jj workspace forget failed: ${err.message}`);
  }

  // Step 4: Remove workspace directory
  try {
    rmSync(workspace.path, { recursive: true, force: true });
  } catch (err) {
    warnings.push(`Directory cleanup failed: ${err.message}`);
  }

  return { ok: true, warnings };
}

/**
 * Wait for a process to exit, up to a timeout.
 * Note: uses process.kill(pid, 0) polling since we don't have a child process handle.
 * @param {number} pid
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForExit(pid, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      try {
        process.kill(pid, 0);
        if (Date.now() - start > timeoutMs) {
          reject(new Error('timeout'));
        } else {
          setTimeout(check, 200);
        }
      } catch {
        resolve();
      }
    };
    check();
  });
}
