import { getDb } from '../db.js';
import { formatPR } from '../pr-status.js';
import { execFile } from '../utils.js';

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

  app.get('/api/prs/:id/diff', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number FROM prs WHERE id = ?').get(request.params.id);
    if (!pr) {
      return reply.code(404).send({ error: 'PR not found' });
    }

    const nameOnly = request.query.name_only === 'true';
    const args = ['pr', 'diff', String(pr.number), '-R', `${pr.org}/${pr.repo}`];
    if (nameOnly) args.push('--name-only');

    try {
      const { stdout } = await execFile('gh', args, {
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      if (nameOnly) {
        return {
          files: stdout.trim().split('\n').filter(Boolean),
          pr_number: pr.number,
          repo: `${pr.org}/${pr.repo}`,
        };
      }

      const truncated = stdout.length > 100_000;
      return {
        diff: truncated ? stdout.slice(0, 100_000) : stdout,
        truncated,
        pr_number: pr.number,
        repo: `${pr.org}/${pr.repo}`,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to fetch diff: ${err.message}` });
    }
  });
}
