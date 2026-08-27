/**
 * Resolve the user-facing state for one live session.
 *
 * Backend idle means the process is not producing output. It only means
 * "waiting" until the current idle transition has been acknowledged.
 *
 * @param {import('../types').Session} session
 * @param {'working' | 'idle' | undefined} targetState
 * @param {Set<string>} acknowledgedSessionIds
 * @returns {'working' | 'waiting' | 'idle'}
 */
export function sessionAttentionState(session, targetState, acknowledgedSessionIds) {
  const activityState = targetState ?? session.activity_state;
  if (activityState === 'working') return 'working';
  if (activityState === 'idle' && !acknowledgedSessionIds.has(session.id)) return 'waiting';
  return 'idle';
}
