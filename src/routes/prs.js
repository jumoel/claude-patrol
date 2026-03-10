import { getDb } from '../db.js';
import { formatPR } from '../pr-status.js';

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
