import { getRuleLoadErrors, getRules, listRuleRuns, manualRunRule } from '../rules.js';

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
}
