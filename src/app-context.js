import { appEvents } from './app-events.js';
import { CodexCapabilityService } from './codex-capability.js';
import { createCodexReviewService } from './codex-review.js';
import { CodexReviewCoordinator } from './codex-review-coordinator.js';
import { getCurrentConfig, updateConfig } from './config.js';
import { getDb } from './db.js';
import {
  fetchPRBodyHtml,
  getGhRateLimitState,
  getPollerStatus,
  pollerEvents,
  refreshSinglePR,
  triggerPoll,
} from './poller.js';
import {
  dispatchToSession,
  getSessionCodexReviewReadiness,
  getSessionStates,
  waitForFirstIdle,
} from './pty-manager.js';

/**
 * Construct the runtime dependencies used by the HTTP boundary. Defaults keep
 * production behavior unchanged while tests and future service extractions can
 * provide isolated implementations.
 */
export function createAppContext(overrides = {}) {
  const events = overrides.appEvents ?? appEvents;
  const codexCapability = overrides.codexCapability ?? new CodexCapabilityService();
  const codexReviewCoordinator = overrides.codexReviewCoordinator ?? new CodexReviewCoordinator({ events });
  const codexReviewService = overrides.codexReviewService ?? createCodexReviewService({ capability: codexCapability });

  return Object.freeze({
    getConfig: getCurrentConfig,
    getDb,
    updateConfig,
    triggerPoll,
    refreshSinglePR,
    fetchPRBodyHtml,
    getPollerStatus,
    appEvents: events,
    pollerEvents,
    getGhRateLimitState,
    getSessionStates,
    dispatchToSession,
    waitForFirstIdle,
    getSessionCodexReviewReadiness,
    codexCapability,
    codexReviewCoordinator,
    codexReviewService,
    ...overrides,
  });
}
