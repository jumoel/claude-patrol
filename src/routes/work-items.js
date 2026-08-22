import { providerSetup } from '../provider-setup.js';
import { sanitizePublicText } from '../public-errors.js';

function recoveryActions(error, config) {
  const provider = error.failedProvider ?? null;
  if (!provider) return [];
  const setup = providerSetup(config)[provider];
  const commands = [setup.model_login_command];
  if (error.code === 'authentication_required') commands.push(...setup.resolver_mcp_commands);
  return [
    ...commands.map((command) => ({ kind: 'command', label: 'Run setup command', command })),
    { kind: 'settings', label: 'Open Work Items settings', href: '#/setup?section=work-items' },
  ];
}

function errorStatus(code) {
  if (code === 'work_item_not_found') return 404;
  if (['work_item_busy', 'invalid_state', 'session_exists', 'work_item_child_managed'].includes(code)) return 409;
  if (['invalid_request', 'invalid_reference', 'invalid_provider', 'work_items_not_configured'].includes(code)) {
    return 400;
  }
  return 500;
}

export function workItemErrorEnvelope(error, config) {
  const code = error.code ?? 'internal_error';
  return {
    code,
    message: sanitizePublicText(error.message ?? 'Request failed', { maxBytes: 4096 }),
    detail: null,
    failed_provider: error.failedProvider ?? null,
    retry_action: null,
    recovery_actions: recoveryActions(error, config),
  };
}

function sendError(reply, error, config) {
  const envelope = workItemErrorEnvelope(error, config);
  return reply.code(errorStatus(envelope.code)).send({ error: envelope });
}

export function registerWorkItemRoutes(app) {
  const { getConfig, workItemService } = app.appContext;

  app.post('/api/work-items', (request, reply) => {
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['reference', 'work_provider'].includes(key))
    ) {
      return sendError(
        reply,
        { code: 'invalid_request', message: 'Expected reference and work_provider' },
        getConfig(),
      );
    }
    try {
      const workItem = workItemService.create({ reference: body.reference, workProvider: body.work_provider });
      reply.header('Location', `/api/work-items/${workItem.id}`);
      return reply.code(202).send({ work_item: workItem });
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  app.get('/api/work-items', () => ({ work_items: workItemService.list() }));

  app.get('/api/work-items/:id', (request, reply) => {
    const workItem = workItemService.detail(request.params.id);
    if (!workItem) {
      return sendError(reply, { code: 'work_item_not_found', message: 'Work item not found' }, getConfig());
    }
    return { work_item: workItem };
  });

  app.post('/api/work-items/:id/retry', (request, reply) => {
    if (
      request.body !== undefined &&
      request.body !== null &&
      (typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length > 0)
    ) {
      return sendError(
        reply,
        { code: 'invalid_request', message: 'Retry does not accept request fields' },
        getConfig(),
      );
    }
    try {
      const workItem = workItemService.retry(request.params.id);
      reply.header('Location', `/api/work-items/${workItem.id}`);
      return reply.code(202).send({ work_item: workItem });
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  app.delete('/api/work-items/:id', (request, reply) => {
    try {
      const result = workItemService.destroy(request.params.id);
      const workItem = workItemService.detail(request.params.id);
      return reply.code(result.accepted ? 202 : 200).send({ work_item: workItem });
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });
}
