import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = dirname(__dirname);

let updateAvailable = false;
let remoteCommitCount = 0;
let checkInterval = null;

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
 * Get current update status.
 * @returns {{ update_available: boolean, commits_behind: number }}
 */
export function getUpdateStatus() {
  return { update_available: updateAvailable, commits_behind: remoteCommitCount };
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
