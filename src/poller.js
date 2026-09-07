import { EventEmitter } from 'node:events';
import { unlinkSync } from 'node:fs';
import { emitLocalChange, emitReviewRequestChange } from './app-events.js';
import { getDb, withTransaction } from './db.js';
import { githubClient } from './github-client.js';
import { requireGraphqlRoot } from './github-graphql.js';
import { formatPR } from './pr-status.js';
import { prStore } from './pr-store.js';
import { createReviewPoller } from './review-request-poller.js';
import { composeReviewSearch, normalizedScope } from './review-request-query.js';
import { reviewStore } from './review-request-store.js';
import { SingleFlight } from './single-flight.js';
import { makePrId } from './utils.js';
import { reconcileWorkItemPullRequests } from './work-item-prs.js';
import { destroyWorkspace } from './workspace.js';

export const pollerEvents = new EventEmitter();

/**
 * External effects of a poll cycle, injectable so pollOnce can run in tests
 * without gh, jj or a real workspace on disk.
 */
const defaultPollerDeps = Object.freeze({
  graphql: (query, variables) => ghGraphql(query, variables),
  destroyWorkspace,
  reconcileWorkItemPullRequests,
});

// Page size 50 with 30 inline check contexts. Larger inline payloads
// can 504 from GitHub's gateway. Pagination picks up the rest for PRs that
// exceed 30 checks (see CHECKS_PAGE_QUERY).
export const GRAPHQL_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id
        state
        number
        title
        body
        url
        isDraft
        headRefName
        headRefOid
        baseRefName
        isCrossRepository
        mergeable
        createdAt
        updatedAt
        author { login }
        repository { name owner { login } }
        labels(first: 10) { nodes { name color } }
        reviews(first: 50) { nodes { author { login __typename } state submittedAt } }
        comments(first: 50) { nodes { author { login __typename } createdAt } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 30) {
                  pageInfo { hasNextPage endCursor }
                  nodes {
                    ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Single-PR query used by the "force refresh" path. Mirrors the inline PR
// fragment in GRAPHQL_QUERY plus bodyHTML, so the cached html on the detail
// view stays consistent with the rest of the refreshed fields.
const SINGLE_PR_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      number
      title
      body
      bodyHTML
      url
      state
      isDraft
      headRefName
      headRefOid
      baseRefName
      isCrossRepository
      mergeable
      createdAt
      updatedAt
      author { login }
      repository { name owner { login } }
      labels(first: 10) { nodes { name color } }
      reviews(first: 50) { nodes { author { login __typename } state submittedAt } }
      comments(first: 50) { nodes { author { login __typename } createdAt } }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 30) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const CHECKS_PAGE_QUERY = `
query($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on PullRequest {
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
                  ... on StatusContext { context state targetUrl }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Id-only enumeration of every open PR for a role. Deliberately pulls no
// reviews/comments/checks - those heavy connections are what made a full
// search expensive, and cleanup only needs to know which tracked PRs are
// still open. Cheap enough to run every cycle so merged/closed PRs (and
// their workspaces) get torn down promptly instead of waiting for the next
// 30-minute full sweep.
const OPEN_IDS_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id
        number
        repository { name owner { login } }
      }
    }
  }
}
`;

/** Shared quota and cooldown state for every GitHub operation. */
export function getGhRateLimitState() {
  return githubClient().rateLimit();
}
async function ghGraphql(query, variables, options) {
  return githubClient().request(query, variables, options);
}

const detailRequests = new Map();

/** Join concurrent detail requests for a PR; do not queue a second refresh. */
export function refreshSinglePR(prId, config) {
  const client = githubClient();
  client.configure(config.poll);
  const observation = client.capture();
  const key = `${observation.generation}:${prId}`;
  if (detailRequests.has(key)) return detailRequests.get(key);
  const request = client
    .withOptionalWork(() => refreshPRDetails(prId, config, observation))
    .finally(() => {
      if (detailRequests.get(key) === request) detailRequests.delete(key);
    });
  detailRequests.set(key, request);
  return request;
}

async function refreshPRDetails(prId, config, observation) {
  const db = getDb();
  const client = githubClient(db);
  observation.assertCurrent();
  const store = prStore(db);
  const existing = db.prepare('SELECT * FROM prs WHERE id = ?').get(prId);
  if (!existing) throw new Error(`PR not tracked: ${prId}`);
  const context = store.begin();
  try {
    const graphql = (query, variables) => client.request(query, variables, { observation, optional: true });
    const result = await graphql(SINGLE_PR_QUERY, {
      owner: existing.org,
      name: existing.repo,
      number: existing.number,
    });
    const pr = requireGraphqlRoot(result, 'repository').pullRequest;
    if (!pr) throw new Error(`GitHub returned no pull request for ${prId}`);
    const connection = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (connection?.pageInfo?.hasNextPage) {
      connection.nodes.push(
        ...(await fetchRemainingChecks(pr.id, connection.pageInfo.endCursor, graphql, pr.headRefOid)),
      );
      connection.pageInfo.hasNextPage = false;
    }
    const row = withTransaction(db, () => {
      observation.assertCurrent();
      const row = store.write(store.prepare(pr, 'details', context));
      if (pr.state !== 'OPEN') db.prepare('DELETE FROM pr_authored_state WHERE pr_id = ?').run(row.id);
      return row;
    });
    store.fence.accept(context.read, [`pr:${row.id}`]);
    if (pr.state !== 'OPEN') await cleanupStalePR(row.id, config);
    emitReviewRequestChange({ kind: 'detail', ids: [row.id] });
    return { removed: pr.state !== 'OPEN', state: pr.state };
  } finally {
    store.end(context);
  }
}

/**
 * A search page without `data.search` is a failed fetch, never an empty set.
 * Only a complete enumeration may mark unseen authored PRs for a direct probe.
 * Search absence never proves closure or authorizes workspace deletion.
 * @param {object} result parsed GraphQL body
 * @param {string} qualifier for the error message
 */
function requireSearchResult(result, qualifier) {
  const search = requireGraphqlRoot(result, 'search');
  if (!search || !Array.isArray(search.nodes) || !search.pageInfo) {
    throw new Error(
      `gh graphql returned no search result for ${qualifier}: ${JSON.stringify(result ?? null).slice(0, 200)}`,
    );
  }
  return search;
}

/**
 * Fetch remaining check contexts for a PR via pagination.
 * @param {string} nodeId - GitHub node ID of the PR
 * @param {string} startCursor - endCursor from the initial page
 * @returns {Promise<object[]>} additional context nodes
 */
async function fetchRemainingChecks(nodeId, startCursor, graphql = ghGraphql, expectedHead) {
  const extra = [];
  let cursor = startCursor;
  let hasNext = true;

  while (hasNext) {
    const result = await graphql(CHECKS_PAGE_QUERY, { id: nodeId, cursor });
    const node = requireGraphqlRoot(result, 'node');
    if (!expectedHead || node.headRefOid !== expectedHead) throw new Error('PR head changed during check pagination');
    const contexts = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (!Array.isArray(contexts?.nodes) || !contexts.pageInfo) throw new Error('Incomplete check page');
    extra.push(...contexts.nodes);
    hasNext = contexts.pageInfo.hasNextPage;
    cursor = contexts.pageInfo.endCursor;
  }

  return extra;
}

/**
 * Fetch all open PRs for a search qualifier, handling pagination.
 * Also paginates check contexts for PRs that exceed the inline page.
 *
 * @param {string} qualifier - e.g. "org:foo" or "repo:owner/repo" or
 *   "org:a org:b repo:c/d" (multiple qualifiers are OR'd by GitHub search).
 * @param {string | null} [sinceIso] - if set, restricts the search to PRs
 *   updated at or after this ISO timestamp via `updated:>=`. Used by
 *   incremental polls to avoid refetching unchanged PRs.
 * @returns {Promise<{prs: object[]}>}
 */
async function fetchPRs(qualifier, sinceIso = null, graphql = ghGraphql) {
  const allPRs = [];
  let cursor = null;
  let hasNext = true;

  const sinceClause = sinceIso ? ` updated:>=${sinceIso}` : '';
  while (hasNext) {
    const vars = { q: `${qualifier} is:pr is:open author:@me${sinceClause} sort:updated-desc` };
    if (cursor) vars.cursor = cursor;
    const result = await graphql(GRAPHQL_QUERY, vars);
    const search = requireSearchResult(result, qualifier);
    allPRs.push(...search.nodes);

    hasNext = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }

  // Paginate checks that do not fit in the inline page.
  for (const pr of allPRs) {
    const contextsConn = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (contextsConn?.pageInfo?.hasNextPage) {
      const extra = await fetchRemainingChecks(pr.id, contextsConn.pageInfo.endCursor, graphql, pr.headRefOid);
      contextsConn.nodes.push(...extra);
      contextsConn.pageInfo.hasNextPage = false;
    }
  }

  return { prs: allPRs };
}

/**
 * Enumerate the ids of every open authored PR. Used to drive stale cleanup
 * on incremental cycles, where the
 * heavy `updated:>=` search returns only recently-changed PRs and so can't
 * tell "merged/closed" apart from "not updated lately".
 * @param {string} qualifier
 * @returns {Promise<Array<{id: string, org: string, repo: string}>>}
 */
async function fetchOpenPRIds(qualifier, graphql = ghGraphql) {
  const out = [];
  let cursor = null;
  let hasNext = true;
  while (hasNext) {
    const vars = { q: `${qualifier} is:pr is:open author:@me` };
    if (cursor) vars.cursor = cursor;
    const result = await graphql(OPEN_IDS_QUERY, vars);
    const search = requireSearchResult(result, qualifier);
    for (const n of search.nodes) {
      if (!n?.id || n.number == null || !n.repository?.owner?.login || !n.repository.name)
        throw new Error('Incomplete authored ID page');
      const org = n.repository.owner.login;
      const repo = n.repository.name;
      out.push({ id: makePrId(org, repo, n.number), node_id: n.id, org, repo });
    }
    hasNext = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }
  return out;
}

/**
 * Prepared statements, cached per database handle. Keying on the handle means
 * a closed and re-opened database (tests, --clean) gets fresh statements
 * without anyone having to remember a reset call.
 * @type {WeakMap<object, Record<string, import('node:sqlite').StatementSync>>}
 */
const statementCache = new WeakMap();

function getStatements() {
  const db = getDb();
  let statements = statementCache.get(db);
  if (!statements) {
    statements = {
      findScratches: db.prepare(
        "SELECT * FROM workspaces WHERE pr_id IS NULL AND work_item_id IS NULL AND status = 'active' AND operation_state = 'ready' ORDER BY created_at, id",
      ),
      findPrByBranch: db.prepare('SELECT id FROM authored_prs WHERE org = ? AND repo = ? AND branch = ? ORDER BY id'),
      adoptWorkspace: db.prepare('UPDATE workspaces SET pr_id = ? WHERE id = ?'),
    };
    statementCache.set(db, statements);
  }
  return statements;
}

/**
 * Destroy workspaces and clean up DB rows for a stale PR.
 * @param {string} prId
 * @param {object} config
 */
async function cleanupStalePR(prId, config, deps = defaultPollerDeps) {
  const db = getDb();
  const workspaces = db.prepare('SELECT id FROM workspaces WHERE pr_id = ? AND work_item_id IS NULL').all(prId);
  for (const ws of workspaces) {
    try {
      const result = await deps.destroyWorkspace(ws.id, config);
      if (!result.ok) {
        throw new Error(result.warnings.join('; ') || 'workspace cleanup was incomplete');
      }
    } catch (err) {
      console.warn(`[poller] Failed to destroy workspace ${ws.id} for stale PR ${prId}: ${err.message}`);
      throw err;
    }
  }

  // A successful destroy detaches the PR foreign key so stale-PR deletion
  // cannot be blocked. Retain the initial ids so their archived sessions and
  // historical rows can still be removed after every external cleanup step
  // has succeeded.
  for (const workspace of workspaces) {
    const sessionsToDelete = db
      .prepare('SELECT transcript_path FROM sessions WHERE workspace_id = ?')
      .all(workspace.id);
    for (const session of sessionsToDelete) {
      if (session.transcript_path) {
        try {
          unlinkSync(session.transcript_path);
        } catch {
          /* best effort */
        }
      }
    }
    db.prepare('DELETE FROM sessions WHERE workspace_id = ?').run(workspace.id);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspace.id);
  }
}

