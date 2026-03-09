/**
 * Register config endpoint (exposes non-sensitive config to frontend).
 * @param {import('fastify').FastifyInstance} app
 * @param {{ orgs: string[], poll_interval_seconds: number }} config
 */
export function registerConfigRoutes(app, config) {
  let currentConfig = config;

  app.get('/api/config', () => ({
    orgs: currentConfig.orgs,
    poll_interval_seconds: currentConfig.poll_interval_seconds,
  }));

  app.decorate('updateConfig', (newConfig) => {
    currentConfig = newConfig;
  });
}
