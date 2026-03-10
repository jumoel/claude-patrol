import { getDb } from '../db.js';
import { createWorkspace, destroyWorkspace } from '../workspace.js';
import { formatPR } from '../pr-status.js';
import { getCurrentConfig } from '../config.js';

/**
 * Register workspace routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerWorkspaceRoutes(app) {

  app.post('/api/workspaces', async (request, reply) => {
    const { pr_id } = request.body || {};
    if (!pr_id) {
      return reply.code(400).send({ error: 'pr_id is required' });
    }
    try {
      const workspace = await createWorkspace(pr_id, getCurrentConfig());
      return reply.code(201).send(workspace);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get('/api/workspaces', (request) => {
    const db = getDb();
    const { pr_id, status, repo } = request.query;

    let sql = 'SELECT w.* FROM workspaces w';
    const params = [];

    if (repo) {
      sql += ' JOIN prs p ON w.pr_id = p.id';
    }

    sql += ' WHERE 1=1';

    if (status) {
      sql += ' AND w.status = ?';
      params.push(status);
    } else {
      sql += " AND w.status = 'active'";
    }
    if (pr_id) {
      sql += ' AND w.pr_id = ?';
      params.push(pr_id);
    }
    if (repo) {
      sql += ' AND p.repo = ?';
      params.push(repo);
    }

    return db.prepare(sql).all(...params);
  });

  app.delete('/api/workspaces/:id', async (request, reply) => {
    try {
      const result = await destroyWorkspace(request.params.id, getCurrentConfig());
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/api/workspaces/cleanup', async (request, reply) => {
    const { ci, review, mergeable, repo } = request.body || {};
    const db = getDb();

    // Get all active workspaces joined with their PRs
    const rows = db.prepare(`
      SELECT w.id AS workspace_id, p.id, p.number, p.title, p.repo, p.org, p.author, p.url, p.branch, p.draft, p.mergeable, p.checks, p.reviews, p.labels, p.created_at, p.updated_at, p.synced_at
      FROM workspaces w
      JOIN prs p ON w.pr_id = p.id
      WHERE w.status = 'active'
    `).all();

    const matched = [];
    for (const row of rows) {
      const pr = formatPR(row);
      if (ci && pr.ci_status !== ci) continue;
      if (review && pr.review_status !== review) continue;
      if (mergeable && pr.mergeable !== mergeable.toUpperCase()) continue;
      if (repo && pr.repo !== repo) continue;
      matched.push({ workspace_id: row.workspace_id, pr_id: pr.id });
    }

    if (matched.length === 0) {
      return { ok: true, destroyed: 0, workspaces: [] };
    }

    const results = [];
    for (const { workspace_id, pr_id } of matched) {
      try {
        await destroyWorkspace(workspace_id, getCurrentConfig());
        results.push({ workspace_id, pr_id, status: 'destroyed' });
      } catch (err) {
        results.push({ workspace_id, pr_id, status: 'error', message: err.message });
      }
    }

    return { ok: true, destroyed: results.filter(r => r.status === 'destroyed').length, workspaces: results };
  });

}
