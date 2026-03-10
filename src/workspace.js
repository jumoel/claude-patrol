import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { symlinkSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDb } from './db.js';
import { expandPath } from './utils.js';

const execFile = promisify(execFileCb);

/**
 * Ensure a git repo has jj initialized. If .jj/ doesn't exist, runs
 * `jj git init --colocate` to set it up. No-op if already initialized.
 * @param {string} repoPath
 */
async function ensureJjInit(repoPath) {
  if (!existsSync(repoPath)) {
    throw new Error(`Repo directory does not exist: ${repoPath}`);
  }
  const jjDir = resolve(repoPath, '.jj');
  if (existsSync(jjDir)) return;

  console.log(`[workspace] Initializing jj in ${repoPath}`);
  await execFile('jj', ['git', 'init', '--colocate'], { cwd: repoPath });
}

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
  const workspacePath = resolve(basePath, pr.org, pr.repo, String(pr.number));
  const mainRepoPath = resolve(expandPath(config.work_dir), pr.org, pr.repo);
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

  // Ensure main repo is jj-initialized (git clones won't have .jj/)
  await ensureJjInit(mainRepoPath);

  // Ensure parent directories exist (jj won't create them)
  mkdirSync(dirname(workspacePath), { recursive: true });

  // Create workspace via jj
  try {
    await execFile('jj', ['workspace', 'add', workspacePath, '--name', name, '-r', pr.branch, '-R', mainRepoPath]);
  } catch (err) {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    throw new Error(`jj workspace add failed: ${err.message}`);
  }

  // Per-repo config: symlinks + init commands
  const repoKey = `${pr.org}/${pr.repo}`;
  const repoConfig = (config.repos || {})[repoKey] || {};

  // Run post-create setup
  try {
    if (config.symlink_memory) {
      symlinkMemory(workspacePath, mainRepoPath);
    }
    if (repoConfig.symlinks) {
      setupRepoSymlinks(workspacePath, mainRepoPath, repoConfig.symlinks);
    }
  } catch (err) {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    await execFile('jj', ['workspace', 'forget', name, '-R', mainRepoPath]).catch(() => {});
    rmSync(workspacePath, { recursive: true, force: true });
    throw new Error(`Workspace setup failed: ${err.message}`);
  }

  // Run init commands (non-fatal - workspace is usable even if these fail)
  if (repoConfig.initCommands) {
    for (const cmd of repoConfig.initCommands) {
      try {
        const [bin, ...args] = cmd.split(' ');
        await execFile(bin, args, { cwd: workspacePath, timeout: 120_000 });
      } catch (err) {
        console.warn(`[workspace] Init command failed in ${name}: ${cmd} - ${err.message}`);
      }
    }
  }

  return { id, pr_id: prId, name, path: workspacePath, bookmark: pr.branch, status: 'active', created_at: now };
}

/**
 * Symlink files from the primary repo into the workspace.
 * Each entry is a relative path (e.g. "./dev/cvg/skill/scripts/.jsgr_signing_token").
 * The same relative path in the workspace points to the file in the main repo.
 * @param {string} workspacePath
 * @param {string} mainRepoPath
 * @param {string[]} symlinks - relative paths to symlink
 */
function setupRepoSymlinks(workspacePath, mainRepoPath, symlinks) {
  for (const relPath of symlinks) {
    const source = resolve(mainRepoPath, relPath);
    if (!existsSync(source)) {
      throw new Error(`Symlink source does not exist: ${source}`);
    }
    const target = resolve(workspacePath, relPath);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
  }
}

/**
 * Encode a filesystem path to a Claude project key.
 * Claude uses: replace all `/` and `.` with `-`.
 * e.g. /Users/foo/work/org/repo.js -> -Users-foo-work-org-repo-js
 * @param {string} fsPath
 * @returns {string}
 */
function toClaudeProjectKey(fsPath) {
  return fsPath.replace(/[/.]/g, '-');
}

/**
 * Symlink Claude project memory so the workspace shares memory with the main repo.
 * Source: ~/.claude/projects/<main-repo-key>/memory/
 * Target: ~/.claude/projects/<workspace-key>/memory/ (symlink)
 * @param {string} workspacePath - absolute path to the new workspace
 * @param {string} mainRepoPath - absolute path to the main repo
 */
function symlinkMemory(workspacePath, mainRepoPath) {
  const claudeProjects = expandPath('~/.claude/projects');
  const sourceKey = toClaudeProjectKey(mainRepoPath);
  const source = resolve(claudeProjects, sourceKey, 'memory');

  if (!existsSync(source)) {
    // Create the source memory dir if it doesn't exist yet
    mkdirSync(source, { recursive: true });
  }

  const targetKey = toClaudeProjectKey(workspacePath);
  const targetProjectDir = resolve(claudeProjects, targetKey);
  const target = resolve(targetProjectDir, 'memory');

  mkdirSync(targetProjectDir, { recursive: true });

  // Remove existing memory dir/symlink if present
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }

  symlinkSync(source, target);
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
  // Derive repo path from PR data
  const pr = db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(workspace.pr_id);
  const mainRepoPath = pr
    ? resolve(expandPath(config.work_dir), pr.org, pr.repo)
    : expandPath(config.work_dir);

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

  // Step 5: Clean up Claude project memory symlink
  try {
    const claudeProjects = expandPath('~/.claude/projects');
    const wsKey = toClaudeProjectKey(workspace.path);
    const wsProjectDir = resolve(claudeProjects, wsKey);
    if (existsSync(wsProjectDir)) {
      rmSync(wsProjectDir, { recursive: true, force: true });
    }
  } catch (err) {
    warnings.push(`Claude memory cleanup failed: ${err.message}`);
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
