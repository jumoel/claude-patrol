import { resolve } from 'node:path';
import { homedir } from 'node:os';

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
