import { emitReviewRequestChange } from './app-events.js';
import { getDb } from './db.js';
import { taggedError } from './errors.js';
import { githubClient } from './github-client.js';
import { prStore } from './pr-store.js';
import { createReviewPoller } from './review-request-poller.js';
import { REVIEW_LIMITS } from './review-request-query.js';
import { reviewStore } from './review-request-store.js';

const services = new WeakMap();
export function reviewRequestService(db = getDb()) {
  if (services.has(db)) return services.get(db);
  const active = new Map();
  const api = {
    async acknowledge(poll, id, expectedVersion, collapsed) {
      const client = githubClient(db);
      client.configure(poll);
      const observation = client.capture();
      const store = reviewStore(db);
      const initial = store.rows([id], poll)[0];
      if (!initial && !collapsed) return { id, removed: true };
      if (!initial || initial.state_version !== expectedVersion)
        throw taggedError('invalid_state', 'Review request changed');
      if (collapsed && initial.verification_pending) {
        const states = db.prepare('SELECT * FROM pr_review_request_state WHERE pr_id = ? ORDER BY target_id').all(id);
        const joinKey = `${observation.generation}:${id}`;
        if (!active.has(joinKey)) {
          const request = client
            .withOptionalWork(async () => {
              const service = createReviewPoller({
                db,
                poll,
                viewer: client.identity(),
                assertCurrent: observation.assertCurrent,
                emit: emitReviewRequestChange,
              });
              const graphql = (query, variables, options) =>
                client.request(query, variables, { ...options, observation, optional: true });
              for (let attempt = 0; attempt < REVIEW_LIMITS.interactive; attempt++) {
                await service.verify(graphql, { onlyId: id });
                observation.assertCurrent();
                const current = store.rows([id], poll)[0];
                if (!current?.verification_pending) break;
              }
            })
            .finally(() => active.delete(joinKey));
          active.set(joinKey, request);
        }
        await active.get(joinKey);
        observation.assertCurrent();
        const next = store.rows([id], poll)[0];
        const currentStates = db
          .prepare('SELECT * FROM pr_review_request_state WHERE pr_id = ? ORDER BY target_id')
          .all(id);
        const changed =
          !next ||
          next.head_oid !== initial.head_oid ||
          next.title !== initial.title ||
          (initial.review_revision !== null && next.review_revision !== initial.review_revision) ||
          states.length !== currentStates.length ||
          states.some((state, index) => {
            const current = currentStates[index];
            return (
              state.target_id !== current.target_id ||
              state.match_state !== current.match_state ||
              (state.event_id !== null && state.event_id !== current.event_id) ||
              state.acknowledged_revision !== current.acknowledged_revision ||
              state.acknowledged_event_id !== current.acknowledged_event_id ||
              state.acknowledgement_invalidated !== current.acknowledgement_invalidated
            );
          });
        if (changed) throw taggedError('invalid_state', 'Review request changed during verification');
        if (next.verification_pending)
          throw taggedError(
            'review_verification_failed',
            'Review request could not be fully verified within the request budget',
          );
        expectedVersion = next.state_version;
      }
      observation.assertCurrent();
      const context = store.begin();
      try {
        const result = store.acknowledge(poll, id, expectedVersion, collapsed, context);
        prStore(db).fence.accept(context.read, result.keys ?? []);
        emitReviewRequestChange({ kind: 'acknowledgement', ids: [id] });
        const { keys: _keys, ...response } = result;
        return response;
      } finally {
        prStore(db).end(context);
      }
    },
  };
  services.set(db, api);
  return api;
}