/** Authored automation has its own baseline, separate from the shared PR cache. */
function upsertPRs(nodes, viewer, context, assertCurrent) {
  const db = getDb();
  const store = prStore(db);
  const keys = [];
  const changes = withTransaction(db, () => {
    assertCurrent();
    const accepted = [];
    for (const node of nodes) {
      if (node.author?.login?.toLowerCase() !== viewer.login.toLowerCase()) continue;
      const prepared = store.prepare(node, 'details', context);
      const row = store.write(prepared);
      keys.push(`pr:${row.id}`);
      accepted.push(store.authored(row, viewer, new Date().toISOString()));
    }
    assertCurrent();
    return accepted;
  });
  store.fence.accept(context.read, keys);
  for (const change of changes) {
    if (change.changes) pollerEvents.emit('pr-changed', { ...change, pr: formatPR(change.pr) });
  }
  return changes.map((change) => change.pr.id);
}

// The heavy data fetch (`updated:>=<since>`, with reviews/comments/checks)
// is incremental most cycles and only promotes to a full enumeration every
// FULL_SWEEP_INTERVAL_MS. That incremental fetch is the single biggest knob
// on GraphQL point usage. Cleanup of merged/closed PRs no longer waits for
// that full sweep: every cycle also runs the cheap id-only OPEN_IDS_QUERY
// enumeration, which gives a complete open set for stale cleanup. A heavy full sweep is only about
// refreshing data on PRs whose `updatedAt` didn't move (e.g. CI finishing).
const FULL_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
// Overlap window so a PR updated right before/after the previous fetch
// boundary doesn't get skipped because of clock skew or in-flight time.
const INCREMENTAL_BUFFER_MS = 10 * 60 * 1000;
let lastFullSweepAt = null;
let lastSweepAt = null;
let sweepCursorsHydrated = false;

