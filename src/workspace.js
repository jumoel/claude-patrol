import { randomUUID } from 'node:crypto';
import { symlinkSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getDb } from './db.js';
import { execFile, expandPath } from './utils.js';

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
  if (!existsSync(jjDir)) {
    console.log(`[workspace] Initializing jj in ${repoPath}`);
    await execFile('jj', ['git', 'init', '--colocate'], { cwd: repoPath });
    return;
  }

  // Update stale working copy - jj refuses operations on stale repos
  try {
    await execFile('jj', ['workspace', 'update-stale', '-R', repoPath]);
  } catch {
    // Non-fatal: update-stale fails if workspace isn't stale (exit code 1)
  }
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

  // Everything after DB insert gets full rollback on failure
  try {
    await ensureJjInit(mainRepoPath);
    mkdirSync(dirname(workspacePath), { recursive: true });
    await execFile('jj', ['workspace', 'add', workspacePath, '--name', name, '-r', pr.branch, '-R', mainRepoPath]);
    await runPostCreateSetup(workspacePath, mainRepoPath, name, config, `${pr.org}/${pr.repo}`);
  } catch (err) {
    await rollbackWorkspace({ id, name, workspacePath, mainRepoPath });
    throw new Error(`Workspace creation failed: ${err.message}`);
  }

  return { id, pr_id: prId, name, path: workspacePath, bookmark: pr.branch, status: 'active', created_at: now };
}

/**
 * Create a scratch workspace for starting new work (no PR yet).
 * @param {string} repo - "org/repo" format
 * @param {string} branch - desired branch name
 * @param {object} config - app config
 * @returns {Promise<object>} workspace record
 */
export async function createScratchWorkspace(repo, branch, config) {
  const db = getDb();
  const [org, repoName] = repo.split('/');
  if (!org || !repoName) {
    throw new Error(`Invalid repo format: ${repo} (expected "org/repo")`);
  }

  const id = randomUUID();
  const slug = branch.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const name = `scratch-${slug}`;
  const basePath = expandPath(config.workspace_base_path);
  const workspacePath = resolve(basePath, org, repoName, `scratch-${slug}`);
  const mainRepoPath = resolve(expandPath(config.work_dir), org, repoName);
  const now = new Date().toISOString();

  if (!existsSync(mainRepoPath)) {
    throw new Error(`Main repo does not exist: ${mainRepoPath}`);
  }

  // Insert with pr_id = NULL, repo set
  try {
    db.prepare('INSERT INTO workspaces (id, pr_id, name, path, bookmark, repo, status, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)').run(
      id, name, workspacePath, branch, repo, 'active', now
    );
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      throw new Error(`Active scratch workspace already exists for ${branch}`);
    }
    throw err;
  }

  // Everything after DB insert gets full rollback on failure
  try {
    await ensureJjInit(mainRepoPath);
    mkdirSync(dirname(workspacePath), { recursive: true });
    await execFile('jj', ['workspace', 'add', workspacePath, '--name', name, '-r', 'main@origin', '-R', mainRepoPath]);

    // Create bookmark for the branch (non-fatal - may already exist)
    try {
      await execFile('jj', ['bookmark', 'create', branch, '-R', workspacePath]);
    } catch (err) {
      console.warn(`[workspace] Bookmark create failed (may already exist): ${err.message}`);
    }

    await runPostCreateSetup(workspacePath, mainRepoPath, name, config, repo);
  } catch (err) {
    await rollbackWorkspace({ id, name, workspacePath, mainRepoPath });
    throw new Error(`Workspace creation failed: ${err.message}`);
  }

  return { id, pr_id: null, repo, name, path: workspacePath, bookmark: branch, status: 'active', created_at: now };
}

/**
 * Clean up all artifacts from a failed workspace creation.
 * Best-effort: logs warnings but does not throw.
 * @param {object} opts
 * @param {string} opts.id - workspace DB id
 * @param {string} opts.name - jj workspace name
 * @param {string} opts.workspacePath
 * @param {string} opts.mainRepoPath
 */
async function rollbackWorkspace({ id, name, workspacePath, mainRepoPath }) {
  const db = getDb();

  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);

  await execFile('jj', ['workspace', 'forget', name, '-R', mainRepoPath]).catch(() => {});

  try { rmSync(workspacePath, { recursive: true, force: true }); } catch { /* best effort */ }

  try {
    const claudeProjects = expandPath('~/.claude/projects');
    const wsKey = toClaudeProjectKey(workspacePath);
    const wsProjectDir = resolve(claudeProjects, wsKey);
    if (existsSync(wsProjectDir)) {
      rmSync(wsProjectDir, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

/**
 * Run post-create setup: symlinks, memory linking, and init commands.
 * On failure, caller is responsible for rollback.
 * @param {string} workspacePath
 * @param {string} mainRepoPath
 * @param {string} name - jj workspace name (for log messages)
 * @param {object} config
 * @param {string} repoKey - "org/repo" for config lookup
 */
async function runPostCreateSetup(workspacePath, mainRepoPath, name, config, repoKey) {
  const repoConfig = (config.repos || {})[repoKey] || {};

  if (config.symlink_memory) {
    symlinkMemory(workspacePath, mainRepoPath);
  }
  if (repoConfig.symlinks) {
    setupRepoSymlinks(workspacePath, mainRepoPath, repoConfig.symlinks);
  }

  // Init commands are non-fatal - workspace is usable even if these fail
  if (repoConfig.initCommands) {
    for (const cmd of repoConfig.initCommands) {
      try {
        await execFile('/bin/sh', ['-c', cmd], { cwd: workspacePath, timeout: 120_000 });
      } catch (err) {
        console.warn(`[workspace] Init command failed in ${name}: ${cmd} - ${err.message}`);
      }
    }
  }
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
  // Derive repo path from PR data or scratch workspace repo column
  let mainRepoPath;
  if (workspace.pr_id) {
    const pr = db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(workspace.pr_id);
    mainRepoPath = pr
      ? resolve(expandPath(config.work_dir), pr.org, pr.repo)
      : expandPath(config.work_dir);
  } else if (workspace.repo) {
    const [org, repoName] = workspace.repo.split('/');
    mainRepoPath = resolve(expandPath(config.work_dir), org, repoName);
  } else {
    mainRepoPath = expandPath(config.work_dir);
  }

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
