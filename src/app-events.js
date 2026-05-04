import { EventEmitter } from 'node:events';

/**
 * App-wide event bus for local state changes (workspace/session mutations).
 * Emits 'local-change' when workspace or session state changes, so the
 * SSE layer can push updates to clients without waiting for a GitHub sync.
 * Emits 'session-state' when a session's activity state changes.
 *
 * Each /api/events SSE connection adds one listener per forwarded event type.
 * With ~6 forwarded events and the default cap of 10, around 10 open dashboard
 * tabs would trigger MaxListenersExceededWarning. Uncap to silence the noise -
 * connection lifetime is bounded by the request's close handler, so leaks
 * still surface as growing memory rather than warnings.
 */
export const appEvents = new EventEmitter();
appEvents.setMaxListeners(0);

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
 * Notify clients that the gh rate-limit state changed.
 * @param {{limited: boolean, message: string | null, detectedAt: string | null, resetAt: string | null}} state
 */
export function emitGhRateLimit(state) {
  appEvents.emit('gh-rate-limit', state);
}
