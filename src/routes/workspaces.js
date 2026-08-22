import { execFile as execFileCb } from 'node:child_process';
import { emitLocalChange } from '../app-events.js';
import { formatPR } from '../pr-status.js';
import { runTask } from '../tasks.js';
import { createScratchWorkspace, createWorkspace, destroyWorkspace } from '../workspace.js';

/**
 * Register workspace routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerWorkspaceRoutes(app) {
  const { getConfig, getDb } = app.appContext;
  app.post('/api/workspaces', async (request, reply) => {
    const { pr_id, repo, branch } = request.body || {};
    if (!pr_id && (!repo || !branch)) {
      return reply.code(400).send({ error: 'Either pr_id or both repo and branch are required' });
    }
    try {
      const workspace = pr_id
        ? await createWorkspace(pr_id, getConfig())
        : await createScratchWorkspace(repo, branch, getConfig());
      emitLocalChange();
      return reply.code(201).send(workspace);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get('/api/workspaces', (request) => {
    const db = getDb();
    const { pr_id, status, repo, type } = request.query;

    let sql = 'SELECT w.* FROM workspaces w';
    const params = [];

    if (repo) {
      sql += ' LEFT JOIN prs p ON w.pr_id = p.id';
    }

    sql += ' WHERE w.work_item_id IS NULL';

    if (status) {
      sql += ' AND w.status = ?';
      params.push(status);
      if (status === 'active') sql += " AND w.operation_state = 'ready'";
    } else {
      sql += " AND w.status = 'active' AND w.operation_state = 'ready'";
    }
    if (pr_id) {
      sql += ' AND w.pr_id = ?';
      params.push(pr_id);
    }
    if (type === 'scratch') {
      sql += ' AND w.pr_id IS NULL';
    } else if (type === 'pr') {
      sql += ' AND w.pr_id IS NOT NULL';
    }
    if (repo) {
      sql += ' AND (p.repo = ? OR w.repo = ?)';
      params.push(repo, repo);
    }

    return db.prepare(sql).all(...params);
  });

  app.get('/api/workspaces/operations', () => {
    return getDb()
      .prepare(
        "SELECT * FROM workspaces WHERE work_item_id IS NULL AND operation_state NOT IN ('ready', 'destroyed') ORDER BY operation_updated_at DESC",
      )
      .all();
  });

  app.get('/api/workspaces/:id', (request, reply) => {
    const db = getDb();
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(request.params.id);
    if (!workspace) {
      return reply.code(404).send({ error: 'Workspace not found' });
    }
    if (workspace.work_item_id) {
      return reply
        .code(409)
        .send({ error: 'Work-item child is managed by its work item', code: 'work_item_child_managed' });
    }
    return workspace;
  });

  app.delete('/api/workspaces/:id', async (request, reply) => {
    try {
      const result = await destroyWorkspace(request.params.id, getConfig());
      emitLocalChange();
      return result;
    } catch (err) {
      return reply
        .code(err.code === 'work_item_child_managed' ? 409 : 400)
        .send({ error: err.message, code: err.code });
    }
  });

  app.post('/api/workspaces/:id/retry-cleanup', async (request, reply) => {
    const workspace = getDb().prepare('SELECT * FROM workspaces WHERE id = ?').get(request.params.id);
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' });
    if (workspace.work_item_id) {
      return reply
        .code(409)
        .send({ error: 'Work-item child is managed by its work item', code: 'work_item_child_managed' });
    }
    if (['ready', 'destroyed'].includes(workspace.operation_state)) {
      return reply.code(409).send({ error: 'Workspace does not have an interrupted operation to clean up' });
    }
    try {
      return await destroyWorkspace(request.params.id, getConfig());
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post('/api/workspaces/:id/terminal', (request, reply) => {
    const db = getDb();
    const candidate = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(request.params.id);
    if (candidate?.work_item_id) {
      return reply
        .code(409)
        .send({ error: 'Work-item child is managed by its work item', code: 'work_item_child_managed' });
    }
    const workspace = candidate?.status === 'active' && candidate.operation_state === 'ready' ? candidate : null;
    if (!workspace) {
      return reply.code(404).send({ error: 'Workspace not found or not active' });
    }
    execFileCb('open', ['-na', 'Ghostty.app', '--args', '--working-directory', workspace.path], (err) => {
      if (err) console.warn(`[workspaces] Failed to open Ghostty: ${err.message}`);
    });
    return { ok: true };
  });

  app.post('/api/workspaces/cleanup', async (request, _reply) => {
    const { ci, review, mergeable, repo } = request.body || {};
    const db = getDb();

    // Get all active workspaces joined with their PRs
    const rows = db
      .prepare(`
      SELECT w.id AS workspace_id, p.id, p.number, p.title, p.repo, p.org, p.author, p.url, p.branch, p.draft, p.mergeable, p.checks, p.reviews, p.labels, p.created_at, p.updated_at, p.synced_at
      FROM workspaces w
      JOIN prs p ON w.pr_id = p.id
      WHERE w.work_item_id IS NULL AND w.status = 'active' AND w.operation_state = 'ready'
    `)
      .all();

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

    const filterParts = [
      ci && `ci=${ci}`,
      review && `review=${review}`,
      mergeable && `mergeable=${mergeable}`,
      repo && `repo=${repo}`,
    ].filter(Boolean);
    const filterLabel = filterParts.length > 0 ? ` (${filterParts.join(', ')})` : '';

    return runTask(
      {
        kind: 'workspace.cleanup',
        label: `Cleanup ${matched.length} workspaces${filterLabel}`,
        context: { count: matched.length, filter: { ci, review, mergeable, repo } },
      },
      async () => {
        const results = [];
        const warnings = [];
        for (const { workspace_id, pr_id } of matched) {
          try {
            const result = await destroyWorkspace(workspace_id, getConfig());
            if (result.ok) {
              results.push({ workspace_id, pr_id, status: 'destroyed' });
            } else {
              const message = result.warnings.join('; ') || 'Workspace cleanup was incomplete';
              results.push({ workspace_id, pr_id, status: 'error', message });
              warnings.push(`${pr_id}: ${message}`);
            }
          } catch (err) {
            results.push({ workspace_id, pr_id, status: 'error', message: err.message });
            warnings.push(`${pr_id}: ${err.message}`);
          }
        }

        if (results.some((r) => r.status === 'destroyed')) emitLocalChange();
        return {
          ok: true,
          destroyed: results.filter((r) => r.status === 'destroyed').length,
          workspaces: results,
          warnings,
        };
      },
    );
  });
}
