/**
 * Tracks which dashboard tab each connected browser is currently looking at.
 * The poller consults this before deciding whether to run the (expensive)
 * review-requested GitHub search - if nobody is on the reviews tab, that
 * fetch is skipped entirely.
 *
 * State is in-memory and per-client. Each browser tab generates a stable
 * clientId (kept in its sessionStorage) and POSTs to /api/active-tab on
 * mount, on tab change, and on a heartbeat. Entries expire after TTL_MS
 * without a heartbeat so a closed browser tab stops counting.
 */

const TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, {tab: string, expiresAt: number}>} */
const clients = new Map();

function prune(now = Date.now()) {
  for (const [id, entry] of clients) {
    if (entry.expiresAt <= now) clients.delete(id);
  }
}

/**
 * @param {string} clientId
 * @param {'authored' | 'reviews'} tab
 */
export function setActiveTab(clientId, tab) {
  if (!clientId) return;
  clients.set(clientId, { tab, expiresAt: Date.now() + TTL_MS });
}

/** True iff any non-expired client reports being on the reviews tab. */
export function hasReviewsViewer() {
  prune();
  for (const { tab } of clients.values()) {
    if (tab === 'reviews') return true;
  }
  return false;
}

/** For tests / debugging. */
export function _resetActiveTabs() {
  clients.clear();
}
