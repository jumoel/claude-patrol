import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDb } from './db.js';
import { taggedError } from './errors.js';
import { PrReadFence } from './pr-read-fence.js';
import { deriveCIStatus } from './pr-status.js';
import { reviewRevision } from './review-revision.js';
import { makePrId, parseJsonColumn } from './utils.js';

const stores = new WeakMap();

export function extractChecks(pr) {
  return (pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []).map((ctx) => {
    if ('name' in ctx) {
      const workflow = ctx.checkSuite?.workflowRun?.workflow?.name;
      return {
        name: workflow ? `${workflow} / ${ctx.name}` : ctx.name,
        status: ctx.status,
        conclusion: ctx.conclusion,
        url: ctx.detailsUrl,
      };
    }
    return { name: ctx.context, status: ctx.state, conclusion: null, url: ctx.targetUrl };
  });
}

function summary(pr) {
  const row = {
    number: pr.number,
    title: pr.title,
    repo: pr.repository?.name,
    org: pr.repository?.owner?.login,
    author: pr.author?.login ?? '',
    url: pr.url,
    branch: pr.headRefName,
    head_oid: pr.headRefOid,
    base_branch: pr.baseRefName,
    is_fork: pr.isCrossRepository ? 1 : 0,
    draft: pr.isDraft ? 1 : 0,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    github_node_id: pr.id,
    github_state: pr.state,
  };
  if (
    !Number.isInteger(row.number) ||
    row.number < 1 ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(row.github_state) ||
    ['title', 'repo', 'org', 'url', 'branch', 'head_oid', 'base_branch', 'github_node_id'].some(
      (key) => typeof row[key] !== 'string',
    ) ||
    !Number.isFinite(Date.parse(row.updated_at)) ||
    !Number.isFinite(Date.parse(row.created_at))
  ) {
    throw taggedError('upstream_failed', 'GitHub returned an incomplete PR summary');
  }
  return row;
}

function bodyFields(pr) {
  const revision = reviewRevision(pr.headRefOid, pr.title, pr.body);
  if (!revision) throw taggedError('upstream_failed', 'GitHub returned an incomplete PR revision');
  return {
    body: pr.body,
    body_head_oid: pr.headRefOid,
    body_title: pr.title,
    review_revision: revision,
    body_source_updated_at: pr.updatedAt,
  };
}

function details(pr) {
  if (!pr.labels?.nodes || !pr.reviews?.nodes || !pr.comments?.nodes || !pr.commits?.nodes) {
    throw taggedError('upstream_failed', 'GitHub returned incomplete PR details');
  }
  return {
    ...bodyFields(pr),
    mergeable: pr.mergeable ?? 'UNKNOWN',
    checks: JSON.stringify(extractChecks(pr)),
    reviews: JSON.stringify(
      pr.reviews.nodes.map((r) => ({
        reviewer: r.author?.login ?? 'unknown',
        reviewer_type: r.author?.__typename ?? 'User',
        state: r.state,
        submitted_at: r.submittedAt,
      })),
    ),
    comments: JSON.stringify(
      pr.comments.nodes.map((c) => ({
        author: c.author?.login ?? 'unknown',
        author_type: c.author?.__typename ?? 'User',
        created_at: c.createdAt,
      })),
    ),
    labels: JSON.stringify(pr.labels.nodes.map((l) => ({ name: l.name, color: l.color }))),
    detail_source_updated_at: pr.updatedAt,
  };
}

function baseline(row) {
  return { checks: row.checks, mergeable: row.mergeable, draft: row.draft, labels: row.labels };
}

function transitions(previous, next) {
  if (!previous) return null;
  const changes = {};
  const beforeCI = deriveCIStatus(parseJsonColumn(previous.checks, []));
  const afterCI = deriveCIStatus(parseJsonColumn(next.checks, []));
  if (beforeCI !== afterCI) changes.ci_status = { from: beforeCI, to: afterCI };
  if (previous.mergeable !== next.mergeable) changes.mergeable = { from: previous.mergeable, to: next.mergeable };
  if (previous.draft !== next.draft) changes.draft = { from: !!previous.draft, to: !!next.draft };
  const a = new Set(parseJsonColumn(previous.labels, []).map((l) => l.name));
  const b = new Set(parseJsonColumn(next.labels, []).map((l) => l.name));
  const added = [...b].filter((name) => !a.has(name));
  const removed = [...a].filter((name) => !b.has(name));
  if (added.length || removed.length) changes.labels = { added, removed };
  return Object.keys(changes).length ? changes : null;
}

