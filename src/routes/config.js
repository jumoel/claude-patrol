import { isConfigured, isPollConfigured, isWorkItemsConfigured } from '../config.js';
import { providerSetup } from '../provider-setup.js';
import { getRestartStatus, getUpdateStatus, pullUpdate, restartServer } from '../update-check.js';

/**
 * Register config endpoint (exposes non-sensitive config to frontend).
 * @param {import('fastify').FastifyInstance} app
 */
export function registerConfigRoutes(app) {
  const { getConfig, updateConfig, providerCapabilities } = app.appContext;
  app.get('/api/config', () => {
    const cfg = getConfig();
    const workItemsConfigured = isWorkItemsConfigured(cfg);
    const resolver = cfg.work_items?.resolver;
    const setup = providerSetup(cfg);
    return {
      poll: cfg.poll,
      poll_configured: isPollConfigured(cfg),
      default_session_provider: cfg.default_session_provider,
      needs_setup: !isConfigured(cfg),
      work_items: {
        configured: workItemsConfigured,
        resolver: workItemsConfigured
          ? {
              provider_mode: resolver.provider ? 'fixed' : 'requested_provider',
              provider: resolver.provider ?? null,
              server_name: resolver.server.name,
            }
          : null,
        repositories: cfg.work_items?.repositories ?? [],
        provider_setup: setup,
      },
      manual_work: {
        configured: Object.keys(cfg.repos ?? {}).length > 0,
        repositories: Object.entries(cfg.repos ?? {})
          .map(([repository, repositoryConfig]) => ({
            repository,
            default_revision: repositoryConfig.defaultRevision ?? null,
          }))
          .sort((left, right) => left.repository.localeCompare(right.repository)),
      },
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
