import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { runTask } from './tasks.js';
import { archiveTranscript } from './transcripts.js';
import { execFile, expandPath, toClaudeProjectKey } from './utils.js';

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

/** @type {Map<string, Promise<unknown>>} */
const workspaceLocks = new Map();

function isAlreadyForgotten(error) {
  if (error?.code === 'ENOENT') return false;
  return /no such workspace|no workspace named|workspace.*(?:not found|does not exist|unknown)/i.test(
    error?.message ?? '',
  );
}

function updateWorkspaceOperation(id, state, step, error = null, extra = {}) {
  const db = getDb();
  const assignments = ['operation_state = ?', 'operation_step = ?', 'operation_error = ?', 'operation_updated_at = ?'];
  const values = [state, step, error, new Date().toISOString()];
  for (const [column, value] of Object.entries(extra)) {
    assignments.push(`${column} = ?`);
    values.push(value);
  }
  values.push(id);
  db.prepare(`UPDATE workspaces SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Report interrupted or inconsistent workspace operations without modifying
 * external state. Startup uses this in report-only mode.
 */
export function inspectWorkspaceState() {
  const rows = getDb().prepare('SELECT * FROM workspaces').all();
  const issues = [];
  for (const workspace of rows) {
    if (!['ready', 'destroyed'].includes(workspace.operation_state)) {
      issues.push({
        workspace_id: workspace.id,
        state: workspace.operation_state,
        step: workspace.operation_step,
        error: workspace.operation_error,
      });
      continue;
    }
    if (workspace.status === 'active' && workspace.operation_state === 'ready' && !existsSync(workspace.path)) {
      issues.push({
        workspace_id: workspace.id,
        state: 'inconsistent',
        step: 'health:missing_path',
        error: `Workspace directory is missing: ${workspace.path}`,
      });
    }
  }
  return issues;
}

/**
 * Serialize operations on a single workspace id. Without this, a destroy can
 * fire against a create that is still mid-flight: it marks the DB row
 * destroyed and runs `jj workspace forget` before `jj workspace add` has
 * finished, so jj ends up owning an orphan workspace the DB no longer
 * tracks. Subsequent creates then fail with `Workspace named ... already
 * exists`.
 * @template T
 * @param {string} id
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withWorkspaceLock(id, fn) {
  const prev = workspaceLocks.get(id);
  const current = (async () => {
    if (prev) {
      try {
        await prev;
      } catch {
        /* prior holder's failure is its own to report */
      }
    }
    return fn();
  })();
  workspaceLocks.set(id, current);
  try {
    return await current;
  } finally {
    if (workspaceLocks.get(id) === current) {
      workspaceLocks.delete(id);
    }
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

  return withWorkspaceLock(`pr:${prId}`, async () => {
    // Insert inside the lock so the row only becomes visible after we hold it.
    // Unique index on (pr_id) WHERE status='active' still guards against
    // concurrent creates for the same PR.
    try {
      db.prepare(
        `INSERT INTO workspaces
          (id, pr_id, name, path, bookmark, status, created_at, operation_state, operation_step, operation_updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, 'creating', 'create:reserved', ?)`,
      ).run(id, prId, name, workspacePath, pr.branch, now, now);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        throw new Error(`Active workspace already exists for ${prId}`);
      }
      throw err;
    }

    try {
      await runTask(
        {
          kind: 'workspace.create',
          label: `Create ${name}`,
          context: { workspaceId: id, prId, repo: `${pr.org}/${pr.repo}` },
        },
        async () => {
          updateWorkspaceOperation(id, 'creating', 'create:initialize_repository');
          await ensureJjInit(mainRepoPath);
          mkdirSync(dirname(workspacePath), { recursive: true });
          updateWorkspaceOperation(id, 'creating', 'create:add_workspace');
          await execFile('jj', [
            'workspace',
            'add',
            workspacePath,
            '--name',
            name,
            '-r',
            pr.branch,
            '-R',
            mainRepoPath,
          ]);
          updateWorkspaceOperation(id, 'creating', 'create:post_setup');
          await runPostCreateSetup(workspacePath, mainRepoPath, name, config, `${pr.org}/${pr.repo}`);
        },
      );
    } catch (err) {
      await rollbackWorkspace({
        id,
        name,
        workspacePath,
        mainRepoPath,
        repo: `${pr.org}/${pr.repo}`,
        error: err,
      });
      emitLocalChange();
      throw new Error(`Workspace creation failed: ${err.message}`);
    }

    updateWorkspaceOperation(id, 'ready', 'create:complete');
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  });
}

/**
 * Create a scratch workspace for starting new work (no PR yet).
 * @param {string} repo - "org/repo" format
 * @param {string} branch - desired branch name
 * @param {object} config - app config
 * @returns {Promise<object>} workspace record
 */
export async function createScratchWorkspace(repo, branch, config, { startRevision = 'main@origin' } = {}) {
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

  return withWorkspaceLock(`scratch:${repo}:${branch}`, async () => {
    try {
      db.prepare(
        `INSERT INTO workspaces
          (id, pr_id, name, path, bookmark, repo, status, created_at, operation_state, operation_step, operation_updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, 'active', ?, 'creating', 'create:reserved', ?)`,
      ).run(id, name, workspacePath, branch, repo, now, now);
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        throw new Error(`Active scratch workspace already exists for ${branch}`);
      }
      throw err;
    }

    try {
      await runTask(
        {
          kind: 'workspace.create',
          label: `Create ${name}`,
          context: { workspaceId: id, repo, branch },
        },
        async () => {
          updateWorkspaceOperation(id, 'creating', 'create:initialize_repository');
          await ensureJjInit(mainRepoPath);
          mkdirSync(dirname(workspacePath), { recursive: true });
          updateWorkspaceOperation(id, 'creating', 'create:add_workspace');
          await execFile('jj', [
            'workspace',
            'add',
            workspacePath,
            '--name',
            name,
            '-r',
            startRevision,
            '-R',
            mainRepoPath,
          ]);

          // Create bookmark for the branch (non-fatal - may already exist)
          try {
            await execFile('jj', ['bookmark', 'create', branch, '-R', workspacePath]);
          } catch (err) {
            console.warn(`[workspace] Bookmark create failed (may already exist): ${err.message}`);
          }

          updateWorkspaceOperation(id, 'creating', 'create:post_setup');
          await runPostCreateSetup(workspacePath, mainRepoPath, name, config, repo);
        },
      );
    } catch (err) {
      await rollbackWorkspace({ id, name, workspacePath, mainRepoPath, repo, error: err });
      emitLocalChange();
      throw new Error(`Workspace creation failed: ${err.message}`);
    }

    updateWorkspaceOperation(id, 'ready', 'create:complete');
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  });
}

const COMPOSE_FILENAMES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const COMPOSE_SKIP_DIRS = new Set(['node_modules', '.git', '.jj', '.next', 'dist', 'build']);

/**
 * Recursively find docker compose files under a workspace, skipping heavy or
 * irrelevant directories. Returns absolute paths.
 * @param {string} root
 * @returns {string[]}
 */
function findComposeFiles(root) {
  const found = [];
  /** @param {string} dir */
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!COMPOSE_SKIP_DIRS.has(entry.name)) {
          walk(resolve(dir, entry.name));
        }
      } else if (entry.isFile() && COMPOSE_FILENAMES.has(entry.name)) {
        found.push(resolve(dir, entry.name));
      }
    }
  }
  walk(root);
  return found;
}

/**
 * Tear down docker compose stacks associated with a workspace. Walks the
 * workspace tree so it catches stacks nested under e.g. `infra/local/` and
 * with either `.yml` or `.yaml`. Stacks whose compose file is already gone
 * are handled by pruneStaleComposeStacks at server startup, so we don't
 * fall back to guessing project names from path components.
 * @param {string} workspacePath
 * @returns {Promise<string|null>} warning message if cleanup failed, null if ok or no stack found
 */
async function dockerComposeDown(workspacePath) {
  const composeFiles = findComposeFiles(workspacePath);
  if (composeFiles.length === 0) return null;
  const warnings = [];
  for (const composeFile of composeFiles) {
    try {
      await execFile('docker', ['compose', 'down', '-v', '--remove-orphans'], {
        cwd: dirname(composeFile),
        timeout: 60_000,
      });
    } catch (err) {
      warnings.push(`${composeFile}: ${err.message}`);
    }
  }
  return warnings.length > 0 ? `Docker compose down failed for: ${warnings.join('; ')}` : null;
}

/**
 * Find docker compose stacks whose config file lives under the patrol workspace
 * base path but no longer exists on disk. These are orphans left behind when a
 * workspace was destroyed before its compose stack was torn down.
 * @param {string} workspaceBasePath
 * @returns {Promise<Array<{name: string, configFile: string}>>}
 */
export async function detectStaleComposeStacks(workspaceBasePath) {
  let stdout;
  try {
    ({ stdout } = await execFile('docker', ['compose', 'ls', '-a', '--format', 'json']));
  } catch {
    return [];
  }
  let stacks;
  try {
    stacks = JSON.parse(stdout);
  } catch {
    return [];
  }
  const base = resolve(expandPath(workspaceBasePath));
  const prefix = base.endsWith('/') ? base : `${base}/`;
  const stale = [];
  for (const stack of stacks) {
    const configFiles = String(stack.ConfigFiles || '')
      .split(',')
      .filter(Boolean);
    if (configFiles.length === 0) continue;
    const first = configFiles[0];
    if (!first.startsWith(prefix)) continue;
    if (existsSync(first)) continue;
    stale.push({ name: stack.Name, configFile: first });
  }
  return stale;
}

/**
 * Tear down stale compose stacks identified by detectStaleComposeStacks.
 * Uses `docker compose -p <name> down -v --remove-orphans` which finds
 * containers, networks, and volumes via compose project labels, so it works
 * even when the original compose file is gone.
 * @param {string} workspaceBasePath
 * @returns {Promise<{torn: string[], warnings: string[]}>}
 */
export async function pruneStaleComposeStacks(workspaceBasePath) {
  const stale = await detectStaleComposeStacks(workspaceBasePath);
  const torn = [];
  const warnings = [];
  for (const { name } of stale) {
    try {
      await execFile('docker', ['compose', '-p', name, 'down', '-v', '--remove-orphans'], {
        timeout: 60_000,
      });
      torn.push(name);
    } catch (err) {
      warnings.push(`Stale compose tear-down failed for ${name}: ${err.message}`);
    }
  }
  return { torn, warnings };
}

/**
 * Clean up all artifacts from a failed workspace creation.
 * Best-effort: logs warnings but does not throw.
 * @param {object} opts
 * @param {string} opts.id - workspace DB id
 * @param {string} opts.name - jj workspace name
 * @param {string} opts.workspacePath
 * @param {string} opts.mainRepoPath
 * @param {string} opts.repo
 */
async function rollbackWorkspace({ id, name, workspacePath, mainRepoPath, repo, error }) {
  const warnings = [];
  updateWorkspaceOperation(id, 'creating', 'create:rollback', error?.message ?? String(error));

  // Docker compose down before removing the directory (compose file may still be needed)
  const dockerWarning = await dockerComposeDown(workspacePath).catch((caught) => caught.message);
  if (dockerWarning) warnings.push(dockerWarning);

  try {
    await execFile('jj', ['workspace', 'forget', name, '-R', mainRepoPath]);
  } catch (caught) {
    if (!isAlreadyForgotten(caught)) warnings.push(caught.message);
  }

  await rm(workspacePath, { recursive: true, force: true }).catch((caught) => warnings.push(caught.message));

  try {
    const claudeProjects = expandPath('~/.claude/projects');
    const wsKey = toClaudeProjectKey(workspacePath);
    const wsProjectDir = resolve(claudeProjects, wsKey);
    await rm(wsProjectDir, { recursive: true, force: true });
  } catch (caught) {
    warnings.push(caught.message);
  }

  const message = [error?.message ?? String(error), ...warnings].filter(Boolean).join('; ');
  const current = getDb().prepare('SELECT pr_id FROM workspaces WHERE id = ?').get(id);
  updateWorkspaceOperation(id, 'error', 'create:rollback_complete', message, {
    status: warnings.length > 0 ? 'active' : 'destroyed',
    destroyed_at: warnings.length > 0 ? null : new Date().toISOString(),
    pr_id: warnings.length > 0 ? (current?.pr_id ?? null) : null,
    repo,
  });
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
  const repoConfig = config.repos?.[repoKey] || {};

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
  return withWorkspaceLock(workspaceId, () => destroyWorkspaceLocked(workspaceId, config));
}

async function destroyWorkspaceLocked(workspaceId, config) {
  const db = getDb();
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }
  if (workspace.status === 'destroyed' && workspace.operation_state === 'destroyed') {
    const pr = workspace.pr_id ? db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(workspace.pr_id) : null;
    const repo = workspace.repo ?? (pr ? `${pr.org}/${pr.repo}` : null);
    db.prepare('UPDATE workspaces SET pr_id = NULL, repo = ? WHERE id = ?').run(repo, workspaceId);
    return { ok: true, warnings: [] };
  }

  const warnings = [];
  // Derive repo path from PR data or scratch workspace repo column
  let mainRepoPath;
  let workspaceRepo = workspace.repo;
  if (workspace.pr_id) {
    const pr = db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(workspace.pr_id);
    if (pr) workspaceRepo = `${pr.org}/${pr.repo}`;
    mainRepoPath = pr ? resolve(expandPath(config.work_dir), pr.org, pr.repo) : expandPath(config.work_dir);
  } else if (workspace.repo) {
    const [org, repoName] = workspace.repo.split('/');
    mainRepoPath = resolve(expandPath(config.work_dir), org, repoName);
  } else {
    mainRepoPath = expandPath(config.work_dir);
  }

  // The public active list filters on operation_state, so this removes the
  // workspace from the UI immediately while retaining the active uniqueness
  // guard until every external cleanup step succeeds.
  updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:reserved');

  // Notify clients now so the UI removes the workspace from active lists
  // immediately, instead of waiting for filesystem cleanup (which can take
  // seconds for workspaces with node_modules / build artifacts).
  emitLocalChange();

  // Track the rest as an observable task so the UI can show progress.
  try {
    return await runTask(
      {
        kind: 'workspace.destroy',
        label: `Destroy ${workspace.name}`,
        context: { workspaceId, prId: workspace.pr_id, repo: workspaceRepo },
      },
      async () => {
        // Step 1: Kill active sessions for this workspace
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:sessions');
        const sessions = db
          .prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')")
          .all(workspaceId);
        for (const session of sessions) {
          if (session.pid) {
            try {
              process.kill(session.pid, 'SIGTERM');
              await waitForExit(session.pid, 5000);
            } catch {
              try {
                process.kill(session.pid, 'SIGKILL');
              } catch {
                /* already dead */
              }
            }
          }
          db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(
            new Date().toISOString(),
            session.id,
          );
        }

        // Step 2: Docker compose down if applicable
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:docker');
        const dockerWarning = await dockerComposeDown(workspace.path);
        if (dockerWarning) {
          warnings.push(dockerWarning);
        }

        // Step 3: jj workspace forget
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:forget_workspace');
        try {
          await execFile('jj', ['workspace', 'forget', workspace.name, '-R', mainRepoPath]);
        } catch (err) {
          if (!isAlreadyForgotten(err)) {
            warnings.push(`jj workspace forget failed: ${err.message}`);
          }
        }

        // Step 4: Remove workspace directory (async - can take seconds for large
        // trees like node_modules, so we must not block the event loop here)
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:directory');
        try {
          await rm(workspace.path, { recursive: true, force: true });
        } catch (err) {
          warnings.push(`Directory cleanup failed: ${err.message}`);
        }

        // Step 4.5: Archive session transcripts before Claude folder is deleted
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:transcripts');
        const allSessions = db.prepare('SELECT * FROM sessions WHERE workspace_id = ?').all(workspaceId);
        for (const sess of allSessions) {
          if (sess.claude_project_dir && !sess.transcript_path) {
            try {
              archiveTranscript(sess.id, sess.claude_project_dir, sess.started_at, sess.ended_at);
            } catch (err) {
              warnings.push(`Transcript archive failed for ${sess.id}: ${err.message}`);
            }
          }
        }

        // Step 5: Clean up Claude project memory symlink
        updateWorkspaceOperation(workspaceId, 'destroying', 'destroy:claude_project');
        try {
          const claudeProjects = expandPath('~/.claude/projects');
          const wsKey = toClaudeProjectKey(workspace.path);
          const wsProjectDir = resolve(claudeProjects, wsKey);
          await rm(wsProjectDir, { recursive: true, force: true });
        } catch (err) {
          warnings.push(`Claude memory cleanup failed: ${err.message}`);
        }

        if (warnings.length > 0) {
          updateWorkspaceOperation(workspaceId, 'error', 'destroy:incomplete', warnings.join('; '));
        } else {
          updateWorkspaceOperation(workspaceId, 'destroyed', 'destroy:complete', null, {
            status: 'destroyed',
            destroyed_at: new Date().toISOString(),
            pr_id: null,
            repo: workspaceRepo,
          });
        }
        emitLocalChange();
        return { ok: warnings.length === 0, warnings };
      },
    );
  } catch (error) {
    updateWorkspaceOperation(workspaceId, 'error', 'destroy:failed', error.message);
    emitLocalChange();
    throw error;
  }
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
