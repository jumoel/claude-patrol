import { getCurrentConfig } from '../config.js';
import { triggerPoll } from '../poller.js';

/**
 * Register sync-related routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSyncRoutes(app) {
  app.post('/api/sync/trigger', async () => {
    await triggerPoll(getCurrentConfig());
    return { ok: true };
  });
}
