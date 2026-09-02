import { execFileSync } from 'node:child_process';

/**
 * tmux is the durable process tree behind every Patrol session: the agent
 * runs inside a tmux session named after the Patrol session id, and node-pty
 * attaches to it. These helpers are the only place that spells that name or
 * shells out to tmux for lifecycle checks.
 */

/** @param {string} sessionId */
export function tmuxSessionName(sessionId) {
  return `patrol-${sessionId}`;
}

/**
 * Whether the tmux session for a Patrol session is running.
 * @param {string} sessionId
 * @param {{ execFileSync?: typeof execFileSync }} [runtime]
 */
export function isTmuxSessionAlive(sessionId, { execFileSync: exec = execFileSync } = {}) {
  try {
    exec('tmux', ['has-session', '-t', tmuxSessionName(sessionId)], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill the tmux session for a Patrol session. Throws when tmux reports a
 * failure; callers decide whether an already-gone session is an error.
 * @param {string} sessionId
 * @param {{ execFileSync?: typeof execFileSync, timeout?: number }} [runtime]
 */
export function killTmuxSession(sessionId, { execFileSync: exec = execFileSync, timeout = 5000 } = {}) {
  exec('tmux', ['kill-session', '-t', tmuxSessionName(sessionId)], { timeout });
}

/**
 * Names of every tmux session Patrol created, from `tmux list-sessions`.
 * Returns an empty list when tmux is not running.
 * @param {{ execFileSync?: typeof execFileSync }} [runtime]
 * @returns {string[]}
 */
export function listPatrolTmuxSessions({ execFileSync: exec = execFileSync } = {}) {
  try {
    const output = exec('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', timeout: 5000 });
    return String(output)
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith('patrol-'));
  } catch {
    return [];
  }
}
