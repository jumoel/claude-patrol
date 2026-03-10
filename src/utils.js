import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

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

/**
 * Check if a check conclusion represents a failure.
 * @param {string | null} conclusion
 * @returns {boolean}
 */
export function isFailedConclusion(conclusion) {
  return FAILED_CONCLUSIONS.has(conclusion);
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
