import { emitSummaryUpdated } from './app-events.js';
import { getDb } from './db.js';
import { getLatestAwaySummary } from './transcripts.js';

/**
 * Track in-flight summary scans per workspace. Scanning is cheap but we still
 * gate to avoid duplicate writes when several events fire in quick succession.
 */
const inFlight = new Set();

/**
 * Update a workspace's summary by scanning its transcripts for the most recent
 * Claude Code recap (system messages with `subtype: "away_summary"`). No model
 * calls - we use the recap text verbatim. Returns the summary string, or null
 * when there's no recap to surface yet.
 *
 * Summaries are only stored for *scratch* workspaces (pr_id IS NULL). For
 * PR-bound workspaces the dashboard already shows PR-level metadata, and this
 * keeps storage scoped to the place the summary actually renders.
 *
 * @param {string} workspaceId
 * @param {{ force?: boolean }} [_options] reserved; force is implicit because
 *   recap scans are cheap and idempotent.
 * @returns {Promise<string | null>}
 */
export async function generateSummary(workspaceId, _options = {}) {
  if (inFlight.has(workspaceId)) {
    console.log(`[summarizer] Skipping ${workspaceId} - already in flight`);
    return null;
  }

  const db = getDb();
  const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ? AND status = 'active'").get(workspaceId);
  if (!workspace) {
    console.log(`[summarizer] Skipping ${workspaceId} - workspace not found or not active`);
    return null;
  }

  if (workspace.pr_id) {
    // PR-bound workspaces get their context from the PR; we only summarize
    // scratch workspaces. If a previously-scratch workspace was adopted, the
    // existing summary stays in the DB but is not refreshed or rendered.
    return null;
  }

  inFlight.add(workspaceId);
  try {
    const recap = getLatestAwaySummary(workspaceId);
    if (!recap) {
      console.log(`[summarizer] No recap found for ${workspaceId}`);
      return null;
    }

    // Avoid pointless DB writes / event emits when the recap hasn't advanced.
    if (workspace.summary === recap.content && workspace.summary_updated_at === recap.timestamp) {
      return recap.content;
    }

    db.prepare('UPDATE workspaces SET summary = ?, summary_updated_at = ? WHERE id = ?').run(
      recap.content,
      recap.timestamp,
      workspaceId,
    );
    emitSummaryUpdated(workspaceId);
    console.log(`[summarizer] Updated summary for ${workspaceId} from recap (${recap.timestamp})`);
    return recap.content;
  } finally {
    inFlight.delete(workspaceId);
  }
}

/**
 * Schedule a summary refresh for a workspace. Non-blocking; fires and forgets.
 * @param {string} workspaceId
 */
export function scheduleSummary(workspaceId) {
  console.log(`[summarizer] scheduleSummary called for workspace ${workspaceId}`);
  generateSummary(workspaceId).catch((err) => {
    console.warn(`[summarizer] Unhandled error in generateSummary for ${workspaceId}: ${err.message}`);
  });
}
