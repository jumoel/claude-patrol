import { z } from 'zod';
import { parseBody, sendErrorFrom } from '../http-errors.js';
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

// Field presence and unknown keys are checked here; the values themselves are
// validated by the work-item service so its specific error codes
// (invalid_title, invalid_repositories, ...) reach the client.
const field = z.unknown().optional();
const createWorkItemBody = z.union([
  z.object({ source: z.literal('manual'), title: field, repositories: field, bookmark: field }).strict(),
  z.object({ source: z.literal('reference'), reference: field, resolver_provider: field }).strict(),
  z.object({ source: z.literal('pull_request'), pr_id: field }).strict(),
  // Legacy shape without `source`.
  z.object({ reference: field, work_provider: field }).strict(),
]);
const pullRequestBody = z.object({ pr: z.string() }).strict();
const addRepositoryBody = z.object({ repository: z.unknown(), revision: field }).strict();
const emptyBody = z.object({}).strict().nullish();

export function registerWorkItemRoutes(app) {
  const { getConfig, workItemService } = app.appContext;

  app.post('/api/work-items', (request, reply) => {
    const parsed = parseBody(createWorkItemBody, request.body);
    if (parsed.error) {
      return sendError(
        reply,
        { code: 'invalid_request', message: `Expected a work-item creation request (${parsed.error})` },
        getConfig(),
      );
    }
    const body = parsed.data;
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

  app.post('/api/work-items/:id/pull-requests', (request, reply) => {
    const body = parseBody(pullRequestBody, request.body);
    if (body.error)
      return sendError(reply, { code: 'invalid_request', message: `Expected pr (${body.error})` }, getConfig());
    try {
      return { pull_request: linkWorkItemPullRequest(request.params.id, body.data.pr) };
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  app.delete('/api/work-items/:id/pull-requests', (request, reply) => {
    const body = parseBody(pullRequestBody, request.body);
    if (body.error)
      return sendError(reply, { code: 'invalid_request', message: `Expected pr (${body.error})` }, getConfig());
    try {
      return unlinkWorkItemPullRequest(request.params.id, body.data.pr);
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  app.post('/api/work-items/:id/repositories', async (request, reply) => {
    const body = parseBody(addRepositoryBody, request.body);
    if (body.error || !Object.hasOwn(body.data, 'repository')) {
      return sendError(
        reply,
        { code: 'invalid_request', message: `Expected repository${body.error ? ` (${body.error})` : ''}` },
        getConfig(),
      );
    }
    try {
      return await workItemService.addRepository(request.params.id, body.data.repository, body.data.revision);
    } catch (error) {
      return sendError(reply, error, getConfig());
    }
  });

  app.post('/api/work-items/:id/retry', (request, reply) => {
    if (parseBody(emptyBody, request.body).error) {
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
