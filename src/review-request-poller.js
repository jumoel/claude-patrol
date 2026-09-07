import { randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { requireGraphqlRoot } from './github-graphql.js';
import { prStore } from './pr-store.js';
import {
  digest,
  exactReviewer,
  inReviewScope,
  PR_SUMMARY_FIELDS,
  REVIEW_LIMITS,
  REVIEW_SEARCH_FIELDS,
  REVIEWER_FIELDS,
} from './review-request-query.js';
import { reviewStore } from './review-request-store.js';

const nowIso = () => new Date().toISOString();
const key = (pr, target) => JSON.stringify([pr, target]);

/** Borrow unused reserved slots, then fill by oldest attempt across queues. */
export function fairReviewQueue(queues, reservations, limit, timeField = 'last_attempt_at') {
  const selected = new Map();
  const order = (a, b) => (a[timeField] ?? '').localeCompare(b[timeField] ?? '') || a.id.localeCompare(b.id);
  queues.forEach((queue, index) => {
    for (const row of [...queue].sort(order)) {
      if (selected.size >= limit) break;
      if (selected.has(row.id)) continue;
      const own = [...selected.values()].filter((value) => value.queue === index).length;
      if (own >= reservations[index]) break;
      selected.set(row.id, { row, queue: index });
    }
  });
  for (const row of queues.flat().sort(order)) {
    if (selected.size >= limit) break;
    if (!selected.has(row.id)) selected.set(row.id, { row });
  }
  return [...selected.values()].map((value) => value.row);
}

/** Review roots commit independently. This module never runs an authored sweep. */
export function createReviewPoller({ db, poll, viewer, assertCurrent, emit = () => {} }) {
  const reviews = reviewStore(db);
  const prs = prStore(db);
  const targets = () => reviews.targets();

  function transaction(context, write) {
    const keys = [];
    const snapshots = new Map(context.snapshots);
    const states = new Map(context.states);
    try {
      withTransaction(db, () => {
        assertCurrent();
        write(keys);
        assertCurrent();
      });
    } catch (error) {
      context.snapshots = snapshots;
      context.states = states;
      throw error;
    }
    prs.fence.accept(context.read, keys.filter(Boolean));
  }

  function rememberOwnState(context, prId, targetId) {
    const row = db
      .prepare('SELECT state_version FROM pr_review_request_state WHERE pr_id = ? AND target_id = ?')
      .get(prId, targetId);
    if (row) context.states.set(key(prId, targetId), row.state_version);
    else context.states.delete(key(prId, targetId));
  }

  function scopeError(scope, error, overflow = false) {
    assertCurrent();
    db.prepare(
      `UPDATE review_watch_scopes SET error = ?, ${overflow ? 'overflow_attempt_at' : 'first_attempt_at'} = ? WHERE id = ?`,
    ).run(error.message, nowIso(), scope.id);
    emit({ kind: 'status' });
  }

  const api = {
    begin: () => reviews.begin(),
    end: (context) => prs.end(context),
    firstPages() {
      assertCurrent();
      return db
        .prepare(`SELECT * FROM review_watch_scopes ORDER BY first_attempt_at, id LIMIT ?`)
        .all(REVIEW_LIMITS.aliases);
    },
    markFirstAttempts(scopes) {
      assertCurrent();
      const now = nowIso();
      for (const scope of scopes)
        db.prepare('UPDATE review_watch_scopes SET first_attempt_at = ? WHERE id = ?').run(now, scope.id);
    },
    settleSearch(result, scopes, context, overflow = false) {
      scopes.forEach((scope, index) => {
        try {
          const search = requireGraphqlRoot(result, `review${index}`);
          if (
            !Array.isArray(search.nodes) ||
            !search.pageInfo ||
            typeof search.issueCount !== 'number' ||
            typeof search.pageInfo.hasNextPage !== 'boolean' ||
            (search.pageInfo.hasNextPage && typeof search.pageInfo.endCursor !== 'string')
          )
            throw new Error('Incomplete review search page');
          const target = targets().find((item) => item.id === scope.target_id);
          if (!target) throw new Error('Review target was removed');
          const now = nowIso();
          const changedIds = [];
          transaction(context, (keys) => {
            for (const node of search.nodes) {
              const prepared = prs.prepare(node, 'summary', context);
              if (!inReviewScope(prepared.fields, poll) || node.state !== 'OPEN') continue;
              const row = prs.write(prepared, now);
              if (!prepared.same) changedIds.push(row.id);
              keys.push(`pr:${row.id}`);
              keys.push(reviews.discover(row.id, target, viewer, context, now));
              rememberOwnState(context, row.id, target.id);
              context.snapshots.set(row.id, row.snapshot_version);
            }
            db.prepare(`UPDATE review_watch_scopes SET cursor = ?, issue_count = ?, incomplete = ?, limited = ?,
              error = NULL, ${overflow ? 'overflow_synced_at' : 'first_synced_at'} = ? WHERE id = ?`).run(
              search.pageInfo.hasNextPage
                ? !overflow && scope.cursor
                  ? scope.cursor
                  : search.pageInfo.endCursor
                : null,
              search.issueCount,
              search.pageInfo.hasNextPage ? 1 : 0,
              search.issueCount > 1000 ? 1 : 0,
              now,
              scope.id,
            );
          });
          emit({ kind: 'list' });
          if (changedIds.length) emit({ kind: 'summary', ids: changedIds });
        } catch (error) {
          scopeError(scope, error, overflow);
        }
      });
    },
    async overflow(graphql, admits) {
      const attempted = new Set();
      for (let attempt = 0; attempt < REVIEW_LIMITS.overflow && admits(1); attempt++) {
        const scope = db
          .prepare(`SELECT * FROM review_watch_scopes WHERE cursor IS NOT NULL
          AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY overflow_attempt_at, id LIMIT 1`)
          .get(JSON.stringify([...attempted]));
        if (!scope) break;
        attempted.add(scope.id);
        assertCurrent();
        db.prepare('UPDATE review_watch_scopes SET overflow_attempt_at = ? WHERE id = ?').run(nowIso(), scope.id);
        const context = reviews.begin();
        try {
          const result = await graphql(
            `query($q: String!, $cursor: String!) {
            review0: search(query: $q, type: ISSUE, first: 50, after: $cursor) { ${REVIEW_SEARCH_FIELDS} }
          }`,
            { q: scope.query, cursor: scope.cursor },
            { maxAttempts: 1 },
          );
          api.settleSearch(result, [scope], context, true);
        } catch (error) {
          scopeError(scope, error, true);
          if (error.rateLimited) throw error;
        } finally {
          prs.end(context);
        }
      }
    },
    retained() {
      const inactive = db
        .prepare(`SELECT p.id, p.github_node_id, MIN(r.last_attempt_at) AS last_attempt_at
        FROM prs p JOIN pr_review_request_state r ON r.pr_id = p.id
        WHERE r.match_state = 'inactive' AND r.acknowledged_revision IS NOT NULL
        AND p.github_node_id IS NOT NULL AND p.github_state = 'OPEN' GROUP BY p.id`)
        .all();
      const missing = db
        .prepare(`SELECT p.id, p.github_node_id, p.org, p.repo, p.number, a.last_state_check_at AS last_attempt_at
        FROM prs p JOIN pr_authored_state a ON a.pr_id = p.id
        WHERE a.missing_since IS NOT NULL`)
        .all();
      return fairReviewQueue([inactive, missing], [20, 20], REVIEW_LIMITS.retained);
    },
    markRetainedAttempts(rows) {
      assertCurrent();
      const now = nowIso();
      for (const row of rows) {
        db.prepare('UPDATE pr_authored_state SET last_state_check_at = ? WHERE pr_id = ?').run(now, row.id);
        db.prepare('UPDATE pr_review_request_state SET last_attempt_at = ? WHERE pr_id = ?').run(now, row.id);
      }
    },
    settleRetained(result, context, selected = []) {
      const nodes = [];
      if (!selected.length || selected.some((row) => row.github_node_id)) {
        try {
          const retained = requireGraphqlRoot(result, 'retained');
          if (!Array.isArray(retained)) throw new Error('Incomplete retained PR result');
          nodes.push(...retained);
        } catch (error) {
          api.verificationError(
            selected.filter((row) => row.github_node_id).map((row) => row.id),
            error,
          );
        }
      }
      selected.forEach((row, index) => {
        if (row.github_node_id) return;
        try {
          nodes.push(requireGraphqlRoot(result, `retainedLegacy${index}`).pullRequest);
        } catch (error) {
          api.verificationError([row.id], error);
        }
      });
      const closed = [];
      for (const node of nodes) {
        if (!node) continue;
        transaction(context, (keys) => {
          const prepared = prs.prepare(node, 'summary', context);
          const row = prs.write(prepared, nowIso());
          keys.push(`pr:${row.id}`);
          context.snapshots.set(row.id, row.snapshot_version);
          if (node.state !== 'OPEN') {
            db.prepare('DELETE FROM pr_authored_state WHERE pr_id = ?').run(row.id);
            closed.push(row.id);
          } else if (node.author?.login?.toLowerCase() !== viewer.login.toLowerCase() || !inReviewScope(row, poll)) {
            db.prepare('DELETE FROM pr_authored_state WHERE pr_id = ?').run(row.id);
          } else db.prepare('UPDATE pr_authored_state SET missing_since = NULL WHERE pr_id = ?').run(row.id);
        });
      }
      emit({
        kind: 'summary',
        ids: nodes
          .filter(Boolean)
          .map((node) => prs.resolve(node)?.id)
          .filter(Boolean),
      });
      return closed;
    },
    confirmations() {
      const rows = db
        .prepare(`SELECT p.id, p.github_node_id, MIN(r.last_attempt_at) AS last_attempt_at,
        MAX(CASE WHEN r.match_state = 'candidate' THEN 1 ELSE 0 END) AS candidate
        FROM prs p JOIN pr_review_request_state r ON r.pr_id = p.id
        WHERE p.github_state = 'OPEN' AND p.github_node_id IS NOT NULL
        GROUP BY p.id`)
        .all();
      return fairReviewQueue(
        [rows.filter((r) => !r.candidate), rows.filter((r) => r.candidate)],
        [20, 0],
        REVIEW_LIMITS.reviewers,
      );
    },
    probes(fullSweep = false, onlyId = null) {
      const rows = db
        .prepare(`SELECT p.*, p.id, MIN(r.last_probe_attempt_at) AS last_attempt_at,
        MAX(CASE WHEN r.event_id IS NULL OR r.verification_status != 'verified' THEN 1 ELSE 0 END) AS discovery,
        b.cursor, b.source_updated_at AS probe_source, b.target_plan_hash, b.progress_json,
        b.state_version AS probe_version
        FROM prs p JOIN pr_review_request_state r ON r.pr_id = p.id
        LEFT JOIN pr_review_probe_state b ON b.pr_id = p.id
        WHERE p.github_state = 'OPEN' AND p.github_node_id IS NOT NULL
        AND (? IS NULL OR p.id = ?) GROUP BY p.id
        HAVING ? = 1 OR ? IS NOT NULL OR discovery = 1 OR b.pr_id IS NOT NULL
          OR MAX(CASE WHEN r.acknowledged_revision IS NOT NULL AND
            (p.body_source_updated_at IS NOT p.updated_at OR r.event_source_updated_at IS NOT p.updated_at)
            THEN 1 ELSE 0 END) = 1`)
        .all(onlyId, onlyId, fullSweep ? 1 : 0, onlyId);
      const fresh = rows.filter((r) => r.discovery && !r.probe_version);
      const continuing = rows.filter((r) => r.probe_version);
      const audits = rows.filter((r) => !r.discovery && !r.probe_version);
      return fairReviewQueue(
        [fresh, continuing, audits],
        fullSweep ? [5, 5, 10] : [10, 10, 0],
        onlyId ? 1 : REVIEW_LIMITS.probes,
      );
    },
    targetHash(prId) {
      return digest(
        db.prepare('SELECT target_id FROM pr_review_request_state WHERE pr_id = ? ORDER BY target_id').all(prId),
      );
    },
    buildVerification(confirmations, probes) {
      const variables = {};
      const declarations = [];
      const roots = [];
      if (confirmations.length) {
        declarations.push('$confirmIds: [ID!]!');
        variables.confirmIds = confirmations.map((row) => row.github_node_id);
        roots.push(`confirm: nodes(ids: $confirmIds) { ... on PullRequest { ${PR_SUMMARY_FIELDS}
          reviewRequests(first: 100) { pageInfo { hasNextPage } nodes { requestedReviewer { ${REVIEWER_FIELDS} } } }
        } }`);
      }
      probes.forEach((row, index) => {
        declarations.push(`$probeId${index}: ID!`, `$before${index}: String`);
        variables[`probeId${index}`] = row.github_node_id;
        variables[`before${index}`] =
          row.probe_source === row.updated_at && row.target_plan_hash === api.targetHash(row.id) ? row.cursor : null;
        roots.push(`probe${index}: node(id: $probeId${index}) { ... on PullRequest { ${PR_SUMMARY_FIELDS} body
          timelineItems(last: 100, before: $before${index}, itemTypes: [REVIEW_REQUESTED_EVENT]) {
            pageInfo { hasPreviousPage startCursor }
            nodes { ... on ReviewRequestedEvent { id createdAt requestedReviewer { ${REVIEWER_FIELDS} } } }
          }
        } }`);
      });
      return { query: `query(${declarations.join(', ')}) { ${roots.join('\n')} }`, variables };
    },
    settleConfirmations(result, context) {
      const nodes = requireGraphqlRoot(result, 'confirm');
      if (!Array.isArray(nodes)) throw new Error('Incomplete reviewer confirmation result');
      for (const node of nodes) {
        if (!node) continue;
        const connection = node.reviewRequests;
        if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== 'boolean') continue;
        transaction(context, (keys) => {
          const row = prs.write(prs.prepare(node, 'summary', context), nowIso());
          keys.push(`pr:${row.id}`);
          context.snapshots.set(row.id, row.snapshot_version);
          for (const target of targets()) {
            const present = connection.nodes.some((request) => exactReviewer(request?.requestedReviewer, target));
            if (present || !connection.pageInfo.hasNextPage) {
              keys.push(reviews.verifyMatch(row.id, target, present, viewer, context, nowIso()));
              rememberOwnState(context, row.id, target.id);
            }
          }
        });
      }
      emit({ kind: 'list' });
    },
    settleProbe(node, selected, context) {
      let contentChanged = false;
      const connection = node.timelineItems;
      if (
        !Array.isArray(connection?.nodes) ||
        typeof connection.pageInfo?.hasPreviousPage !== 'boolean' ||
        (connection.pageInfo.hasPreviousPage && typeof connection.pageInfo.startCursor !== 'string')
      )
        throw new Error('Incomplete review event page');
      transaction(context, (keys) => {
        const persisted = db.prepare('SELECT * FROM pr_review_probe_state WHERE pr_id = ?').get(selected.id);
        if (
          (persisted?.state_version ?? null) !== (context.probes.get(selected.id) ?? null) ||
          !prs.fence.accepts(context.read, `probe:${selected.id}`)
        )
          throw new Error('A newer event scan superseded this page');
        const targetHash = api.targetHash(selected.id);
        const continuing =
          selected.cursor && selected.probe_source === selected.updated_at && selected.target_plan_hash === targetHash;
        if (
          continuing &&
          (node.updatedAt !== selected.probe_source ||
            node.headRefOid !== selected.head_oid ||
            node.title !== selected.title)
        ) {
          db.prepare('DELETE FROM pr_review_probe_state WHERE pr_id = ?').run(selected.id);
          keys.push(`probe:${selected.id}`);
          return;
        }
        const prepared = prs.prepare(node, 'body', context);
        contentChanged = !prepared.same;
        const row = prs.write(prepared, nowIso());
        keys.push(`pr:${row.id}`);
        context.snapshots.set(row.id, row.snapshot_version);
        const progress = continuing ? JSON.parse(selected.progress_json) : {};
        const states = db.prepare('SELECT * FROM pr_review_request_state WHERE pr_id = ?').all(row.id);
        let unresolved = false;
        for (const state of states) {
          const target = targets().find((value) => value.id === state.target_id);
          if (!target || progress[target.id]) continue;
          let found;
          for (const event of [...connection.nodes].reverse()) {
            if (!event?.id || !Number.isFinite(Date.parse(event.createdAt))) throw new Error('Invalid review event');
            if (exactReviewer(event.requestedReviewer, target)) {
              found = event;
              break;
            }
            if (
              state.event_id &&
              (event.id === state.event_id || Date.parse(event.createdAt) < Date.parse(state.event_at))
            ) {
              found = { id: state.event_id, createdAt: state.event_at };
              break;
            }
          }
          if (!found && !connection.pageInfo.hasPreviousPage && state.event_id)
            found = { id: state.event_id, createdAt: state.event_at };
          if (found) {
            keys.push(reviews.verifyEvent(row.id, target, found, node.updatedAt, context, nowIso()));
            rememberOwnState(context, row.id, target.id);
            progress[target.id] = true;
          } else {
            unresolved = true;
            keys.push(
              reviews.change(
                row.id,
                target.id,
                {
                  verification_status: connection.pageInfo.hasPreviousPage ? 'pending' : 'error',
                  verification_error: connection.pageInfo.hasPreviousPage
                    ? null
                    : 'No matching review request event was visible',
                },
                context,
              ),
            );
            rememberOwnState(context, row.id, target.id);
          }
        }
        if (unresolved && connection.pageInfo.hasPreviousPage) {
          db.prepare(`INSERT INTO pr_review_probe_state
            (pr_id, state_version, source_updated_at, head_oid, title, review_revision, target_plan_hash, cursor, progress_json, last_attempt_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(pr_id) DO UPDATE SET
            state_version=excluded.state_version, source_updated_at=excluded.source_updated_at,
            head_oid=excluded.head_oid, title=excluded.title, review_revision=excluded.review_revision,
            target_plan_hash=excluded.target_plan_hash, cursor=excluded.cursor, progress_json=excluded.progress_json,
            status='pending', error=NULL, last_attempt_at=excluded.last_attempt_at`).run(
            row.id,
            randomUUID(),
            node.updatedAt,
            node.headRefOid,
            node.title,
            row.review_revision,
            targetHash,
            connection.pageInfo.startCursor,
            JSON.stringify(progress),
            nowIso(),
          );
        } else db.prepare('DELETE FROM pr_review_probe_state WHERE pr_id = ?').run(row.id);
        keys.push(`probe:${row.id}`);
      });
      emit({ kind: contentChanged ? 'summary' : 'acknowledgement', ids: [selected.id] });
    },
    async verify(graphql, { fullSweep = false, onlyId = null } = {}) {
      const confirmations = onlyId ? [] : api.confirmations();
      const probes = api.probes(fullSweep, onlyId);
      if (!confirmations.length && !probes.length) return;
      assertCurrent();
      const attempted = [...new Set([...confirmations, ...probes].map((row) => row.id))];
      const now = nowIso();
      for (const row of confirmations)
        db.prepare('UPDATE pr_review_request_state SET last_attempt_at = ? WHERE pr_id = ?').run(now, row.id);
      for (const row of probes)
        db.prepare('UPDATE pr_review_request_state SET last_probe_attempt_at = ? WHERE pr_id = ?').run(now, row.id);
      const context = reviews.begin();
      try {
        const operation = api.buildVerification(confirmations, probes);
        const result = await graphql(operation.query, operation.variables, {
          maxAttempts: 1,
          predictedCost: onlyId ? 1 : 5,
        });
        assertCurrent();
        if (confirmations.length) {
          try {
            api.settleConfirmations(result, context);
          } catch (error) {
            api.verificationError(
              confirmations.map((row) => row.id),
              error,
            );
          }
        }
        probes.forEach((selected, index) => {
          try {
            api.settleProbe(requireGraphqlRoot(result, `probe${index}`), selected, context);
          } catch (error) {
            api.verificationError([selected.id], error);
          }
        });
      } catch (error) {
        api.verificationError(attempted, error);
        throw error;
      } finally {
        prs.end(context);
      }
    },
    verificationError(ids, error) {
      assertCurrent();
      db.prepare(`UPDATE pr_review_request_state SET verification_error = ?
        WHERE pr_id IN (SELECT value FROM json_each(?))`).run(error.message, JSON.stringify(ids));
      emit({ kind: 'status', ids });
    },
  };
  return api;
}
