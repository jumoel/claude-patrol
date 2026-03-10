/**
 * Register config endpoint (exposes non-sensitive config to frontend).
 * @param {import('fastify').FastifyInstance} app
 * @param {object} config
 */
export function registerConfigRoutes(app, config) {
  let currentConfig = config;

  app.get('/api/config', () => ({
    poll: currentConfig.poll,
  }));

  app.decorate('updateConfig', (newConfig) => {
    currentConfig = newConfig;
  });
}
