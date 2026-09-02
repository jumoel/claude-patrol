import { emitLocalChange } from '../app-events.js';
import { sendError } from '../http-errors.js';
import { enrichWithStackInfo, formatPR } from '../pr-status.js';
import { execFile } from '../utils.js';
import { enrichPullRequestsWithOwners } from '../work-item-prs.js';

/**
 * In-memory cache for /api/prs/:id/diff. Same shape as the comments cache:
 * keyed by pr_id, invalidated when updated_at changes or after the TTL,
 * whichever comes first. Separate maps for full vs name-only because the
 * frontend asks for both for the same PR.
 * @type {Map<string, {key: string, ts: number, data: object}>}
 */
const diffCache = new Map();
const diffNamesCache = new Map();
const DIFF_CACHE_TTL_MS = 60_000;
const DIFF_CACHE_MAX_ENTRIES = 100;

function lookupDiffCache(map, prId, key) {
  const cached = map.get(prId);
  if (!cached) return null;
  if (cached.key !== key) return null;
  if (Date.now() - cached.ts >= DIFF_CACHE_TTL_MS) return null;
  return cached.data;
}

function storeDiffCache(map, prId, key, data) {
  if (map.size >= DIFF_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(prId, { key, ts: Date.now(), data });
}

/**
 * Register PR-related routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerPRRoutes(app) {
  const { fetchPRBodyHtml, getConfig, getDb, getPollerStatus, refreshSinglePR } = app.appContext;
  app.get('/api/prs', (request) => {
    const db = getDb();
    const { org, repo, draft, ci, review, mergeable } = request.query;

    let sql = 'SELECT * FROM prs WHERE 1=1';
    const params = [];

    if (org) {
      sql += ' AND org = ?';
      params.push(org);
    }
    if (repo) {
      sql += ' AND repo = ?';
      params.push(repo);
    }
    if (draft !== undefined) {
      sql += ' AND draft = ?';
      params.push(draft === 'true' ? 1 : 0);
    }
    if (mergeable) {
      sql += ' AND mergeable = ?';
      params.push(mergeable.toUpperCase());
    }

    const rows = db.prepare(`${sql} ORDER BY updated_at DESC`).all(...params);

    // Format all rows (parse JSON once per row), then post-filter
    let prs = rows.map(formatPR);

    if (ci) {
      prs = prs.filter((pr) => pr.ci_status === ci);
    }
    if (review) {
      prs = prs.filter((pr) => pr.review_status === review);
    }

    // Enrich with stack relationships
    enrichWithStackInfo(prs);
    enrichPullRequestsWithOwners(prs, db);

    // Enrich with workspace/session indicators
    const activeWorkspaceRows = db
      .prepare(
        "SELECT id, pr_id FROM workspaces WHERE work_item_id IS NULL AND status = 'active' AND operation_state = 'ready'",
      )
      .all();
    const activeWorkspaces = new Set(activeWorkspaceRows.map((r) => r.pr_id));
    const prWorkspaceMap = Object.fromEntries(activeWorkspaceRows.filter((r) => r.pr_id).map((r) => [r.pr_id, r.id]));
    const activeSessions = new Set(
      db
        .prepare(
          "SELECT w.pr_id FROM sessions s JOIN workspaces w ON s.workspace_id = w.id WHERE s.status = 'active' AND w.work_item_id IS NULL AND w.operation_state = 'ready'",
        )
        .all()
        .map((r) => r.pr_id),
    );
    const activeWorkItemSessions = new Set(
      db
        .prepare("SELECT work_item_id FROM sessions WHERE work_item_id IS NOT NULL AND status = 'active'")
        .all()
        .map((row) => row.work_item_id),
    );
    for (const pr of prs) {
      if (pr.work_item_id) {
        pr.has_workspace = pr.work_item?.state !== 'destroyed';
        pr.has_session = activeWorkItemSessions.has(pr.work_item_id);
        pr.workspace_id = null;
      } else {
        pr.has_workspace = activeWorkspaces.has(pr.id);
        pr.has_session = activeSessions.has(pr.id);
        pr.workspace_id = prWorkspaceMap[pr.id] || null;
      }
    }

    const state = db.prepare('SELECT * FROM sync_state WHERE id = 1').get();
    const fallback = db.prepare('SELECT MAX(synced_at) AS synced_at FROM prs').get();
    const syncedAt = state?.synced_at ?? fallback?.synced_at ?? null;
    const config = getConfig();
    const stale = !syncedAt || Date.now() - Date.parse(syncedAt) > config.poll.interval_seconds * 2 * 1000;
    const pollStatus = getPollerStatus();
    return {
      prs,
      synced_at: syncedAt,
      freshness: {
        synced_at: syncedAt,
        stale,
        refreshing: pollStatus.active || pollStatus.pending,
      },
    };
  });

  app.get('/api/prs/:id', async (request, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(request.params.id);
    if (!row) {
      return sendError(reply, 'pr_not_found', 'PR not found');
    }

    // body_html isn't fetched in the poll cycle (heavy, only used here). Fetch
    // it on the first detail-view open for this PR (or after the body changed,
    // which clears the cached html in the poller). Failures degrade silently.
    if (!row.body_html) {
      const html = await fetchPRBodyHtml(row.org, row.repo, row.number);
      if (html != null) {
        db.prepare('UPDATE prs SET body_html = ? WHERE id = ?').run(html, row.id);
        row.body_html = html;
      }
    }

    // Format the target PR and all PRs in the same org/repo for stack computation
    const siblingRows = db.prepare('SELECT * FROM prs WHERE org = ? AND repo = ?').all(row.org, row.repo);
    const siblings = siblingRows.map(formatPR);
    enrichWithStackInfo(siblings);
    enrichPullRequestsWithOwners(siblings, db);
    const target = siblings.find((p) => p.id === request.params.id);
    // siblings re-read from DB above, so override with the freshly-fetched html
    if (target && row.body_html) target.body_html = row.body_html;
    return target;
  });

  app.post('/api/prs/:id/refresh', async (request, reply) => {
    const db = getDb();
    const exists = db.prepare('SELECT 1 FROM prs WHERE id = ?').get(request.params.id);
    if (!exists) {
      return sendError(reply, 'pr_not_found', 'PR not found');
    }
    let result;
    try {
      result = await refreshSinglePR(request.params.id, getConfig());
    } catch (err) {
      return sendError(reply, 'upstream_failed', `Failed to refresh PR: ${err.message}`);
    }
    // PR was merged/closed - row is gone, workspaces are torn down. Tell the
    // caller so the UI can navigate away and MCP callers see the final state.
    if (result.removed) {
      return { removed: true, state: result.state };
    }
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(request.params.id);
    if (!row) return sendError(reply, 'pr_not_found', 'PR not found after refresh');
    const siblingRows = db.prepare('SELECT * FROM prs WHERE org = ? AND repo = ?').all(row.org, row.repo);
    const siblings = siblingRows.map(formatPR);
    enrichWithStackInfo(siblings);
    enrichPullRequestsWithOwners(siblings, db);
    const target = siblings.find((p) => p.id === request.params.id);
    return target;
  });

  app.post('/api/prs/:id/draft', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number, draft FROM prs WHERE id = ?').get(request.params.id);
    if (!pr) {
      return sendError(reply, 'pr_not_found', 'PR not found');
    }
    const { draft } = request.body || {};
    if (typeof draft !== 'boolean') {
      return sendError(reply, 'invalid_request', 'draft must be a boolean');
    }
    try {
      const args = ['pr', 'ready', String(pr.number), '-R', `${pr.org}/${pr.repo}`];
      if (draft) args.push('--undo');
      await execFile('gh', args, { timeout: 15_000 });
      // Update local DB immediately so the UI reflects the change
      db.prepare('UPDATE prs SET draft = ? WHERE id = ?').run(draft ? 1 : 0, request.params.id);
      emitLocalChange();
      return { ok: true, draft };
    } catch (err) {
      return sendError(reply, 'upstream_failed', `Failed to update draft status: ${err.stderr || err.message}`);
    }
  });

  app.get('/api/prs/:id/diff', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number, updated_at FROM prs WHERE id = ?').get(request.params.id);
    if (!pr) {
      return sendError(reply, 'pr_not_found', 'PR not found');
    }

    const nameOnly = request.query.name_only === 'true';
    const cacheKey = pr.updated_at || '';
    const cacheMap = nameOnly ? diffNamesCache : diffCache;
    const hit = lookupDiffCache(cacheMap, request.params.id, cacheKey);
    if (hit) return hit;

    const args = ['pr', 'diff', String(pr.number), '-R', `${pr.org}/${pr.repo}`];
    if (nameOnly) args.push('--name-only');

    try {
      const { stdout } = await execFile('gh', args, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      let payload;
      if (nameOnly) {
        payload = {
          files: stdout.trim().split('\n').filter(Boolean),
          pr_number: pr.number,
          repo: `${pr.org}/${pr.repo}`,
        };
      } else {
        const truncated = stdout.length > 100_000;
        payload = {
          diff: truncated ? stdout.slice(0, 100_000) : stdout,
          truncated,
          pr_number: pr.number,
          repo: `${pr.org}/${pr.repo}`,
        };
      }
      storeDiffCache(cacheMap, request.params.id, cacheKey, payload);
      return payload;
    } catch (err) {
      return sendError(reply, 'upstream_failed', `Failed to fetch diff: ${err.message}`);
    }
  });
}
