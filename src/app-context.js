import { appEvents } from './app-events.js';
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
import { getSessionStates } from './pty-manager.js';

/**
 * Construct the runtime dependencies used by the HTTP boundary. Defaults keep
 * production behavior unchanged while tests and future service extractions can
 * provide isolated implementations.
 */
export function createAppContext(overrides = {}) {
  return Object.freeze({
    getConfig: getCurrentConfig,
    getDb,
    updateConfig,
    triggerPoll,
    refreshSinglePR,
    fetchPRBodyHtml,
    getPollerStatus,
    appEvents,
    pollerEvents,
    getGhRateLimitState,
    getSessionStates,
    ...overrides,
  });
}
