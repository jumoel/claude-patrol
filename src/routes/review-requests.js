import { z } from 'zod';
import { parseBody, sendError } from '../http-errors.js';
import { triggerReviewPoll } from '../poller.js';
import { reviewRequestService } from '../review-request-service.js';
import { reviewStore } from '../review-request-store.js';

const acknowledgement = z.object({ expected_version: z.string().min(1), collapsed: z.boolean() }).strict();
const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    ids: z.string().optional(),
    status_only: z.enum(['true', 'false']).optional(),
  })
  .strict();

export function registerReviewRequestRoutes(app) {
  const { getDb, getConfig } = app.appContext;
  app.get('/api/review-requests', (request, reply) => {
    const parsed = parseBody(querySchema, request.query);
    if (parsed.error) return sendError(reply, 'invalid_request', parsed.error);
    const { limit, cursor, ids, status_only } = parsed.data;
    try {
      return reviewStore(getDb()).list(getConfig().poll, {
        limit,
        cursor,
        ids: ids === undefined ? undefined : ids.split(','),
        statusOnly: status_only === 'true',
      });
    } catch (error) {
      return sendError(reply, error.code ?? 'internal_error', error.message);
    }
  });
  app.post('/api/review-requests/refresh', async (_request, reply) => {
    try {
      await triggerReviewPoll(getConfig());
      return { ok: true };
    } catch (error) {
      return sendError(reply, error.rateLimited ? 'github_rate_limited' : 'upstream_failed', error.message);
    }
  });
  app.post('/api/review-requests/:id/acknowledgement', async (request, reply) => {
    const parsed = parseBody(acknowledgement, request.body);
    if (parsed.error) return sendError(reply, 'invalid_request', parsed.error);
    const { expected_version, collapsed } = parsed.data;
    try {
      return await reviewRequestService(getDb()).acknowledge(
        getConfig().poll,
        request.params.id,
        expected_version,
        collapsed,
      );
    } catch (error) {
      const current = reviewStore(getDb()).rows([request.params.id], getConfig().poll)[0];
      return sendError(
        reply,
        error.rateLimited ? 'github_rate_limited' : (error.code ?? 'upstream_failed'),
        error.message,
        {
          detail: JSON.stringify(current ? { row: current } : { id: request.params.id, removed: true }),
        },
      );
    }
  });
}
