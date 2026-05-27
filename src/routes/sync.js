import { setActiveTab } from '../active-tabs.js';
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

  // Frontend reports which tab the user is currently viewing so the poller
  // can skip the review-requested GitHub query when nobody cares about it.
  // Heartbeated client-side; see src/active-tabs.js for TTL semantics.
  app.post('/api/active-tab', async (request, reply) => {
    const { clientId, tab } = request.body ?? {};
    if (typeof clientId !== 'string' || !clientId) {
      return reply.code(400).send({ error: 'clientId required' });
    }
    if (tab !== 'authored' && tab !== 'reviews') {
      return reply.code(400).send({ error: 'tab must be "authored" or "reviews"' });
    }
    setActiveTab(clientId, tab);
    return { ok: true };
  });
}
