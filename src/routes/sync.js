import { triggerPoll } from '../poller.js';

/**
 * Register sync-related routes.
 * @param {import('fastify').FastifyInstance} app
 * @param {object} config
 */
export function registerSyncRoutes(app, config) {
  let currentConfig = config;

  app.post('/api/sync/trigger', async () => {
    await triggerPoll(currentConfig);
    return { ok: true };
  });

  /**
   * Update the config when it changes.
   * @param {object} newConfig
   */
  app.decorate('updateSyncConfig', (newConfig) => {
    currentConfig = newConfig;
  });
}