/** All write methods run in their caller's synchronous transaction. */
export function prStore(db = getDb()) {
  if (stores.has(db)) return stores.get(db);
  const fence = new PrReadFence();
  const get = db.prepare('SELECT * FROM prs WHERE id = ?');
  const byNode = db.prepare('SELECT * FROM prs WHERE github_node_id = ?');
  const store = {
    fence,
    begin() {
      return {
        read: fence.begin(),
        snapshots: new Map(
          db
            .prepare('SELECT id, snapshot_version FROM prs')
            .all()
            .map((row) => [row.id, row.snapshot_version]),
        ),
      };
    },
    end(context) {
      fence.end(context.read);
    },
    resolve(pr) {
      const localId = makePrId(pr.repository.owner.login, pr.repository.name, pr.number);
      const row = byNode.get(pr.id) ?? get.get(localId);
      if (row?.github_node_id && row.github_node_id !== pr.id) {
        throw taggedError('invalid_state', 'PR remote identity conflicts with the cached PR');
      }
      return { id: row?.id ?? localId, row };
    },
    prepare(pr, kind, context) {
      const fields = summary(pr);
      const { id, row } = store.resolve(pr);
      if (kind === 'details') Object.assign(fields, details(pr));
      if (kind === 'body') Object.assign(fields, bodyFields(pr));
      if (kind !== 'summary') {
        if (typeof pr.bodyHTML === 'string') fields.body_html = pr.bodyHTML;
        else if (!row || row.body !== pr.body) fields.body_html = '';
      }
      const same = !!row && Object.entries(fields).every(([key, value]) => isDeepStrictEqual(row[key], value));
      const stale =
        !fence.accepts(context.read, `pr:${id}`) ||
        (row && Date.parse(fields.updated_at) < Date.parse(row.updated_at)) ||
        (!same && (context.snapshots.get(id) ?? null) !== (row?.snapshot_version ?? null));
      if (stale) throw taggedError('invalid_state', `A newer PR observation superseded ${id}`);
      return { id, fields, row, same, kind, context };
    },
    write(prepared, now = new Date().toISOString()) {
      const { id, fields, row, same, kind, context } = prepared;
      const values = {
        ...fields,
        summary_synced_at: now,
        snapshot_version: same ? row.snapshot_version : randomUUID(),
        synced_at: row?.synced_at ?? now,
      };
      if (kind !== 'summary') values.body_synced_at = now;
      if (kind === 'details') {
        values.details_synced_at = now;
        values.synced_at = now;
      }
      const columns = Object.keys(values);
      db.prepare(`INSERT INTO prs (id, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})
        ON CONFLICT(id) DO UPDATE SET ${columns.map((key) => `${key} = excluded.${key}`).join(', ')}`).run(
        id,
        ...Object.values(values),
      );
      if (!same) {
        const ownStates = context.states
          ? db
              .prepare('SELECT target_id, state_version FROM pr_review_request_state WHERE pr_id = ?')
              .all(id)
              .filter((state) => context.states.get(JSON.stringify([id, state.target_id])) === state.state_version)
          : [];
        db.prepare(`UPDATE pr_review_request_state SET acknowledgement_invalidated = 1, state_version = lower(hex(randomblob(16)))
          WHERE pr_id = ? AND acknowledged_revision IS NOT NULL AND acknowledgement_invalidated = 0
          AND (acknowledged_head_oid != ? OR acknowledged_title != ? OR
            (? IS NOT NULL AND acknowledged_revision != ?))`).run(
          id,
          fields.head_oid,
          fields.title,
          kind === 'summary' ? null : fields.review_revision,
          kind === 'summary' ? null : fields.review_revision,
        );
        for (const state of ownStates) {
          const current = db
            .prepare('SELECT state_version FROM pr_review_request_state WHERE pr_id = ? AND target_id = ?')
            .get(id, state.target_id);
          context.states.set(JSON.stringify([id, state.target_id]), current.state_version);
        }
        db.prepare(`UPDATE review_watch_targets SET list_version = lower(hex(randomblob(16)))
          WHERE id IN (SELECT target_id FROM pr_review_request_state WHERE pr_id = ?)
          AND (? != ? OR ? != ? OR ? != ? OR ? != ? OR ? != ?)`).run(
          id,
          row?.updated_at ?? '',
          fields.updated_at,
          row?.head_oid ?? '',
          fields.head_oid,
          row?.title ?? '',
          fields.title,
          row?.review_revision ?? '',
          fields.review_revision ?? row?.review_revision ?? '',
          row?.github_state ?? '',
          fields.github_state,
        );
        if (fields.github_state !== 'OPEN') {
          db.prepare('DELETE FROM pr_review_request_state WHERE pr_id = ?').run(id);
          db.prepare('DELETE FROM pr_review_probe_state WHERE pr_id = ?').run(id);
        }
      }
      return get.get(id);
    },
    authored(row, viewer, now) {
      const existing = db.prepare('SELECT * FROM pr_authored_state WHERE pr_id = ?').get(row.id);
      const previous = existing?.viewer_id === viewer.id ? parseJsonColumn(existing.baseline_json, null) : null;
      const next = baseline(row);
      db.prepare(`INSERT INTO pr_authored_state (pr_id, viewer_id, last_seen_at, baseline_json)
        VALUES (?, ?, ?, ?) ON CONFLICT(pr_id) DO UPDATE SET viewer_id = excluded.viewer_id,
        last_seen_at = excluded.last_seen_at, missing_since = NULL, baseline_json = excluded.baseline_json`).run(
        row.id,
        viewer.id,
        now,
        JSON.stringify(next),
      );
      return { pr: row, prev: previous, changes: transitions(previous, next) };
    },
    collect() {
      return db
        .prepare(`DELETE FROM prs WHERE NOT EXISTS (SELECT 1 FROM pr_authored_state a WHERE a.pr_id = prs.id)
        AND NOT EXISTS (SELECT 1 FROM pr_review_request_state r WHERE r.pr_id = prs.id
          AND (r.match_state IN ('active', 'candidate') OR r.acknowledged_revision IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM work_item_pull_requests l WHERE l.pr_id = prs.id)
        AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.pr_id = prs.id)`)
        .run();
    },
  };
  stores.set(db, store);
  return store;
}
