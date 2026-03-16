import { execFile as execFileCb } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

export const execFile = promisify(execFileCb);

/**
 * Resolve ~ to home directory in a path.
 * @param {string} p
 * @returns {string}
 */
export function expandPath(p) {
  if (p.startsWith('~/') || p === '~') {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/** @type {Set<string>} */
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT']);

/** @type {Set<string>} */
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * Check if a check conclusion represents a failure.
 * @param {string | null} conclusion
 * @returns {boolean}
 */
export function isFailedConclusion(conclusion) {
  return FAILED_CONCLUSIONS.has(conclusion);
}

/**
 * Check if a check conclusion represents a pass.
 * @param {string | null} conclusion
 * @returns {boolean}
 */
export function isPassedConclusion(conclusion) {
  return PASSED_CONCLUSIONS.has(conclusion);
}

/**
 * Build a PR ID string from org, repo, and number.
 * @param {string} org
 * @param {string} repo
 * @param {number} number
 * @returns {string}
 */
export function makePrId(org, repo, number) {
  return `${org}/${repo}#${number}`;
}

/**
 * Encode a filesystem path to a Claude project key.
 * Claude uses: replace all `/` and `.` with `-`.
 * e.g. /Users/foo/work/org/repo.js -> -Users-foo-work-org-repo-js
 * @param {string} fsPath
 * @returns {string}
 */
export function toClaudeProjectKey(fsPath) {
  return fsPath.replace(/[/.]/g, '-');
}
