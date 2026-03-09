import { getDb } from '../db.js';
import { createWorkspace, destroyWorkspace } from '../workspace.js';

/**
 * Register workspace routes.
 * @param {import('fastify').FastifyInstance} app
 * @param {object} config
 */
export function registerWorkspaceRoutes(app, config) {
  let currentConfig = config;

  app.post('/api/workspaces', async (request, reply) => {
    const { pr_id } = request.body || {};
    if (!pr_id) {
      return reply.code(400).send({ error: 'pr_id is required' });
    }
    try {
      const workspace = await createWorkspace(pr_id, currentConfig);
      return reply.code(201).send(workspace);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.get('/api/workspaces', (request) => {
    const db = getDb();
    const { pr_id } = request.query;
    if (pr_id) {
      return db.prepare("SELECT * FROM workspaces WHERE pr_id = ? AND status = 'active'").all(pr_id);
    }
    return db.prepare("SELECT * FROM workspaces WHERE status = 'active'").all();
  });

  app.delete('/api/workspaces/:id', async (request, reply) => {
    try {
      const result = await destroyWorkspace(request.params.id, currentConfig);
      return result;
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.decorate('updateWorkspaceConfig', (newConfig) => {
    currentConfig = newConfig;
  });
}
