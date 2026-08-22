import { appEvents } from './app-events.js';
import { ClaudeCapabilityService } from './claude-capability.js';
import { createClaudeReviewService } from './claude-review.js';
import { CodexCapabilityService } from './codex-capability.js';
import { createCodexReviewService } from './codex-review.js';
import { getCurrentConfig, updateConfig } from './config.js';
import { getDb } from './db.js';
import { PeerReviewCoordinator } from './peer-review-coordinator.js';
import {
  fetchPRBodyHtml,
  getGhRateLimitState,
  getPollerStatus,
  pollerEvents,
  refreshSinglePR,
  triggerPoll,
} from './poller.js';
import { dispatchToSession, getSessionPeerReviewReadiness, getSessionStates, waitForFirstIdle } from './pty-manager.js';
import { createWorkItemService } from './work-items.js';

/**
 * Construct the runtime dependencies used by the HTTP boundary. Defaults keep
 * production behavior unchanged while tests and future service extractions can
 * provide isolated implementations.
 */
export function createAppContext(overrides = {}) {
  const events = overrides.appEvents ?? appEvents;
  const claudeCapability =
    overrides.claudeCapability ?? overrides.providerCapabilities?.claude ?? new ClaudeCapabilityService();
  const codexCapability =
    overrides.codexCapability ?? overrides.providerCapabilities?.codex ?? new CodexCapabilityService();
  const providerCapabilities = Object.freeze({ claude: claudeCapability, codex: codexCapability });
  const peerReviewCoordinator = overrides.peerReviewCoordinator ?? new PeerReviewCoordinator({ events });
  const claudeReviewService =
    overrides.claudeReviewService ??
    overrides.reviewServices?.claude ??
    createClaudeReviewService({ capability: claudeCapability });
  const codexReviewService =
    overrides.codexReviewService ??
    overrides.reviewServices?.codex ??
    createCodexReviewService({ capability: codexCapability });
  const reviewServices = Object.freeze({ claude: claudeReviewService, codex: codexReviewService });
  const sessionStates = overrides.getSessionStates ?? getSessionStates;
  const workItemService =
    overrides.workItemService ??
    createWorkItemService({
      getConfig: overrides.getConfig ?? getCurrentConfig,
      providerCapabilities,
      getSessionStates: sessionStates,
      resolver: overrides.workItemResolver,
    });

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
    getSessionStates: sessionStates,
    dispatchToSession,
    waitForFirstIdle,
    getSessionPeerReviewReadiness,
    providerCapabilities,
    peerReviewCoordinator,
    reviewServices,
    workItemService,
    ...overrides,
  });
}
