import { getCurrentConfig } from '../config.js';

/**
 * Register config endpoint (exposes non-sensitive config to frontend).
 * @param {import('fastify').FastifyInstance} app
 */
export function registerConfigRoutes(app) {
  app.get('/api/config', () => ({
    poll: getCurrentConfig().poll,
  }));
}
