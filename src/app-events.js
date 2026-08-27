import { EventEmitter } from 'node:events';

/**
 * App-wide event bus for local state changes (workspace/session mutations).
 * Emits 'local-change' when workspace or session state changes, so the
 * SSE layer can push updates to clients without waiting for a GitHub sync.
 * Emits 'session-state' when a session's activity state changes.
 *
 * The HTTP layer attaches one listener per event type and broadcasts to all
 * connected tabs, so listener counts stay constant as clients come and go.
 */
export const appEvents = new EventEmitter();

/** Notify clients that local workspace/session state changed. */
export function emitLocalChange() {
  appEvents.emit('local-change');
}

/**
 * Notify clients of a session state change.
 * @param {string} sessionId
 * @param {{type: 'global'} | {type: 'workspace'|'work_item', id: string}} target
 * @param {'working' | 'idle' | 'exited'} state
 * @param {string | null} [activityChangedAt]
 * @param {{confirmed?: boolean, outcome?: string|null, source?: string|null}} [details]
 */
export function emitSessionState(sessionId, target, state, activityChangedAt = null, details = {}) {
  appEvents.emit('session-state', {
    sessionId,
    target,
    workspaceId: target.type === 'workspace' ? target.id : null,
    workItemId: target.type === 'work_item' ? target.id : null,
    state,
    activity_changed_at: activityChangedAt,
    ...(details.confirmed === undefined ? {} : { confirmed: details.confirmed }),
    ...(details.outcome === undefined ? {} : { completion_outcome: details.outcome }),
    ...(details.source === undefined ? {} : { activity_source: details.source }),
  });
}

/**
 * Notify clients that the gh rate-limit state changed.
 * @param {{limited: boolean, message: string | null, detectedAt: string | null, resetAt: string | null}} state
 */
export function emitGhRateLimit(state) {
  appEvents.emit('gh-rate-limit', state);
}
