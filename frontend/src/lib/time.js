/**
 * Format a date string as relative time (e.g. "5m ago", "2h ago").
 * @param {string} dateStr
 * @returns {string}
 */
export function getRelativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a duration in milliseconds as a compact human string ("12m", "3h",
 * "2d"). Returns an empty string for non-positive durations.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Compute the weekday hours between two timestamps (Sat/Sun count as zero).
 * Uses UTC midnight boundaries.
 * @param {Date | number} start
 * @param {Date | number} end
 * @returns {number}
 */
function weekdayMillis(start, end) {
  let s = start instanceof Date ? start.getTime() : start;
  const e = end instanceof Date ? end.getTime() : end;
  if (!(e > s)) return 0;
  let total = 0;
  while (s < e) {
    const cur = new Date(s);
    const dayStart = Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate());
    const nextDay = dayStart + 24 * 60 * 60 * 1000;
    const chunkEnd = Math.min(nextDay, e);
    const wd = cur.getUTCDay(); // 0=Sun, 6=Sat
    if (wd !== 0 && wd !== 6) total += chunkEnd - s;
    s = chunkEnd;
  }
  return total;
}

/**
 * True for actors who aren't the PR author and aren't a GitHub bot. Uses the
 * GraphQL `__typename` when present (most reliable) and falls back to the
 * conventional `[bot]` suffix on the login.
 */
function isHumanActor(login, type, author) {
  if (!login || login === author) return false;
  if (type && type !== 'User') return false;
  if (!type && login.endsWith('[bot]')) return false;
  return true;
}

/**
 * Find the earliest human (non-author, non-bot) interaction on a PR -
 * counting both reviews and issue comments. Returns the ISO timestamp or
 * null if no qualifying interaction exists.
 *
 * Caveat: the poller fetches `reviews(first: 50)` and `comments(first: 50)`.
 * PRs with more than 50 of either may miss the earliest entry; in practice
 * essentially all PRs are well under that.
 *
 * @param {{ author: string, reviews?: Array<{reviewer: string, reviewer_type?: string, submitted_at: string}>, comments?: Array<{author: string, author_type?: string, created_at: string}> }} pr
 * @returns {string | null}
 */
export function firstHumanInteractionAt(pr) {
  const author = pr.author;
  let earliest = null;
  for (const r of pr.reviews ?? []) {
    if (!r.submitted_at) continue;
    if (!isHumanActor(r.reviewer, r.reviewer_type, author)) continue;
    if (earliest === null || r.submitted_at < earliest) earliest = r.submitted_at;
  }
  for (const c of pr.comments ?? []) {
    if (!c.created_at) continue;
    if (!isHumanActor(c.author, c.author_type, author)) continue;
    if (earliest === null || c.created_at < earliest) earliest = c.created_at;
  }
  return earliest;
}

/**
 * Weekday-milliseconds from PR creation to the first human interaction. For
 * PRs without one yet, counts forward to now so still-open PRs grow over
 * time. Returns null for drafts or PRs without `created_at`.
 *
 * @param {{ created_at: string, author: string, reviews?: object[], comments?: object[], draft?: boolean }} pr
 * @returns {{ ms: number, pending: boolean } | null}
 */
export function timeToFirstInteraction(pr) {
  if (!pr?.created_at) return null;
  if (pr.draft) return null;
  const start = new Date(pr.created_at).getTime();
  const firstIso = firstHumanInteractionAt(pr);
  if (firstIso) {
    return { ms: weekdayMillis(start, new Date(firstIso).getTime()), pending: false };
  }
  return { ms: weekdayMillis(start, Date.now()), pending: true };
}
