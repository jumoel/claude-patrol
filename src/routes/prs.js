import { emitLocalChange } from '../app-events.js';
import { getDb } from '../db.js';
import { fetchPRBodyHtml } from '../poller.js';
import { enrichWithStackInfo, formatPR } from '../pr-status.js';
import { execFile } from '../utils.js';

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

    // Enrich with workspace/session indicators
    const activeWorkspaceRows = db.prepare("SELECT id, pr_id FROM workspaces WHERE status = 'active'").all();
    const activeWorkspaces = new Set(activeWorkspaceRows.map((r) => r.pr_id));
    const prWorkspaceMap = Object.fromEntries(activeWorkspaceRows.filter((r) => r.pr_id).map((r) => [r.pr_id, r.id]));
    const activeSessions = new Set(
      db
        .prepare("SELECT w.pr_id FROM sessions s JOIN workspaces w ON s.workspace_id = w.id WHERE s.status = 'active'")
        .all()
        .map((r) => r.pr_id),
    );
    for (const pr of prs) {
      pr.has_workspace = activeWorkspaces.has(pr.id);
      pr.has_session = activeSessions.has(pr.id);
      pr.workspace_id = prWorkspaceMap[pr.id] || null;
    }

    const syncRow = db.prepare('SELECT MAX(synced_at) as synced_at FROM prs').get();
    return { prs, synced_at: syncRow?.synced_at ?? null };
  });

  app.get('/api/prs/:id', async (request, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(request.params.id);
    if (!row) {
      return reply.code(404).send({ error: 'Not found' });
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
    const target = siblings.find((p) => p.id === request.params.id);
    // siblings re-read from DB above, so override with the freshly-fetched html
    if (target && row.body_html) target.body_html = row.body_html;
    return target;
  });

  app.post('/api/prs/:id/draft', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number, draft FROM prs WHERE id = ?').get(request.params.id);
    if (!pr) {
      return reply.code(404).send({ error: 'PR not found' });
    }
    const { draft } = request.body || {};
    if (typeof draft !== 'boolean') {
      return reply.code(400).send({ error: 'draft must be a boolean' });
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
      return reply.code(500).send({ error: `Failed to update draft status: ${err.stderr || err.message}` });
    }
  });

  app.get('/api/prs/:id/diff', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number, updated_at FROM prs WHERE id = ?').get(request.params.id);
    if (!pr) {
      return reply.code(404).send({ error: 'PR not found' });
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
      return reply.code(500).send({ error: `Failed to fetch diff: ${err.message}` });
    }
  });
}
