/**
 * In-memory state shared by the session modules: live PTY entries, provider
 * activity credentials, in-flight transcript archives and the status-poll
 * bookkeeping. One module owns these Maps so tests can reset them between
 * cases instead of depending on each other's cleanup.
 */

/**
 * @typedef {object} SessionEntry
 * @property {import('node-pty').IPty} proc
 * @property {import('./terminal-buffer.js').RingBuffer} buffer
 * @property {Set<import('ws').WebSocket>} websockets
 * @property {import('./terminal-buffer.js').TerminalOutputBatcher} output
 * @property {import('./session-activity.js').SessionActivityTracker} [activity]
 */

/** @type {Map<string, SessionEntry>} */
export const sessions = new Map();

/** @type {Map<string, {provider: 'claude'|'codex', token: string}>} */
export const activityCredentials = new Map();

/** Transcript archives scheduled by PTY exit handlers and not yet finished. */
export const pendingArchives = new Set();

/** Sessions whose provider-owned status surface should be polled. */
export const sessionsAwaitingProviderStatus = new Set();

/** Monotonic counter per session so a stale poll result cannot apply. */
export const providerStatusGenerations = new Map();

/**
 * Forget every live session without touching tmux or the database. For tests
 * only: production code closes sessions through killSession, whose PTY exit
 * handler removes the entries.
 */
export function resetSessionRegistryForTests() {
  for (const entry of sessions.values()) {
    try {
      entry.activity?.dispose();
    } catch {
      // A tracker without timers has nothing to dispose.
    }
  }
  sessions.clear();
  activityCredentials.clear();
  pendingArchives.clear();
  sessionsAwaitingProviderStatus.clear();
  providerStatusGenerations.clear();
}