/**
 * Forget the in-memory sweep cursors. By default the next cycle is a full
 * fetch (poll targets changed). With `hydrateFromDb` the next cycle reads the
 * persisted cursors again, which is what a fresh process does; tests use it.
 * @param {{ hydrateFromDb?: boolean }} [options]
 */
export function resetSweepCursors({ hydrateFromDb = false } = {}) {
  lastFullSweepAt = null;
  lastSweepAt = null;
  sweepCursorsHydrated = !hydrateFromDb;
}

/**
 * Restore the cursors recordSync persisted so a restart resumes incremental
 * polling instead of paying for a full fetch of every open PR.
 */
function hydrateSweepCursors() {
  if (sweepCursorsHydrated) return;
  sweepCursorsHydrated = true;
  const row = getDb().prepare('SELECT last_sweep_at, last_full_sweep_at FROM sync_state WHERE id = 1').get();
  const parse = (value) => {
    const ms = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  lastSweepAt = parse(row?.last_sweep_at);
  lastFullSweepAt = parse(row?.last_full_sweep_at);
}

/**
 * Decide whether this cycle should do a full sweep.
 */
function shouldFullSweep() {
  return lastFullSweepAt === null || Date.now() - lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS;
}

/**
 * Build the `updated:>=<iso>` filter for an incremental fetch. Returns null
 * when the caller is doing a full sweep, or when we've never swept this
 * before (the first cycle has to fetch everything).
 * @param {boolean} fullSweep
 */
function buildSinceFilter(fullSweep) {
  if (fullSweep) return null;
  if (lastSweepAt === null) return null;
  return new Date(lastSweepAt - INCREMENTAL_BUFFER_MS).toISOString();
}

function recordSync({ syncedAt, sweepStartedAt, fullSweep }) {
  getDb()
    .prepare(
      `UPDATE sync_state
          SET synced_at = ?,
              last_sweep_at = ?,
              last_full_sweep_at = COALESCE(?, last_full_sweep_at)
        WHERE id = 1`,
    )
    .run(syncedAt, new Date(sweepStartedAt).toISOString(), fullSweep ? new Date(sweepStartedAt).toISOString() : null);
}

/**
 * Run a single poll cycle across all configured targets.
 * The heavy data fetch is incremental most cycles; a full sweep runs every
 * FULL_SWEEP_INTERVAL_MS. Cleanup of merged/closed PRs runs every cycle off
 * a cheap id-only enumeration regardless of full-sweep cadence.
 * @param {object} config
 * @param {{force?: boolean}} [options] - `force` makes this a full sweep.
 *   Used by the manual "Sync now" button so it always returns authoritative,
 *   fully cleaned-up state.
 */
export async function pollOnce(config, { force = false, deps = defaultPollerDeps } = {}) {
  const db = getDb();
  const client = githubClient(db);
  const configured = client.configure(config.poll);
  if (configured.scopeChanged) resetSweepCursors({ hydrateFromDb: true });
  hydrateSweepCursors();
  const rl = client.rateLimit();
  if (rl.limited && Date.parse(rl.resetAt) > Date.now()) return;
  const { orgs, repos } = normalizedScope(config.poll);
  if (!orgs.length && !repos.length) return;
  const qualifier = [...orgs.map((org) => `org:${org}`), ...repos.map((repo) => `repo:${repo}`)].join(' ');
  const observation = client.capture();
  // Account changes can be detected outside this poller. Persisted coverage is
  // authoritative even when the process still has the previous account's cursors.
  const coverage = db.prepare('SELECT last_full_sweep_at FROM sync_state WHERE id = 1').get();
  const fullSweep = force || !client.identity() || !coverage?.last_full_sweep_at || shouldFullSweep();
  const since = buildSinceFilter(fullSweep);
  const sweepStartedAt = Date.now();
  const cost = { total: 0, known: true };
  const reviewContext = reviewStore(db).begin();
  const context = reviewContext;
  let reviews;
  const reviewService = () =>
    (reviews ??= createReviewPoller({
      db,
      poll: config.poll,
      viewer: client.identity(),
      assertCurrent: observation.assertCurrent,
      emit: emitReviewRequestChange,
    }));
  const optional = (prediction) => client.budget().admits(config.poll.interval_seconds, prediction);
  const raw = (query, variables, options = {}) =>
    client.request(query, variables, {
      ...options,
      observation,
      optional: !options.authoredCost,
      ...(deps === defaultPollerDeps ? {} : { run: deps.graphql }),
    });
  let firstHeavy = true;
  let firstLight = true;
  const closed = new Set();
  const authored = async (query, variables) => {
    let operation = { query, variables };
    let scopes = [];
    let retained = [];
    const heavy = query === GRAPHQL_QUERY && firstHeavy;
    const light = query === OPEN_IDS_QUERY && firstLight;
    if (heavy) firstHeavy = false;
    if (light) firstLight = false;
    if (client.identity()?.verified && optional(3)) {
      if (heavy) {
        scopes = reviewService().firstPages();
        reviewService().markFirstAttempts(scopes);
      }
      if (light || (heavy && fullSweep)) {
        retained = reviewService().retained();
        reviewService().markRetainedAttempts(retained);
      }
      if (scopes.length || retained.length) operation = composeReviewSearch(query, variables, scopes, retained);
    }
    const result = await raw(operation.query, operation.variables, {
      authoredCost: cost,
      predictedCost: heavy ? 3 : 1,
    });
    observation.assertCurrent();
    if (scopes.length) reviewService().settleSearch(result, scopes, reviewContext);
    if (retained.length) {
      try {
        for (const id of reviewService().settleRetained(result, reviewContext, retained)) closed.add(id);
      } catch (error) {
        reviewService().verificationError(
          retained.map((row) => row.id),
          error,
        );
      }
    }
    return result;
  };
  try {
    const [heavy, light] = await Promise.all([
      fetchPRs(qualifier, since, authored),
      fullSweep ? Promise.resolve(null) : fetchOpenPRIds(qualifier, authored),
    ]);
    observation.assertCurrent();
    const viewer = client.identity();
    if (!viewer?.verified) throw new Error('GitHub identity is not verified');
    const ids = upsertPRs(heavy.prs, viewer, context, observation.assertCurrent);
    if (ids.length) emitReviewRequestChange({ kind: 'summary', ids });
    const open = fullSweep
      ? heavy.prs.map((node) => prStore(db).resolve(node).id)
      : light.map((node) => {
          const found = node.node_id
            ? db.prepare('SELECT id FROM prs WHERE github_node_id = ?').get(node.node_id)
            : null;
          return found?.id ?? node.id;
        });
    withTransaction(db, () => {
      observation.assertCurrent();
      const now = new Date().toISOString();
      db.prepare(`UPDATE pr_authored_state SET missing_since = COALESCE(missing_since, ?)
        WHERE viewer_id = ? AND pr_id NOT IN (SELECT value FROM json_each(?))`).run(
        now,
        viewer.id,
        JSON.stringify(open),
      );
      db.prepare(`UPDATE pr_authored_state SET complete_cycle_at = ?, missing_since = NULL
        WHERE viewer_id = ? AND pr_id IN (SELECT value FROM json_each(?))`).run(now, viewer.id, JSON.stringify(open));
      recordSync({ syncedAt: now, sweepStartedAt, fullSweep });
    });
    lastSweepAt = sweepStartedAt;
    if (fullSweep) lastFullSweepAt = sweepStartedAt;
    if (cost.known) client.budget().cycle(fullSweep, cost.total);
    await deps.reconcileWorkItemPullRequests(ids);
    observation.assertCurrent();
    adoptScratchWorkspaces();
    pollerEvents.emit('sync', { synced_at: new Date().toISOString(), pr_count: ids.length });
    await client.withOptionalWork(async () => {
      observation.assertCurrent();
      if (optional(1)) await reviewService().overflow(raw, optional);
      if (optional(5)) await reviewService().verify(raw, { fullSweep });
      else emitReviewRequestChange({ kind: 'status', deferred: 'quota' });
    });
    for (const row of db
      .prepare(`SELECT DISTINCT p.id FROM prs p JOIN workspaces w ON w.pr_id = p.id
      WHERE p.github_state IN ('CLOSED', 'MERGED') AND w.work_item_id IS NULL LIMIT 20`)
      .all())
      closed.add(row.id);
    for (const id of closed) {
      observation.assertCurrent();
      await cleanupStalePR(id, config, deps);
    }
    observation.assertCurrent();
    prStore(db).collect();
  } finally {
    prStore(db).end(context);
  }
}

/**
 * Adopt scratch workspaces that match newly-synced PRs.
 * A scratch workspace is adopted only when its repository and bookmark match
 * exactly one PR repository and branch. Every candidate gets an explicit
 * result so ambiguous and missing matches cannot silently choose a PR.
 * @returns {Array<{
 *   workspace_id: string,
 *   workspace_name: string,
 *   status: 'adopted'|'not_found'|'ambiguous',
 *   pr_id?: string,
 *   candidate_pr_ids?: string[],
 * }>}
 */
export function adoptScratchWorkspaces() {
  const { findScratches, findPrByBranch, adoptWorkspace } = getStatements();
  const scratches = findScratches.all();
  if (scratches.length === 0) return [];

  let adopted = 0;
  const results = [];
  for (const ws of scratches) {
    const repositoryParts = ws.repo?.split('/') ?? [];
    const matches =
      repositoryParts.length === 2 ? findPrByBranch.all(repositoryParts[0], repositoryParts[1], ws.bookmark) : [];
    if (matches.length === 0) {
      results.push({ workspace_id: ws.id, workspace_name: ws.name, status: 'not_found' });
      console.log(`[poller] No PR match for scratch workspace ${ws.name} (repo=${ws.repo}, bookmark=${ws.bookmark})`);
      continue;
    }
    if (matches.length > 1) {
      const candidatePrIds = matches.map((match) => match.id);
      results.push({
        workspace_id: ws.id,
        workspace_name: ws.name,
        status: 'ambiguous',
        candidate_pr_ids: candidatePrIds,
      });
      console.warn(
        `[poller] Ambiguous PR match for scratch workspace ${ws.name} ` +
          `(repo=${ws.repo}, bookmark=${ws.bookmark}, candidates=${candidatePrIds.join(',')})`,
      );
      continue;
    }

    const [pr] = matches;
    adoptWorkspace.run(pr.id, ws.id);
    adopted++;
    results.push({ workspace_id: ws.id, workspace_name: ws.name, status: 'adopted', pr_id: pr.id });
    console.log(`[poller] Adopted workspace ${ws.name} for PR ${pr.id}`);
  }
  if (adopted > 0) {
    emitLocalChange();
  }
  return results;
}

/**
 * Remove PRs from the DB that belong to orgs/repos no longer in the config.
 * Runs when targets change to avoid stale data from removed targets.
 * @param {object} config
 */
async function cleanupRemovedTargets(config) {
  githubClient().configure(config.poll);
}

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let lastTargetsKey = null;

const pollFlight = new SingleFlight({
  merge: (previous, next) => ({
    config: next.config,
    force: previous.force || next.force,
    resetSweeps: previous.resetSweeps || next.resetSweeps,
    cleanupTargets: previous.cleanupTargets || next.cleanupTargets,
  }),
  run: async ({ config, force, resetSweeps, cleanupTargets }) => {
    if (resetSweeps) resetSweepCursors();
    if (cleanupTargets) await cleanupRemovedTargets(config);
    return pollOnce(config, { force });
  },
});

function schedulePoll(config, options = {}) {
  return pollFlight.request({
    config,
    force: options.force ?? false,
    resetSweeps: options.resetSweeps ?? false,
    cleanupTargets: options.cleanupTargets ?? false,
  });
}

/**
 * Start the polling loop.
 * @param {object} config
 */
export function startPoller(config) {
  if (intervalHandle) clearInterval(intervalHandle);
  const change = githubClient().configure(config.poll);
  const targetsKey = [...config.poll.orgs.map((o) => `org:${o}`), ...config.poll.repos.map((r) => `repo:${r}`)]
    .sort()
    .join(',');
  const targets = targetsKey.replace(/,/g, ', ');
  console.log(`[poller] Starting - polling ${targets} every ${config.poll.interval_seconds}s`);

  // Only poll immediately if the targets changed (or first start).
  // Force the next cycle to be a full sweep so a newly-added org/repo
  // pulls in all its open PRs instead of just the last few minutes of
  // updates.
  const firstStart = lastTargetsKey === null;
  const targetsChanged = !firstStart && targetsKey !== lastTargetsKey;
  lastTargetsKey = targetsKey;
  if (firstStart || targetsChanged || change.changed) {
    schedulePoll(config, { resetSweeps: targetsChanged, cleanupTargets: targetsChanged }).catch((err) =>
      console.error(`[poller] Poll failed: ${err.message}`),
    );
  }
  intervalHandle = setInterval(
    () => schedulePoll(config).catch((err) => console.error(`[poller] Poll failed: ${err.message}`)),
    config.poll.interval_seconds * 1000,
  );
}

/**
 * Stop the polling loop.
 */
export function stopPoller({ drain = false } = {}) {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  githubClient().stop();
  return drain ? pollFlight.whenIdle() : undefined;
}

/**
 * Trigger an immediate poll with the given config. This is the manual
 * "Sync now" path, so it forces a full sweep and cleanup. The user expects
 * authoritative state, with merged/closed PRs gone.
 * @param {object} config
 * @returns {Promise<void>}
 */
export function triggerPoll(config) {
  return schedulePoll(config, { force: true });
}

/** Remove rows for targets that are no longer configured without starting an interval. */
export function reconcilePollTargets(config) {
  githubClient().configure(config.poll);
  return schedulePoll(config, { resetSweeps: true, cleanupTargets: true });
}

export function triggerReviewPoll(config) {
  return schedulePoll(config);
}

export function getPollerStatus(db = getDb()) {
  return { active: pollFlight.active, pending: pollFlight.pending, quota: githubClient(db).diagnostics() };
}
