import { getDb } from '../db.js';
import { createSession, attachSession, killSession, popOutSession } from '../pty-manager.js';
import { getCurrentConfig } from '../config.js';

/**
 * Register session routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSessionRoutes(app) {
  app.post('/api/sessions', (request, reply) => {
    const { workspace_id, global: isGlobal } = request.body || {};
    const db = getDb();

    let cwd;
    if (isGlobal) {
      cwd = getCurrentConfig().global_terminal_cwd || process.cwd();
    } else if (workspace_id) {
      const workspace = db.prepare("SELECT * FROM workspaces WHERE id = ? AND status = 'active'").get(workspace_id);
      if (!workspace) {
        return reply.code(404).send({ error: 'Workspace not found or not active' });
      }
      cwd = workspace.path;
    } else {
      return reply.code(400).send({ error: 'workspace_id or global: true is required' });
    }

    try {
      const session = createSession(isGlobal ? null : workspace_id, cwd);
      return reply.code(201).send({
        ...session,
        ws_url: `ws://${request.hostname}/ws/sessions/${session.id}`,
      });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to create session: ${err.message}` });
    }
  });

  app.get('/api/sessions', (request) => {
    const db = getDb();
    const { workspace_id } = request.query;
    if (workspace_id) {
      return db.prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status IN ('active', 'detached')").all(workspace_id);
    }
    return db.prepare("SELECT * FROM sessions WHERE status IN ('active', 'detached')").all();
  });

  app.delete('/api/sessions/:id', (request) => {
    killSession(request.params.id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/popout', (request, reply) => {
    try {
      popOutSession(request.params.id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // WebSocket route for terminal attachment
  app.get('/ws/sessions/:id', { websocket: true }, (socket, request) => {
    attachSession(request.params.id, socket);
  });
}
