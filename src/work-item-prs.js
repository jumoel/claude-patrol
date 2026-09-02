import { emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { taggedError } from './errors.js';
import { formatPR } from './pr-status.js';
import { execFile } from './utils.js';

const PR_ID_PATTERN = /^([^\s/#]+)\/([^\s/#]+)#([1-9]\d*)$/u;
const COMMIT_ID_PATTERN = /^[0-9a-f]{40,64}$/iu;

/** @param {string} value */
export function parsePullRequestReference(value) {
  if (typeof value !== 'string') throw taggedError('invalid_pull_request', 'Pull request must be a string');
  const trimmed = value.trim();
  let canonical = trimmed;
  if (/^https?:\/\//iu.test(trimmed)) {
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw taggedError('invalid_pull_request', 'Pull request URL is invalid');
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') {
      throw taggedError('invalid_pull_request', 'Pull request URL must use https://github.com');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[2] !== 'pull' || !/^[1-9]\d*$/u.test(parts[3])) {
      throw taggedError('invalid_pull_request', 'Expected a GitHub pull request URL');
    }
    canonical = `${parts[0]}/${parts[1]}#${parts[3]}`;
  }
  const match = PR_ID_PATTERN.exec(canonical);
  if (!match) throw taggedError('invalid_pull_request', 'Expected owner/repo#number or a GitHub pull request URL');
  const [, org, repo, number] = match;
  return {
    id: `${org}/${repo}#${number}`,
    org,
    repo,
    repository: `${org}/${repo}`,
    number: Number(number),
    url: `https://github.com/${org}/${repo}/pull/${number}`,
  };
}

function repositoriesFor(row) {
  if (!row?.id) return [];
  return getDb()
    .prepare('SELECT repo FROM work_item_repositories WHERE work_item_id = ? ORDER BY position, repo')
    .all(row.id)
    .map((entry) => entry.repo);
}

function linkedPullRequest(link, row = null) {
  const parsed = parsePullRequestReference(link.pr_id);
  if (!row) {
    return {
      ...parsed,
      title: null,
      branch: null,
      base_branch: null,
      draft: false,
      mergeable: 'UNKNOWN',
      ci_status: 'pending',
      review_status: 'pending',
      updated_at: null,
      tracked: false,
      linked_at: link.linked_at,
      link_source: link.source,
    };
  }
  const pr = formatPR(row);
  return {
    id: pr.id,
    org: pr.org,
    repo: pr.repo,
    repository: `${pr.org}/${pr.repo}`,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    branch: pr.branch,
    base_branch: pr.base_branch,
    draft: pr.draft,
    mergeable: pr.mergeable,
    ci_status: pr.ci_status,
    review_status: pr.review_status,
    updated_at: pr.updated_at,
    tracked: true,
    linked_at: link.linked_at,
    link_source: link.source,
  };
}

/** @param {string} workItemId */
export function listWorkItemPullRequests(workItemId) {
  const db = getDb();
  const links = db
    .prepare(
      `SELECT l.pr_id, l.work_item_id, l.source, l.linked_at
         FROM work_item_pull_requests l
        WHERE l.work_item_id = ?
        ORDER BY l.linked_at DESC, l.pr_id`,
    )
    .all(workItemId);
  const getPr = db.prepare('SELECT * FROM prs WHERE id = ?');
  return links
    .map((link) => linkedPullRequest(link, getPr.get(link.pr_id) ?? null))
    .sort((a, b) => (b.updated_at ?? b.linked_at).localeCompare(a.updated_at ?? a.linked_at));
}

/** @param {string[]} workItemIds */
export function listWorkItemPullRequestsBatch(workItemIds) {
  const ids = [...new Set(workItemIds)];
  const grouped = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return grouped;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = getDb()
    .prepare(
      `SELECT
         l.pr_id AS linked_pr_id,
         l.work_item_id AS linked_work_item_id,
         l.source AS linked_source,
         l.linked_at AS linked_at,
         p.*
       FROM work_item_pull_requests l
       LEFT JOIN prs p ON p.id = l.pr_id
       WHERE l.work_item_id IN (${placeholders})
       ORDER BY l.work_item_id, l.linked_at DESC, l.pr_id`,
    )
    .all(...ids);
  for (const row of rows) {
    const link = {
      pr_id: row.linked_pr_id,
      work_item_id: row.linked_work_item_id,
      source: row.linked_source,
      linked_at: row.linked_at,
    };
    const item = linkedPullRequest(link, row.id ? row : null);
    grouped.get(row.linked_work_item_id)?.push(item);
  }
  for (const pullRequests of grouped.values()) {
    pullRequests.sort((a, b) => (b.updated_at ?? b.linked_at).localeCompare(a.updated_at ?? a.linked_at));
  }
  return grouped;
}

/** @param {string} prId */
export function getPullRequestOwner(prId) {
  return (
    getDb()
      .prepare(
        `SELECT wi.id, wr.reference, wi.title, wi.state, l.source, l.linked_at
           FROM work_item_pull_requests l
           JOIN work_items wi ON wi.id = l.work_item_id
           LEFT JOIN work_item_references wr ON wr.work_item_id = wi.id
          WHERE l.pr_id = ?`,
      )
      .get(prId) ?? null
  );
}

/** @param {object[]} prs */
export function enrichPullRequestsWithOwners(prs, db = getDb()) {
  const owners = new Map(
    db
      .prepare(
        `SELECT l.pr_id, wi.id, wr.reference, wi.title, wi.state, l.source, l.linked_at
           FROM work_item_pull_requests l
           JOIN work_items wi ON wi.id = l.work_item_id
           LEFT JOIN work_item_references wr ON wr.work_item_id = wi.id`,
      )
      .all()
      .map((row) => [row.pr_id, row]),
  );
  for (const pr of prs) {
    const owner = owners.get(pr.id) ?? null;
    pr.work_item_id = owner?.id ?? null;
    pr.work_item = owner ? { id: owner.id, reference: owner.reference, title: owner.title, state: owner.state } : null;
  }
  return prs;
}

export function linkWorkItemPullRequest(workItemId, pullRequest, { source = 'explicit', emit = true } = {}) {
  const db = getDb();
  const workItem = db.prepare('SELECT * FROM work_items WHERE id = ?').get(workItemId);
  if (!workItem) throw taggedError('work_item_not_found', 'Work item not found');
  if (['destroying', 'destroyed'].includes(workItem.state)) {
    throw taggedError('invalid_state', 'Destroyed work items cannot accept pull requests');
  }
  const parsed = parsePullRequestReference(pullRequest);
  if (!repositoriesFor(workItem).includes(parsed.repository)) {
    throw taggedError(
      'repository_not_in_work_item',
      `Pull request repository is not part of this work item: ${parsed.repository}`,
    );
  }
  const current = db.prepare('SELECT * FROM work_item_pull_requests WHERE pr_id = ?').get(parsed.id);
  if (current?.work_item_id === workItemId)
    return linkedPullRequest(current, db.prepare('SELECT * FROM prs WHERE id = ?').get(parsed.id));
  if (current) {
    throw taggedError(
      'pull_request_owned',
      `Pull request ${parsed.id} already belongs to work item ${current.work_item_id}`,
    );
  }
  const link = { pr_id: parsed.id, work_item_id: workItemId, source, linked_at: new Date().toISOString() };
  db.prepare('INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at) VALUES (?, ?, ?, ?)').run(
    link.pr_id,
    link.work_item_id,
    link.source,
    link.linked_at,
  );
  if (emit) emitLocalChange();
  return linkedPullRequest(link, db.prepare('SELECT * FROM prs WHERE id = ?').get(parsed.id));
}

export function unlinkWorkItemPullRequest(workItemId, pullRequest) {
  const parsed = parsePullRequestReference(pullRequest);
  const db = getDb();
  const current = db.prepare('SELECT work_item_id FROM work_item_pull_requests WHERE pr_id = ?').get(parsed.id);
  if (!current) return { removed: false, pr_id: parsed.id, work_item_id: workItemId };
  if (current.work_item_id !== workItemId) {
    throw taggedError('pull_request_owned', `Pull request ${parsed.id} belongs to another work item`);
  }
  db.prepare('DELETE FROM work_item_pull_requests WHERE pr_id = ?').run(parsed.id);
  emitLocalChange();
  return { removed: true, pr_id: parsed.id, work_item_id: workItemId };
}

/**
 * Negative provenance results, keyed by PR head, checkout path and the
 * checkout's base commit. A `jj log` answer only changes when one of those
 * three changes, so an unowned PR that did not match a checkout last cycle is
 * not asked again. Bounded and insertion-ordered so the oldest entries fall
 * out first.
 * @type {Map<string, true>}
 */
const provenanceMisses = new Map();
const PROVENANCE_MISS_LIMIT = 5000;

function rememberMiss(cache, key) {
  if (cache.size >= PROVENANCE_MISS_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, true);
}

/**
 * Link unowned PRs when their GitHub head is provably in exactly one work-item
 * checkout's immutable history. `--ignore-working-copy` keeps reconciliation
 * read-only and avoids snapshotting an agent's in-progress edits.
 *
 * Runs every poll cycle for every unowned open PR, so the cost is one `jj log`
 * per (PR, candidate checkout) pair minus the pairs already known not to
 * match (see provenanceMisses).
 */
export async function reconcileWorkItemPullRequests(
  prIds,
  { runExec = execFile, logger = console, missCache = provenanceMisses } = {},
) {
  const ids = [...new Set((prIds ?? []).filter((id) => typeof id === 'string'))];
  if (ids.length === 0) return [];
  const db = getDb();
  const placeholders = ids.map(() => '?').join(', ');
  const prs = db
    .prepare(
      `SELECT p.id, p.org, p.repo, p.head_oid, p.created_at
         FROM prs p
         LEFT JOIN work_item_pull_requests l ON l.pr_id = p.id
        WHERE p.id IN (${placeholders})
          AND l.pr_id IS NULL
          AND p.head_oid IS NOT NULL`,
    )
    .all(...ids)
    .filter((pr) => COMMIT_ID_PATTERN.test(pr.head_oid));
  const candidates = db.prepare(
    `SELECT w.work_item_id, w.path, w.base_commit
       FROM workspaces w
       JOIN work_items wi ON wi.id = w.work_item_id
      WHERE w.repo = ?
        AND w.status = 'active'
        AND w.operation_state = 'ready'
        AND wi.state IN ('ready', 'error')
        AND wi.created_at <= ?`,
  );
  const linked = [];
  for (const pr of prs) {
    const matches = [];
    for (const candidate of candidates.all(`${pr.org}/${pr.repo}`, pr.created_at)) {
      if (candidate.base_commit === pr.head_oid) continue;
      const missKey = `${pr.head_oid}|${candidate.path}|${candidate.base_commit ?? ''}`;
      if (missCache.has(missKey)) continue;
      try {
        const { stdout } = await runExec(
          'jj',
          [
            '--ignore-working-copy',
            'log',
            '--no-graph',
            '-r',
            `${pr.head_oid} & ::@`,
            '-T',
            'commit_id ++ "\\n"',
            '-R',
            candidate.path,
          ],
          { encoding: 'utf8' },
        );
        if (
          String(stdout)
            .split(/\r?\n/u)
            .some((line) => line.trim() === pr.head_oid)
        ) {
          matches.push(candidate.work_item_id);
        } else {
          rememberMiss(missCache, missKey);
        }
      } catch {
        // A missing commit or removed checkout is not a provenance match.
        rememberMiss(missCache, missKey);
      }
    }
    const unique = [...new Set(matches)];
    if (unique.length === 1) {
      linked.push(linkWorkItemPullRequest(unique[0], pr.id, { source: 'provenance' }));
    } else if (unique.length > 1) {
      logger.warn(`[work-items] PR provenance is ambiguous for ${pr.id}: ${unique.join(', ')}`);
    }
  }
  return linked;
}
