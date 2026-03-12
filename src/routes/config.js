import { writeFileSync } from 'node:fs';
import { getCurrentConfig, isConfigured, getConfigPath } from '../config.js';
import { getUpdateStatus, pullUpdate } from '../update-check.js';

/**
 * Register config endpoint (exposes non-sensitive config to frontend).
 * @param {import('fastify').FastifyInstance} app
 */
export function registerConfigRoutes(app) {
  app.get('/api/config', () => {
    const cfg = getCurrentConfig();
    return {
      poll: cfg.poll,
      needs_setup: !isConfigured(cfg),
      ...getUpdateStatus(),
    };
  });

  app.post('/api/config', (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Request body must be a JSON object' });
    }

    // Read current config and merge poll targets
    const current = getCurrentConfig();
    const newConfig = {
      ...current,
      poll: {
        ...current.poll,
        ...body.poll,
      },
    };

    // Validate poll structure
    if (!Array.isArray(newConfig.poll.orgs) || !Array.isArray(newConfig.poll.repos)) {
      return reply.code(400).send({ error: 'poll.orgs and poll.repos must be arrays' });
    }

    try {
      // Write to disk - fs.watchFile will pick up the change and live-reload
      writeFileSync(getConfigPath(), JSON.stringify(newConfig, null, 2) + '\n');
      return { ok: true };
    } catch (err) {
      return reply.code(500).send({ error: `Failed to write config: ${err.message}` });
    }
  });

  app.post('/api/update', async (request, reply) => {
    const result = await pullUpdate();
    if (!result.ok) {
      return reply.code(500).send({ error: result.error });
    }
    return { ok: true, output: result.output };
  });
}
