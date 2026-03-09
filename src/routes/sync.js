import { triggerPoll } from '../poller.js';

/**
 * Register sync-related routes.
 * @param {import('fastify').FastifyInstance} app
 * @param {{ orgs: string[] }} config
 */
export function registerSyncRoutes(app, config) {
  let currentOrgs = config.orgs;

  app.post('/api/sync/trigger', async () => {
    await triggerPoll(currentOrgs);
    return { ok: true };
  });

  /**
   * Update the orgs list when config changes.
   * @param {{ orgs: string[] }} newConfig
   */
  app.decorate('updateSyncConfig', (newConfig) => {
    currentOrgs = newConfig.orgs;
  });
}
