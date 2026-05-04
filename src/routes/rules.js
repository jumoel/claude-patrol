import {
  getRuleLoadErrors,
  getRules,
  listRuleRuns,
  listSubscriptions,
  manualRunRule,
  runRuleForAll,
  subscribeRule,
  subscribeRuleForAll,
  unsubscribeRule,
} from '../rules.js';

/**
 * Routes for the rules engine. Read-only listing of definitions and runs,
 * plus a manual trigger for debugging / one-off use.
 *
 * @param {import('fastify').FastifyInstance} app
 */
export function registerRuleRoutes(app) {
  app.get('/api/rules', async () => {
    return {
      rules: getRules(),
      errors: getRuleLoadErrors(),
    };
  });

  app.get('/api/rules/runs', async (request) => {
    const { limit, rule_id, pr_id } = request.query ?? {};
    return listRuleRuns({
      limit: limit !== undefined ? Number(limit) : undefined,
      rule_id,
      pr_id,
    });
  });

  app.post('/api/rules/:id/run', async (request, reply) => {
    const { id } = request.params;
    const force = String(request.query?.force ?? '').toLowerCase() === 'true';
    const body = request.body ?? {};
    try {
      const run = await manualRunRule(id, {
        pr_id: body.pr_id,
        session_id: body.session_id,
        force,
      });
      return run;
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.get('/api/rules/:id/subscriptions', async (request) => {
    const { id } = request.params;
    return listSubscriptions({ rule_id: id });
  });

  app.post('/api/rules/:id/subscribe', async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};
    if (!body.pr_id) {
      reply.code(400);
      return { error: 'pr_id is required' };
    }
    try {
      return subscribeRule(id, body.pr_id);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.delete('/api/rules/:id/subscribe', async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};
    if (!body.pr_id) {
      reply.code(400);
      return { error: 'pr_id is required' };
    }
    return unsubscribeRule(id, body.pr_id);
  });

  app.get('/api/prs/:pr_id/rule-subscriptions', async (request) => {
    const { pr_id } = request.params;
    return listSubscriptions({ pr_id });
  });

  app.post('/api/rules/:id/run-all', async (request, reply) => {
    const { id } = request.params;
    const body = request.body ?? {};
    try {
      return runRuleForAll(id, {
        force: body.force === true,
        subscribe: body.subscribe === true,
      });
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.post('/api/rules/:id/subscribe-all', async (request, reply) => {
    const { id } = request.params;
    try {
      return subscribeRuleForAll(id);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });
}
