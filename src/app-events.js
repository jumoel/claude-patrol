import { EventEmitter } from 'node:events';

/**
 * App-wide event bus for local state changes (workspace/session mutations).
 * Emits 'local-change' when workspace or session state changes, so the
 * SSE layer can push updates to clients without waiting for a GitHub sync.
 * Emits 'session-idle' when a session goes idle (no output for threshold).
 */
export const appEvents = new EventEmitter();

/** Notify clients that local workspace/session state changed. */
export function emitLocalChange() {
  appEvents.emit('local-change');
}

/**
 * Notify clients that a session has gone idle (waiting for input).
 * @param {string} sessionId
 * @param {string | null} workspaceId
 */
export function emitSessionIdle(sessionId, workspaceId) {
  appEvents.emit('session-idle', { sessionId, workspaceId });
}

/**
 * Notify clients that a session is active again (producing output).
 * @param {string} sessionId
 */
export function emitSessionActive(sessionId) {
  appEvents.emit('session-active', { sessionId });
}
