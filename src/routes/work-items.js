import { sendErrorFrom } from '../http-errors.js';
import { providerSetup } from '../provider-setup.js';
import { linkWorkItemPullRequest, unlinkWorkItemPullRequest } from '../work-item-prs.js';

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

/**
 * Send the shared error envelope for a work-item failure, adding the
 * provider recovery actions that depend on the current config.
 * @param {import('fastify').FastifyReply} reply
 * @param {{ code?: string, message?: string, failedProvider?: string | null }} error
 * @param {object} config
 */
function sendError(reply, error, config) {
  return sendErrorFrom(reply, error, {
    failed_provider: error.failedProvider ?? null,
    recovery_actions: recoveryActions(error, config),
  });
}

export function registerWorkItemRoutes(app) {
  const { getConfig, workItemService } = app.appContext;

  app.post('/api/work-items', (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(
        reply,
        { code: 'invalid_request', message: 'Expected a work-item creation request' },
        getConfig(),
      );
    }
    const keys = Object.keys(body);
    const allowedBySource = {
      manual: new Set(['source', 'title', 'repositories', 'bookmark']),
      reference: new Set(['source', 'reference', 'resolver_provider']),
      pull_request: new Set(['source', 'pr_id']),
      legacy: new Set(['reference', 'work_provider']),
    };
    const contract = body.source === undefined ? allowedBySource.legacy : allowedBySource[body.source];
    if (!contract || keys.some((key) => !contract.has(key))) {
      return sendError(reply, { code: 'invalid_request', message: 'Unknown work-item creation field' }, getConfig());
    }
    try {
      const workItem = workItemService.create(
        body.source === undefined
          ? { reference: body.reference, workProvider: body.work_provider }
          : {
              source: body.source,
              ...(Object.hasOwn(body, 'title') ? { title: body.title } : {}),
              ...(Object.hasOwn(body, 'repositories') ? { repositories: body.repositories } : {}),
              ...(Object.hasOwn(body, 'bookmark') ? { bookmark: body.bookmark } : {}),
              ...(Object.hasOwn(body, 'reference') ? { reference: body.reference } : {}),
              ...(Object.hasOwn(body, 'resolver_provider') ? { resolver_provider: body.resolver_provider } : {}),
              ...(Object.hasOwn(body, 'pr_id') ? { pr_id: body.pr_id } : {}),
            },
      );
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

  app.get('/api/work-items/:id/repositories/available', (request, reply) => {
    try {
      return { repositories: workItemService.availableRepositories(request.params.id) };
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  const validatePullRequestBody = (body) =>
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).length === 1 &&
    typeof body.pr === 'string';

  app.post('/api/work-items/:id/pull-requests', (request, reply) => {
    if (!validatePullRequestBody(request.body)) {
      return sendError(reply, { code: 'invalid_request', message: 'Expected pr' }, getConfig());
    }
    try {
      return { pull_request: linkWorkItemPullRequest(request.params.id, request.body.pr) };
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  app.delete('/api/work-items/:id/pull-requests', (request, reply) => {
    if (!validatePullRequestBody(request.body)) {
      return sendError(reply, { code: 'invalid_request', message: 'Expected pr' }, getConfig());
    }
    try {
      return unlinkWorkItemPullRequest(request.params.id, request.body.pr);
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  app.post('/api/work-items/:id/repositories', async (request, reply) => {
    const body = request.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['repository', 'revision'].includes(key)) ||
      !Object.hasOwn(body, 'repository')
    ) {
      return sendError(reply, { code: 'invalid_request', message: 'Expected repository' }, getConfig());
    }
    try {
      return await workItemService.addRepository(request.params.id, body.repository, body.revision);
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
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
