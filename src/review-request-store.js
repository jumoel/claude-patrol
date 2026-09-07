import { randomUUID } from 'node:crypto';
import { getDb, withTransaction } from './db.js';
import { taggedError } from './errors.js';
import { prStore } from './pr-store.js';
import { sanitizePublicText } from './public-errors.js';
import {
  digest,
  inReviewScope,
  normalizedScope,
  reviewPlanId,
  reviewShards,
  reviewTargets,
} from './review-request-query.js';

const stateKey = (id, target) => JSON.stringify([id, target]);
const semanticFields = new Set([
  'match_state',
  'proof_viewer_id',
  'event_id',
  'verification_status',
  'acknowledged_event_id',
  'acknowledged_revision',
  'acknowledged_head_oid',
  'acknowledged_title',
  'acknowledgement_invalidated',
]);

export function reviewStore(db = getDb()) {
  const prs = prStore(db);
  const getState = db.prepare('SELECT * FROM pr_review_request_state WHERE pr_id = ? AND target_id = ?');
  const store = {
    begin() {
      return {
        ...prs.begin(),
        states: new Map(
          db
            .prepare('SELECT pr_id, target_id, state_version FROM pr_review_request_state')
            .all()
            .map((row) => [stateKey(row.pr_id, row.target_id), row.state_version]),
        ),
        probes: new Map(
          db
            .prepare('SELECT pr_id, state_version FROM pr_review_probe_state')
            .all()
            .map((row) => [row.pr_id, row.state_version]),
        ),
      };
    },
    reconcile(poll, viewer) {
      const targets = reviewTargets(poll, viewer);
      const shards = reviewShards(poll, viewer);
      const generation = digest([reviewPlanId(poll), viewer?.id ?? null]);
      return withTransaction(db, () => {
        const ids = JSON.stringify(targets.map((target) => target.id));
        db.prepare('DELETE FROM review_watch_targets WHERE id NOT IN (SELECT value FROM json_each(?))').run(ids);
        for (const target of targets) {
          const previous = db.prepare('SELECT * FROM review_watch_targets WHERE id = ?').get(target.id);
          db.prepare(`INSERT INTO review_watch_targets
            (id, kind, name, configured_values, viewer_id, generation, list_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
            configured_values = excluded.configured_values, viewer_id = excluded.viewer_id,
            generation = excluded.generation, enabled = 1`).run(
            target.id,
            target.kind,
            target.name,
            JSON.stringify(target.configured_values),
            target.viewer_id,
            generation,
            randomUUID(),
            new Date().toISOString(),
          );
          if (previous && previous.generation !== generation) {
            db.prepare('UPDATE review_watch_targets SET list_version = ? WHERE id = ?').run(randomUUID(), target.id);
          }
        }
        db.prepare('DELETE FROM review_watch_scopes WHERE id NOT IN (SELECT value FROM json_each(?))').run(
          JSON.stringify(shards.map((shard) => shard.id)),
        );
        for (const shard of shards) {
          db.prepare(`INSERT INTO review_watch_scopes (id, target_id, query_hash, query) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING`).run(shard.id, shard.target_id, shard.query_hash, shard.query);
        }
        for (const row of db
          .prepare(`SELECT DISTINCT p.id, p.org, p.repo FROM prs p
          JOIN pr_review_request_state r ON r.pr_id = p.id`)
          .all()) {
          if (!inReviewScope(row, poll)) db.prepare('DELETE FROM pr_review_request_state WHERE pr_id = ?').run(row.id);
        }
        prs.collect();
        return generation;
      });
    },
    targets() {
      return db.prepare('SELECT * FROM review_watch_targets WHERE enabled = 1 ORDER BY id').all();
    },
    orderingKey(prId) {
      const row = db
        .prepare(`SELECT p.id, p.updated_at, MIN(CASE WHEN r.acknowledged_revision IS NOT NULL
        AND r.acknowledgement_invalidated = 0 AND r.acknowledged_head_oid = p.head_oid
        AND r.acknowledged_title = p.title AND r.acknowledged_revision = p.review_revision
        AND r.acknowledged_event_id = r.event_id THEN 1 ELSE 0 END) AS collapsed
        FROM prs p JOIN pr_review_request_state r ON r.pr_id = p.id
        JOIN review_watch_targets t ON t.id = r.target_id AND t.enabled = 1
        JOIN sync_state s ON s.id = 1 AND s.viewer_verified = 1 AND s.viewer_id = r.proof_viewer_id
        WHERE p.id = ? AND p.github_state = 'OPEN' AND r.match_state != 'candidate' GROUP BY p.id`)
        .get(prId);
      return JSON.stringify(row ?? null);
    },
    bumpList(prId) {
      db.prepare(`UPDATE review_watch_targets SET list_version = lower(hex(randomblob(16)))
        WHERE id IN (SELECT target_id FROM pr_review_request_state WHERE pr_id = ?)`).run(prId);
    },
    change(prId, targetId, patch, context) {
      const orderingBefore = store.orderingKey(prId);
      const key = stateKey(prId, targetId);
      const existing = getState.get(prId, targetId);
      const same =
        existing &&
        Object.entries(patch)
          .filter(([name]) => semanticFields.has(name))
          .every(([name, value]) => existing[name] === value);
      if (
        !prs.fence.accepts(context.read, `review:${key}`) ||
        (!same && (context.states.get(key) ?? null) !== (existing?.state_version ?? null))
      ) {
        throw taggedError('invalid_state', 'A newer review observation superseded this response');
      }
      const values = { ...patch, state_version: same ? existing.state_version : randomUUID() };
      if (existing) {
        db.prepare(`UPDATE pr_review_request_state SET ${Object.keys(values)
          .map((name) => `${name} = ?`)
          .join(', ')}
          WHERE pr_id = ? AND target_id = ?`).run(...Object.values(values), prId, targetId);
      } else {
        db.prepare(`INSERT INTO pr_review_request_state (pr_id, target_id, ${Object.keys(values).join(', ')})
          VALUES (?, ?, ${Object.keys(values)
            .map(() => '?')
            .join(', ')})`).run(prId, targetId, ...Object.values(values));
      }
      if (orderingBefore !== store.orderingKey(prId)) store.bumpList(prId);
      return `review:${key}`;
    },
    discover(prId, target, viewer, context, now) {
      const existing = getState.get(prId, target.id);
      const direct = target.kind === 'team' || target.viewer_id === viewer.id;
      return store.change(
        prId,
        target.id,
        {
          last_seen_at: now,
          match_state: direct ? 'active' : (existing?.match_state ?? 'candidate'),
          ...(direct ? { proof_viewer_id: viewer.id } : {}),
          ...(direct && existing?.match_state === 'inactive' ? { verification_status: 'pending' } : {}),
        },
        context,
      );
    },
    verifyMatch(prId, target, present, viewer, context, now) {
      const existing = getState.get(prId, target.id);
      if (!existing) return null;
      if (!present && !existing.acknowledged_revision) {
        const key = stateKey(prId, target.id);
        if (!prs.fence.accepts(context.read, `review:${key}`) || context.states.get(key) !== existing.state_version) {
          throw taggedError('invalid_state', 'Review state changed during removal verification');
        }
        store.bumpList(prId);
        db.prepare('DELETE FROM pr_review_request_state WHERE pr_id = ? AND target_id = ?').run(prId, target.id);
        return `review:${key}`;
      }
      return store.change(
        prId,
        target.id,
        {
          match_state: present ? 'active' : 'inactive',
          proof_viewer_id: viewer.id,
          last_verified_at: now,
          last_attempt_at: now,
          ...(present && existing.match_state === 'inactive' ? { verification_status: 'pending' } : {}),
        },
        context,
      );
    },
    verifyEvent(prId, target, event, sourceUpdatedAt, context, now) {
      const existing = getState.get(prId, target.id);
      if (!existing) return null;
      return store.change(
        prId,
        target.id,
        {
          event_id: event.id,
          event_at: event.createdAt,
          event_source_updated_at: sourceUpdatedAt,
          verification_status: 'verified',
          verification_error: null,
          last_verified_at: now,
          acknowledgement_invalidated:
            existing.acknowledgement_invalidated ||
            (existing.acknowledged_event_id && existing.acknowledged_event_id !== event.id ? 1 : 0),
        },
        context,
      );
    },
    source(poll) {
      const identity = db.prepare('SELECT viewer_id, viewer_login, viewer_verified FROM sync_state WHERE id = 1').get();
      const scopes = db
        .prepare(`SELECT s.*, t.name, t.kind FROM review_watch_scopes s
        JOIN review_watch_targets t ON t.id = s.target_id WHERE t.enabled = 1`)
        .all();
      const configured = reviewTargets(poll).length > 0 && (poll.orgs?.length ?? 0) + (poll.repos?.length ?? 0) > 0;
      const successful = scopes.filter((scope) => scope.first_synced_at);
      const syncedAt =
        successful.length === scopes.length && scopes.length
          ? successful.map((scope) => scope.first_synced_at).sort()[0]
          : null;
      return {
        enabled: configured,
        plan_id: reviewPlanId(poll),
        identity_verified: !!identity.viewer_verified,
        synced_at: syncedAt,
        stale: !syncedAt || Date.now() - Date.parse(syncedAt) > poll.interval_seconds * 2000,
        incomplete: scopes.some((scope) => !!scope.incomplete || !!scope.limited),
        errors: scopes
          .filter((scope) => scope.error)
          .map((scope) => ({ target: scope.target_id, message: sanitizePublicText(scope.error) })),
      };
    },
    listVersion(poll) {
      return digest([
        reviewPlanId(poll),
        db.prepare('SELECT id, list_version FROM review_watch_targets ORDER BY id').all(),
      ]);
    },
    aggregateSql(poll) {
      const scope = normalizedScope(poll);
      return {
        sql: `WITH aggregates AS (
        SELECT p.id, p.updated_at, MIN(CASE WHEN
          r.acknowledged_revision IS NOT NULL AND r.acknowledgement_invalidated = 0
          AND r.acknowledged_head_oid = p.head_oid AND r.acknowledged_title = p.title
          AND r.acknowledged_revision = p.review_revision AND r.acknowledged_event_id = r.event_id
          THEN 1 ELSE 0 END) AS collapsed
        FROM prs p JOIN pr_review_request_state r ON r.pr_id = p.id
        JOIN review_watch_targets t ON t.id = r.target_id AND t.enabled = 1
        JOIN sync_state s ON s.id = 1 AND s.viewer_verified = 1 AND s.viewer_id = r.proof_viewer_id
        WHERE p.github_state = 'OPEN' AND r.match_state != 'candidate'
          AND (lower(p.org) IN (SELECT value FROM json_each(?))
            OR lower(p.org || '/' || p.repo) IN (SELECT value FROM json_each(?)))
        GROUP BY p.id)`,
        params: [JSON.stringify(scope.orgs), JSON.stringify(scope.repos)],
      };
    },
    rows(ids, poll) {
      if (!ids.length) return [];
      const { sql, params } = store.aggregateSql(poll);
      const rows = db
        .prepare(`${sql} SELECT p.*, a.collapsed FROM aggregates a JOIN prs p ON p.id = a.id
        WHERE p.id IN (SELECT value FROM json_each(?))`)
        .all(...params, JSON.stringify(ids));
      const states = db
        .prepare(`SELECT r.*, t.name, t.kind, t.configured_values FROM pr_review_request_state r
        JOIN review_watch_targets t ON t.id = r.target_id AND t.enabled = 1
        JOIN sync_state s ON s.id = 1 AND s.viewer_verified = 1 AND s.viewer_id = r.proof_viewer_id
        WHERE r.pr_id IN (SELECT value FROM json_each(?)) AND r.match_state != 'candidate'
        ORDER BY r.target_id`)
        .all(JSON.stringify(ids));
      const mapped = new Map(
        rows.map((row) => {
          const targets = states.filter((state) => state.pr_id === row.id);
          return [
            row.id,
            {
              id: row.id,
              number: row.number,
              title: row.title,
              org: row.org,
              repo: row.repo,
              author: row.author,
              url: row.url,
              head_oid: row.head_oid,
              updated_at: row.updated_at,
              collapsed: !!row.collapsed,
              review_revision: row.review_revision,
              state_version: digest([
                row.head_oid,
                row.title,
                row.review_revision,
                targets.map((target) => [target.target_id, target.state_version]),
              ]),
              verification_pending:
                targets.some(
                  (target) =>
                    target.verification_status !== 'verified' || target.event_source_updated_at !== row.updated_at,
                ) ||
                row.body_source_updated_at !== row.updated_at ||
                row.body_head_oid !== row.head_oid ||
                row.body_title !== row.title,
              targets: targets.map((target) => ({
                id: target.target_id,
                kind: target.kind,
                label: JSON.parse(target.configured_values).includes('@me') ? '@me' : target.name,
                active: target.match_state === 'active',
                requested_at: target.event_at,
                verified_at: target.last_verified_at,
                error: target.verification_error,
              })),
            },
          ];
        }),
      );
      return ids.flatMap((id) => (mapped.has(id) ? [mapped.get(id)] : []));
    },
    list(poll, { limit = 50, cursor = null, ids = null, statusOnly = false } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (ids && (ids.length > 100 || cursor))) {
        throw taggedError('invalid_request', 'Review reads are limited to 100 rows');
      }
      return withTransaction(db, () => {
        const version = store.listVersion(poll);
        const { sql, params } = store.aggregateSql(poll);
        const total = db.prepare(`${sql} SELECT COUNT(*) AS n FROM aggregates`).get(...params).n;
        const base = { source: store.source(poll), total_count: total, list_version: version };
        if (statusOnly) return base;
        if (ids) {
          const rows = store.rows([...new Set(ids)], poll);
          return { ...base, rows, missing_ids: ids.filter((id) => !rows.some((row) => row.id === id)) };
        }
        let after = '';
        if (cursor) {
          let decoded;
          try {
            decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          } catch {
            throw taggedError('invalid_request', 'Invalid review cursor');
          }
          if (
            !Array.isArray(decoded) ||
            decoded.length !== 4 ||
            ![0, 1].includes(decoded[1]) ||
            typeof decoded[2] !== 'string' ||
            typeof decoded[3] !== 'string'
          ) {
            throw taggedError('invalid_request', 'Invalid review cursor');
          }
          if (decoded[0] !== version) throw taggedError('invalid_state', 'Review ordering changed; restart pagination');
          after = 'WHERE collapsed > ? OR (collapsed = ? AND (updated_at < ? OR (updated_at = ? AND id > ?)))';
          params.push(decoded[1], decoded[1], decoded[2], decoded[2], decoded[3]);
        }
        const page = db
          .prepare(`${sql} SELECT * FROM aggregates ${after}
          ORDER BY collapsed, updated_at DESC, id LIMIT ?`)
          .all(...params, limit + 1);
        const more = page.length > limit;
        const selected = page.slice(0, limit);
        const last = selected.at(-1);
        return {
          ...base,
          rows: store.rows(
            selected.map((row) => row.id),
            poll,
          ),
          next_cursor: more
            ? Buffer.from(JSON.stringify([version, last.collapsed, last.updated_at, last.id])).toString('base64url')
            : null,
        };
      });
    },
    acknowledge(poll, id, expectedVersion, collapsed, context) {
      return withTransaction(db, () => {
        const row = store.rows([id], poll)[0];
        if (!row) {
          if (!collapsed) return { removed: true, id };
          throw taggedError('pr_not_found', 'Review request is no longer visible');
        }
        if (row.state_version !== expectedVersion || !prs.fence.current(context.read)) {
          throw taggedError('invalid_state', 'Review changed before acknowledgement', { detail: row });
        }
        if (row.collapsed === collapsed && (collapsed || row.targets.every((target) => target.active)))
          return { row, keys: [] };
        if (collapsed && (row.verification_pending || !row.review_revision)) {
          throw taggedError('review_not_ready', 'Review revision and request event need verification');
        }
        const keys = [];
        for (const target of row.targets) {
          const state = getState.get(id, target.id);
          if (!collapsed && state.match_state === 'inactive') {
            if (context.states.get(stateKey(id, target.id)) !== state.state_version) {
              throw taggedError('invalid_state', 'Review state changed before expansion');
            }
            store.bumpList(id);
            db.prepare('DELETE FROM pr_review_request_state WHERE pr_id = ? AND target_id = ?').run(id, target.id);
            keys.push(`review:${stateKey(id, target.id)}`);
          } else {
            keys.push(
              store.change(
                id,
                target.id,
                {
                  acknowledged_event_id: collapsed ? state.event_id : null,
                  acknowledged_revision: collapsed ? row.review_revision : null,
                  acknowledged_head_oid: collapsed ? row.head_oid : null,
                  acknowledged_title: collapsed ? row.title : null,
                  acknowledgement_invalidated: 0,
                },
                context,
              ),
            );
          }
        }
        return { row: store.rows([id], poll)[0] ?? null, removed: !store.rows([id], poll).length, id, keys };
      });
    },
  };
  return store;
}
