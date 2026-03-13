import { execFile, execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(__dirname);

/** Git SHA captured at process startup - never changes. */
const startupSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_DIR, timeout: 5_000 }).toString().trim();

let updateAvailable = false;
let remoteCommitCount = 0;
let checkInterval = null;
let restartPhase = null;

/**
 * Get the current restart phase, or null if no restart in progress.
 * @returns {{ phase: string, started_at: string } | null}
 */
export function getRestartStatus() {
  return restartPhase;
}

/**
 * Run git fetch and compare local HEAD with remote.
 */
function checkForUpdates() {
  // Fetch latest from origin (quiet, no output)
  execFile('git', ['fetch', '--quiet'], { cwd: REPO_DIR, timeout: 15_000 }, (err) => {
    if (err) {
      // Fetch failed (no network, etc) - keep previous state
      return;
    }
    // Compare local HEAD with origin/main
    execFile('git', ['rev-list', '--count', 'HEAD..origin/main'], { cwd: REPO_DIR, timeout: 5_000 }, (err, stdout) => {
      if (err) return;
      const count = parseInt(stdout.trim(), 10);
      updateAvailable = count > 0;
      remoteCommitCount = count;
      if (updateAvailable) {
        console.log(`[update-check] ${count} new commit(s) available on origin/main`);
      }
    });
  });
}

/**
 * Start periodic update checks.
 * @param {number} intervalMs - check interval (default 10 minutes)
 */
export function startUpdateChecks(intervalMs = 600_000) {
  stopUpdateChecks();
  checkForUpdates();
  checkInterval = setInterval(checkForUpdates, intervalMs);
}

/**
 * Stop periodic update checks.
 */
export function stopUpdateChecks() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

/**
 * Get current on-disk SHA (re-reads every call so it picks up pulls).
 * @returns {string}
 */
function currentSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_DIR, timeout: 5_000 }).toString().trim();
  } catch {
    return startupSha; // fallback if git fails
  }
}

export function getUpdateStatus() {
  const onDisk = currentSha();
  return {
    update_available: updateAvailable,
    commits_behind: remoteCommitCount,
    startup_sha: startupSha,
    current_sha: onDisk,
    restart_needed: onDisk !== startupSha,
  };
}

/**
 * Run git pull in the repo directory.
 * @returns {Promise<{ ok: boolean, output?: string, error?: string }>}
 */
export function pullUpdate() {
  return new Promise((resolve) => {
    execFile('git', ['pull', '--ff-only', 'origin', 'main'], { cwd: REPO_DIR, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: (stderr || err.message).trim() });
        return;
      }
      updateAvailable = false;
      remoteCommitCount = 0;
      resolve({ ok: true, output: stdout.trim() });
    });
  });
}

/**
 * Restart the server process. Rebuilds the frontend, spawns a new instance
 * with --reattach so terminal sessions survive, then exits the current process.
 */
export function restartServer() {
  const entryPoint = join(REPO_DIR, 'src', 'index.js');
  restartPhase = { phase: 'building', started_at: new Date().toISOString() };
  console.log('[restart] Rebuilding frontend...');
  // Capture build output and pipe through console.log so it appears in the TUI
  const build = spawn('pnpm', ['--filter', 'claude-patrol-frontend', 'build'], {
    cwd: REPO_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const logLines = (stream, level) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (line.trim()) console[level](`[build] ${line}`);
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) console[level](`[build] ${buffer}`);
    });
  };
  logLines(build.stdout, 'log');
  logLines(build.stderr, 'warn');
  build.on('close', (code) => {
    if (code !== 0) {
      console.warn(`[restart] Frontend build exited with code ${code}, starting anyway`);
    } else {
      console.log('[restart] Frontend build complete');
    }
    restartPhase = { phase: 'spawning', started_at: new Date().toISOString() };
    console.log('[restart] Spawning new server with --reattach...');
    const child = spawn(process.execPath, [entryPoint, '--reattach'], {
      cwd: REPO_DIR,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    restartPhase = { phase: 'shutting_down', started_at: new Date().toISOString() };
    // Give the new process time to start before exiting
    setTimeout(() => process.exit(0), 500);
  });
}
