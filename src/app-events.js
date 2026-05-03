import { EventEmitter } from 'node:events';

/**
 * App-wide event bus for local state changes (workspace/session mutations).
 * Emits 'local-change' when workspace or session state changes, so the
 * SSE layer can push updates to clients without waiting for a GitHub sync.
 * Emits 'session-state' when a session's activity state changes.
 */
export const appEvents = new EventEmitter();

/** Notify clients that local workspace/session state changed. */
export function emitLocalChange() {
  appEvents.emit('local-change');
}

/**
 * Notify clients of a session state change.
 * @param {string} sessionId
 * @param {string | null} workspaceId
 * @param {'working' | 'idle' | 'exited'} state
 */
export function emitSessionState(sessionId, workspaceId, state) {
  appEvents.emit('session-state', { sessionId, workspaceId: workspaceId ?? null, state });
}

/**
 * Notify clients that a workspace summary has been updated.
 * @param {string} workspaceId
 */
export function emitSummaryUpdated(workspaceId) {
  appEvents.emit('summary-updated', { workspaceId });
}

/**
 * Notify clients that the gh rate-limit state changed.
 * @param {{limited: boolean, message: string | null, detectedAt: string | null, resetAt: string | null}} state
 */
export function emitGhRateLimit(state) {
  appEvents.emit('gh-rate-limit', state);
}
