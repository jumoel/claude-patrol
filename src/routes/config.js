import { isConfigured } from '../config.js';
import { getRestartStatus, getUpdateStatus, pullUpdate, restartServer } from '../update-check.js';

/**
 * Register config endpoint (exposes non-sensitive config to frontend).
 * @param {import('fastify').FastifyInstance} app
 */
export function registerConfigRoutes(app) {
  const { getConfig, updateConfig, providerCapabilities } = app.appContext;
  app.get('/api/config', () => {
    const cfg = getConfig();
    return {
      poll: cfg.poll,
      needs_setup: !isConfigured(cfg),
      capabilities: {
        providers: Object.fromEntries(
          Object.entries(providerCapabilities).map(([provider, capability]) => [provider, capability.getSnapshot()]),
        ),
      },
      ...getUpdateStatus(),
    };
  });

  app.get('/api/capabilities/providers', async (request) => {
    const method = request.query?.refresh === 'true' ? 'refresh' : 'refreshIfStale';
    const entries = await Promise.all(
      Object.entries(providerCapabilities).map(async ([provider, capability]) => [
        provider,
        await capability[method](),
      ]),
    );
    return Object.fromEntries(entries);
  });

  app.post('/api/config', (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.code(400).send({ error: 'Request body must be a JSON object' });
    }

    try {
      updateConfig(body);
      return { ok: true };
    } catch (err) {
      const validationError = err.message.startsWith('Invalid config:') || err instanceof SyntaxError;
      return reply.code(validationError ? 400 : 500).send({ error: `Failed to write config: ${err.message}` });
    }
  });

  app.post('/api/update', async (_request, reply) => {
    const result = await pullUpdate();
    if (!result.ok) {
      return reply.code(500).send({ error: result.error });
    }
    return { ok: true, output: result.output };
  });

  app.get('/api/restart/status', () => {
    return getRestartStatus() || { phase: null };
  });

  app.post('/api/restart', (_request, reply) => {
    const status = getUpdateStatus();
    if (!status.restart_needed) {
      return reply.code(400).send({ error: 'No restart needed - already running latest version' });
    }
    reply.send({ ok: true, message: 'Restarting server...' });
    restartServer();
  });
}
