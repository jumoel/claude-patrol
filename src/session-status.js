import { getDb } from './db.js';
import { pollProviderSessionStatuses } from './provider-status-poller.js';
import { providerStatusGenerations, sessions, sessionsAwaitingProviderStatus } from './session-registry.js';

/**
 * Provider-owned status polling: Codex exposes completion notifications but
 * no turn-start event, and Claude's pane title is the only signal for some
 * transitions, so sessions that asked for it are polled on a shared timer
 * and the results are fed into each entry's activity tracker.
 */

export const SESSION_STATUS_POLL_INTERVAL_MS = 1_000;
let sessionStatusPollingEnabled = false;
let sessionStatusPollTimer = null;
let sessionStatusPollInFlight = null;

export function requestProviderStatus(sessionId, delay = 0) {
  sessionsAwaitingProviderStatus.add(sessionId);
  providerStatusGenerations.set(sessionId, (providerStatusGenerations.get(sessionId) ?? 0) + 1);
  scheduleSessionStatusPoll(delay);
}

export function stopProviderStatusTracking(sessionId) {
  sessionsAwaitingProviderStatus.delete(sessionId);
  providerStatusGenerations.delete(sessionId);
}

function scheduleSessionStatusPoll(delay = SESSION_STATUS_POLL_INTERVAL_MS) {
  if (!sessionStatusPollingEnabled || sessionStatusPollTimer !== null || sessionStatusPollInFlight !== null) return;
  if (sessionsAwaitingProviderStatus.size === 0) return;
  sessionStatusPollTimer = setTimeout(async () => {
    sessionStatusPollTimer = null;
    try {
      await pollSessionStatuses();
    } catch (error) {
      console.warn(`[pty-manager] Session status poll failed: ${error.message}`);
    } finally {
      scheduleSessionStatusPoll();
    }
  }, delay);
  sessionStatusPollTimer.unref?.();
}

/**
 * Poll provider-owned status surfaces. Codex sessions stay subscribed while
 * idle because Codex exposes completion notifications but no turn-start event;
 * a queued follow-up turn is otherwise invisible after the first idle poll.
 */
export async function pollSessionStatuses({ probe = pollProviderSessionStatuses } = {}) {
  if (sessionStatusPollInFlight) return sessionStatusPollInFlight;
  const candidateGenerations = new Map();
  const candidateProviders = new Map();
  const candidates = [...sessionsAwaitingProviderStatus]
    .map((sessionId) => {
      const row = getDb().prepare('SELECT provider FROM sessions WHERE id = ?').get(sessionId);
      if (row) {
        candidateGenerations.set(sessionId, providerStatusGenerations.get(sessionId));
        candidateProviders.set(sessionId, row.provider);
      }
      return row ? { sessionId, provider: row.provider } : null;
    })
    .filter(Boolean);
  if (candidates.length === 0) return 0;

  sessionStatusPollInFlight = (async () => {
    const statuses = await probe(candidates);
    let applied = 0;
    for (const [sessionId, status] of statuses) {
      if (!sessionsAwaitingProviderStatus.has(sessionId)) continue;
      if (providerStatusGenerations.get(sessionId) !== candidateGenerations.get(sessionId)) continue;
      const entry = sessions.get(sessionId);
      if (!entry) {
        stopProviderStatusTracking(sessionId);
        continue;
      }
      if (candidateProviders.get(sessionId) === 'codex') {
        if (status.state === 'working') {
          entry.providerWorkingObserved = true;
        } else if (
          entry.activity.snapshot().activityState === 'working' &&
          !entry.providerWorkingObserved &&
          !entry.providerCompletionObserved
        ) {
          // An idle pane immediately after dispatch can still be showing the
          // state from before the prompt reached Codex. Keep polling until the
          // active turn or its completion notification has been observed.
          continue;
        }
      }
      entry.restoringPersistedIdle = entry.activity.snapshot().activityState === null && status.state !== 'working';
      try {
        entry.activity.handleStatusPoll(status);
      } finally {
        entry.restoringPersistedIdle = false;
      }
      applied++;
      if (status.state !== 'working' && candidateProviders.get(sessionId) !== 'codex') {
        stopProviderStatusTracking(sessionId);
      }
    }
    return applied;
  })().finally(() => {
    sessionStatusPollInFlight = null;
  });
  return sessionStatusPollInFlight;
}

export function startSessionStatusPolling() {
  sessionStatusPollingEnabled = true;
  scheduleSessionStatusPoll(0);
}

export async function stopSessionStatusPolling() {
  sessionStatusPollingEnabled = false;
  if (sessionStatusPollTimer !== null) clearTimeout(sessionStatusPollTimer);
  sessionStatusPollTimer = null;
  try {
    await sessionStatusPollInFlight;
  } catch {
    // The polling loop already reports probe failures.
  }
}
