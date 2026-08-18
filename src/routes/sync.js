/**
 * Register sync-related routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerSyncRoutes(app) {
  const { getConfig, triggerPoll } = app.appContext;
  app.post('/api/sync/trigger', async () => {
    await triggerPoll(getConfig());
    return { ok: true };
  });
}
