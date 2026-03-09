import { getDb } from '../db.js';

/**
 * Register PR-related routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerPRRoutes(app) {
  app.get('/api/prs', (request) => {
    const db = getDb();
    const { org, repo, draft, ci, review } = request.query;

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

    const rows = db.prepare(sql + ' ORDER BY updated_at DESC').all(...params);

    // Format all rows (parse JSON once per row), then post-filter
    let prs = rows.map(formatPR);

    if (ci) {
      prs = prs.filter(pr => pr.ci_status === ci);
    }
    if (review) {
      prs = prs.filter(pr => pr.review_status === review);
    }

    const syncRow = db.prepare('SELECT MAX(synced_at) as synced_at FROM prs').get();
    return { prs, synced_at: syncRow?.synced_at ?? null };
  });

  app.get('/api/prs/:id', (request, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(request.params.id);
    if (!row) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return formatPR(row);
  });
}

/**
 * Format a PR row for the API response (parse JSON columns once).
 * @param {object} row
 * @returns {object}
 */
function formatPR(row) {
  const checks = JSON.parse(row.checks);
  const reviews = JSON.parse(row.reviews);
  return {
    ...row,
    draft: Boolean(row.draft),
    checks,
    reviews,
    labels: JSON.parse(row.labels),
    ci_status: deriveCIStatus(checks),
    review_status: deriveReviewStatus(reviews),
  };
}

/**
 * Derive overall CI status from checks array.
 * @param {Array<{status: string, conclusion: string | null}>} checks
 * @returns {'pass' | 'fail' | 'pending'}
 */
function deriveCIStatus(checks) {
  if (checks.length === 0) return 'pending';
  const hasFailure = checks.some(c =>
    c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'TIMED_OUT'
  );
  if (hasFailure) return 'fail';
  const allDone = checks.every(c =>
    c.status === 'COMPLETED' && (c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED')
  );
  if (allDone) return 'pass';
  return 'pending';
}

/**
 * Derive overall review status from reviews array.
 * @param {Array<{state: string}>} reviews
 * @returns {'approved' | 'changes_requested' | 'pending'}
 */
function deriveReviewStatus(reviews) {
  if (reviews.length === 0) return 'pending';
  const byReviewer = new Map();
  for (const r of reviews) {
    byReviewer.set(r.reviewer, r.state);
  }
  const states = [...byReviewer.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return 'pending';
}
