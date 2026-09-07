import { emitGhRateLimit, emitLocalChange, emitReviewRequestChange } from './app-events.js';
import { getDb, withTransaction } from './db.js';
import { taggedError } from './errors.js';
import { GitHubBudget } from './github-budget.js';
import { createGraphqlTransport, GitHubError } from './github-graphql.js';
import { prStore } from './pr-store.js';
import { digest, inReviewScope, normalizedScope, reviewPlanId } from './review-request-query.js';
import { reviewStore } from './review-request-store.js';

const clients = new WeakMap();
const transport = createGraphqlTransport();

export function githubClient(db = getDb()) {
  if (clients.has(db)) return clients.get(db);
  let generation = 0;
  let plan = null;
  let scope = db.prepare('SELECT authored_scope_key FROM sync_state WHERE id = 1').get()?.authored_scope_key ?? null;
  let poll;
  let budget = new GitHubBudget();
  let controller = new AbortController();
  let cooldown = { limited: false, message: null, detectedAt: null, resetAt: null };
  let secondaryFailures = 0;
  let optionalTail = Promise.resolve();
  const identity = () => {
    const row = db
      .prepare(
        'SELECT viewer_id AS id, viewer_login AS login, viewer_verified AS verified FROM sync_state WHERE id = 1',
      )
      .get();
    return row?.id && row.login ? row : null;
  };
  const invalidate = () => {
    generation++;
    controller.abort();
    controller = new AbortController();
    prStore(db).fence.invalidate();
  };
  const api = {
    identity,
    budget: () => budget,
    withOptionalWork(run) {
      const next = optionalTail.then(run);
      optionalTail = next.then(
        () => {},
        () => {},
      );
      return next;
    },
    configure(next) {
      const nextPlan = reviewPlanId(next);
      const nextScope = digest(normalizedScope(next));
      const changed = plan !== nextPlan;
      const scopeChanged = scope !== nextScope;
      poll = next;
      if (changed) {
        invalidate();
        if (scopeChanged) {
          budget = new GitHubBudget();
          db.prepare('UPDATE sync_state SET last_sweep_at = NULL, last_full_sweep_at = NULL WHERE id = 1').run();
        }
        plan = nextPlan;
        scope = nextScope;
        withTransaction(db, () => {
          db.prepare('UPDATE sync_state SET authored_scope_key = ? WHERE id = 1').run(nextScope);
          for (const row of db
            .prepare('SELECT p.id, p.org, p.repo FROM prs p JOIN pr_authored_state a ON a.pr_id = p.id')
            .all()) {
            if (!inReviewScope(row, next)) db.prepare('DELETE FROM pr_authored_state WHERE pr_id = ?').run(row.id);
          }
        });
        reviewStore(db).reconcile(next, identity());
        emitReviewRequestChange({ kind: 'list' });
      }
      return { changed, scopeChanged };
    },
    stop() {
      invalidate();
    },
    capture() {
      const captured = generation;
      const expected = identity();
      const signal = controller.signal;
      const assertCurrent = (viewer) => {
        if (captured !== generation)
          throw new GitHubError('GitHub observation belongs to a superseded configuration or account', 'obsolete');
        if (!viewer) return;
        const currentIdentity = identity();
        if ((expected && viewer.id !== expected.id) || (currentIdentity && viewer.id !== currentIdentity.id)) {
          invalidate();
          budget = new GitHubBudget();
          cooldown = { limited: false, message: null, detectedAt: null, resetAt: null };
          withTransaction(db, () => {
            db.prepare('DELETE FROM pr_authored_state').run();
            // Keep local work and known content, but do not present the previous account's cache as fresh.
            db.prepare(`UPDATE prs SET body_source_updated_at = NULL,
              detail_source_updated_at = NULL, summary_synced_at = NULL`).run();
            db.prepare(`UPDATE sync_state SET viewer_id = ?, viewer_login = ?, viewer_verified = 0,
              synced_at = NULL, last_sweep_at = NULL, last_full_sweep_at = NULL WHERE id = 1`).run(
              viewer.id,
              viewer.login,
            );
            db.prepare(`UPDATE review_watch_scopes SET cursor = NULL, first_synced_at = NULL,
              overflow_synced_at = NULL, incomplete = 1, error = NULL`).run();
            db.prepare('DELETE FROM pr_review_probe_state').run();
          });
          reviewStore(db).reconcile(poll, viewer);
          emitLocalChange();
          emitReviewRequestChange({ kind: 'list' });
          throw new GitHubError('GitHub account changed; a new full sweep is required', 'identity_changed');
        }
        // Bootstrap is bound to this response, not an identity-only network call.
        withTransaction(db, () => {
          if (captured !== generation) throw new GitHubError('GitHub identity was superseded', 'obsolete');
          db.prepare('UPDATE sync_state SET viewer_id = ?, viewer_login = ?, viewer_verified = 1 WHERE id = 1').run(
            viewer.id,
            viewer.login,
          );
          db.prepare(`UPDATE pr_authored_state SET viewer_id = ? WHERE viewer_id IS NULL
            AND pr_id IN (SELECT id FROM prs WHERE lower(author) = ?)`).run(viewer.id, viewer.login.toLowerCase());
          db.prepare('DELETE FROM pr_authored_state WHERE viewer_id IS NULL').run();
        });
        if (!expected || expected.login !== viewer.login) reviewStore(db).reconcile(poll, viewer);
      };
      return { assertCurrent, signal, generation: captured };
    },
    async request(query, variables, options = {}) {
      const { observation = api.capture(), run, authoredCost, predictedCost = 1, optional = false, ...rest } = options;
      observation.assertCurrent();
      if (cooldown.limited && Date.parse(cooldown.resetAt) > Date.now()) {
        throw new GitHubError('GitHub requests are waiting for the rate limit to reset', 'rate_limit', {
          rateLimited: true,
          resetAt: cooldown.resetAt,
        });
      }
      let token;
      const attempt = () => {
        observation.assertCurrent();
        if (token !== undefined) {
          budget.observe(token, null);
          token = undefined;
          if (authoredCost) authoredCost.known = false;
        }
        if (optional && !budget.admits(poll?.interval_seconds ?? 60, predictedCost)) {
          throw taggedError(
            'review_verification_failed',
            'GitHub verification deferred to preserve the authored polling quota',
          );
        }
        token = budget.begin(predictedCost);
      };
      const telemetry = (sample) => {
        observation.assertCurrent();
        const cost = budget.observe(token, sample);
        token = undefined;
        if (authoredCost) {
          authoredCost.total += cost ?? predictedCost;
          if (cost === null) authoredCost.known = false;
        }
      };
      const limit = (error) => {
        observation.assertCurrent();
        const rawReset = error.envelope?.data?.rateLimit?.resetAt;
        const delay = Math.min(15 * 60_000, 60_000 * 2 ** secondaryFailures++);
        const resetAt =
          Number.isFinite(Date.parse(rawReset)) && Date.parse(rawReset) > Date.now()
            ? rawReset
            : new Date(Date.now() + delay).toISOString();
        cooldown = { limited: true, message: error.message, detectedAt: new Date().toISOString(), resetAt };
        emitGhRateLimit(cooldown);
      };
      try {
        let result;
        if (run) {
          // Tests inject the decoded boundary; production always uses the bounded process adapter.
          attempt();
          result = await run(query, variables, rest);
          observation.assertCurrent();
          if (!result?.data?.viewer?.id)
            throw new GitHubError('GitHub response did not identify the viewer', 'identity');
          observation.assertCurrent(result.data.viewer);
          telemetry(result.data.rateLimit ?? null);
        } else
          result = await transport(query, variables, {
            ...rest,
            signal: observation.signal,
            acceptResponse: observation.assertCurrent,
            onAttempt: attempt,
            onTelemetry: telemetry,
            onRateLimit: limit,
          });
        if (cooldown.limited) {
          cooldown = { limited: false, message: null, detectedAt: null, resetAt: null };
          secondaryFailures = 0;
          emitGhRateLimit(cooldown);
        }
        return result;
      } catch (error) {
        if (['identity_changed', 'obsolete'].includes(error.kind)) throw error;
        observation.assertCurrent();
        if (token !== undefined) telemetry(null);
        throw error;
      }
    },
    rateLimit: () => ({ ...cooldown }),
    diagnostics: () => budget.snapshot(poll?.interval_seconds ?? 60),
  };
  clients.set(db, api);
  return api;
}
