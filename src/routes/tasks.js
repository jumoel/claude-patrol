import { listTasks } from '../tasks.js';

/**
 * Register task routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerTaskRoutes(app) {
  app.get('/api/tasks', () => listTasks());
}
