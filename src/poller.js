import { EventEmitter } from 'node:events';
import { getDb } from './db.js';
import { destroyWorkspace } from './workspace.js';
import { execFile, makePrId } from './utils.js';

export const pollerEvents = new EventEmitter();

const GRAPHQL_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        headRefName
        mergeable
        createdAt
        updatedAt
        author { login }
        repository { name owner { login } }
        labels(first: 10) { nodes { name color } }
        reviews(last: 10) { nodes { author { login } state submittedAt } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
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

/**
 * Run a gh api graphql command and return parsed JSON.
 * @param {string} qualifier - search qualifier like "org:foo" or "repo:owner/repo"
 * @param {string | null} cursor
 * @returns {Promise<object>}
 */
async function ghGraphql(qualifier, cursor) {
  const args = ['api', 'graphql',
    '-f', `query=${GRAPHQL_QUERY}`,
    '-f', `q=${qualifier} is:pr is:open author:@me`,
  ];
  if (cursor) {
    args.push('-f', `cursor=${cursor}`);
  }
  try {
    const { stdout } = await execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh graphql failed for ${qualifier}: ${err.stderr || err.message}`);
  }
}

/**
 * Fetch all open PRs for a search qualifier, handling pagination.
 * @param {string} qualifier - e.g. "org:foo" or "repo:owner/repo"
 * @returns {Promise<object[]>}
 */
async function fetchPRs(qualifier) {
  const allPRs = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const result = await ghGraphql(qualifier, cursor);
    const search = result.data?.search;
    if (!search) {
      console.warn(`[poller] Unexpected response shape for ${qualifier}:`, JSON.stringify(result).slice(0, 200));
      break;
    }
    allPRs.push(...search.nodes);
    hasNext = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }

  return allPRs;
}

/**
 * Extract check runs from a PR node.
 * @param {object} pr
 * @returns {Array<{name: string, status: string, conclusion: string | null, url: string | null}>}
 */
function extractChecks(pr) {
  const commitNode = pr.commits?.nodes?.[0]?.commit;
  const contextsConn = commitNode?.statusCheckRollup?.contexts;
  if (contextsConn?.pageInfo?.hasNextPage) {
    console.warn(`[poller] PR #${pr.number} has more than 100 checks - some will be missing`);
  }
  const contexts = contextsConn?.nodes ?? [];
  return contexts.map(ctx => {
    if ('name' in ctx) {
      const workflow = ctx.checkSuite?.workflowRun?.workflow?.name;
      const fullName = workflow ? `${workflow} / ${ctx.name}` : ctx.name;
      return { name: fullName, status: ctx.status, conclusion: ctx.conclusion, url: ctx.detailsUrl };
    }
    return { name: ctx.context, status: ctx.state, conclusion: null, url: ctx.targetUrl };
  });
}

/**
 * Extract reviews from a PR node.
 * @param {object} pr
 * @returns {Array<{reviewer: string, state: string, submitted_at: string}>}
 */
function extractReviews(pr) {
  return (pr.reviews?.nodes ?? []).map(r => ({
    reviewer: r.author?.login ?? 'unknown',
    state: r.state,
    submitted_at: r.submittedAt,
  }));
}

/**
 * Extract labels from a PR node.
 * @param {object} pr
 * @returns {Array<{name: string, color: string}>}
 */
function extractLabels(pr) {
  return (pr.labels?.nodes ?? []).map(l => ({ name: l.name, color: l.color }));
}

/** @type {import('node:sqlite').StatementSync | null} */
let upsertStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let deleteStaleByOrgStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let deleteStaleByRepoStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findStaleByOrgStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findStaleByRepoStmt = null;

/**
 * Get or create cached prepared statements.
 */
function getStatements() {
  const db = getDb();
  if (!upsertStmt) {
    upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO prs (id, number, title, repo, org, author, url, branch, draft, mergeable, checks, reviews, labels, created_at, updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  if (!deleteStaleByOrgStmt) {
    deleteStaleByOrgStmt = db.prepare('DELETE FROM prs WHERE org = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  if (!deleteStaleByRepoStmt) {
    deleteStaleByRepoStmt = db.prepare('DELETE FROM prs WHERE org = ? AND repo = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  if (!findStaleByOrgStmt) {
    findStaleByOrgStmt = db.prepare('SELECT id FROM prs WHERE org = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  if (!findStaleByRepoStmt) {
    findStaleByRepoStmt = db.prepare('SELECT id FROM prs WHERE org = ? AND repo = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  return { upsert: upsertStmt, deleteStaleByOrg: deleteStaleByOrgStmt, deleteStaleByRepo: deleteStaleByRepoStmt, findStaleByOrg: findStaleByOrgStmt, findStaleByRepo: findStaleByRepoStmt };
}

/**
 * Destroy workspaces and clean up DB rows for a stale PR.
 * @param {string} prId
 * @param {object} config
 */
async function cleanupStalePR(prId, config) {
  const db = getDb();
  const workspaces = db.prepare("SELECT id FROM workspaces WHERE pr_id = ? AND status = 'active'").all(prId);
  for (const ws of workspaces) {
    try {
      await destroyWorkspace(ws.id, config);
    } catch (err) {
      console.warn(`[poller] Failed to destroy workspace ${ws.id} for stale PR ${prId}: ${err.message}`);
    }
  }
  // Clean up any remaining DB rows (sessions, workspaces) before PR deletion
  db.prepare('DELETE FROM sessions WHERE workspace_id IN (SELECT id FROM workspaces WHERE pr_id = ?)').run(prId);
  db.prepare('DELETE FROM workspaces WHERE pr_id = ?').run(prId);
}

/**
 * Upsert PRs into the database for a given scope.
 * @param {object[]} prs - raw PR nodes from GraphQL
 */
function upsertPRs(prs) {
  const db = getDb();
  const now = new Date().toISOString();
  const { upsert } = getStatements();

  db.exec('BEGIN');
  try {
    for (const pr of prs) {
      const prOrg = pr.repository.owner.login;
      const repo = pr.repository.name;
      const id = makePrId(prOrg, repo, pr.number);

      upsert.run(
        id,
        pr.number,
        pr.title,
        repo,
        prOrg,
        pr.author?.login ?? 'unknown',
        pr.url,
        pr.headRefName,
        pr.isDraft ? 1 : 0,
        pr.mergeable || 'UNKNOWN',
        JSON.stringify(extractChecks(pr)),
        JSON.stringify(extractReviews(pr)),
        JSON.stringify(extractLabels(pr)),
        pr.createdAt,
        pr.updatedAt,
        now,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Find stale PR IDs and clean them up (destroy workspaces, delete rows).
 * @param {'org' | 'repo'} scope
 * @param {string} org
 * @param {string | null} repo
 * @param {string[]} seenIds
 * @param {object} config
 */
async function cleanupStale(scope, org, repo, seenIds, config) {
  const { findStaleByOrg, findStaleByRepo, deleteStaleByOrg, deleteStaleByRepo } = getStatements();
  const seenJson = JSON.stringify(seenIds);

  const staleRows = scope === 'org'
    ? findStaleByOrg.all(org, seenJson)
    : findStaleByRepo.all(org, repo, seenJson);

  // Destroy workspaces for stale PRs (async operations)
  for (const row of staleRows) {
    await cleanupStalePR(row.id, config);
  }

  // Delete the stale PR rows
  if (scope === 'org') {
    deleteStaleByOrg.run(org, seenJson);
  } else {
    deleteStaleByRepo.run(org, repo, seenJson);
  }
}

/**
 * Run a single poll cycle across all configured targets.
 * @param {object} config
 */
async function pollOnce(config) {
  const orgs = config.poll.orgs;
  const repos = config.poll.repos;
  const orgSet = new Set(orgs);

  let totalCount = 0;

  // Org-level fetches
  const orgResults = await Promise.allSettled(orgs.map(async (org) => {
    const prs = await fetchPRs(`org:${org}`);
    upsertPRs(prs);
    const seenIds = prs.map(pr => makePrId(pr.repository.owner.login, pr.repository.name, pr.number));
    await cleanupStale('org', org, null, seenIds, config);
    console.log(`[poller] Synced ${prs.length} PRs for org:${org}`);
    return prs.length;
  }));

  for (const result of orgResults) {
    if (result.status === 'fulfilled') {
      totalCount += result.value;
    } else {
      console.error(`[poller] Error polling: ${result.reason.message}`);
    }
  }

  // Repo-level fetches
  const repoResults = await Promise.allSettled(repos.map(async (ownerRepo) => {
    const [owner, repo] = ownerRepo.split('/');
    // Skip if this repo's org is already covered by org-level polling
    if (orgSet.has(owner)) {
      console.log(`[poller] Skipping repo:${ownerRepo} (org:${owner} already polled)`);
      return 0;
    }
    const prs = await fetchPRs(`repo:${ownerRepo}`);
    upsertPRs(prs);
    const seenIds = prs.map(pr => makePrId(pr.repository.owner.login, pr.repository.name, pr.number));
    await cleanupStale('repo', owner, repo, seenIds, config);
    console.log(`[poller] Synced ${prs.length} PRs for repo:${ownerRepo}`);
    return prs.length;
  }));

  for (const result of repoResults) {
    if (result.status === 'fulfilled') {
      totalCount += result.value;
    } else {
      console.error(`[poller] Error polling: ${result.reason.message}`);
    }
  }

  pollerEvents.emit('sync', { synced_at: new Date().toISOString(), pr_count: totalCount });
}

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;

/**
 * Start the polling loop.
 * @param {object} config
 */
export function startPoller(config) {
  stopPoller();
  const targets = [
    ...config.poll.orgs.map(o => `org:${o}`),
    ...config.poll.repos.map(r => `repo:${r}`),
  ].join(', ');
  console.log(`[poller] Starting - polling ${targets} every ${config.poll.interval_seconds}s`);

  // Run immediately, then on interval
  pollOnce(config).catch(err => console.error(`[poller] Poll failed: ${err.message}`));
  intervalHandle = setInterval(
    () => pollOnce(config).catch(err => console.error(`[poller] Poll failed: ${err.message}`)),
    config.poll.interval_seconds * 1000,
  );
}

/**
 * Stop the polling loop.
 */
export function stopPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/**
 * Trigger an immediate poll with the given config.
 * @param {object} config
 * @returns {Promise<void>}
 */
export function triggerPoll(config) {
  return pollOnce(config);
}

/**
 * Reset cached prepared statements (needed if db is re-initialized).
 */
export function resetStatements() {
  upsertStmt = null;
  deleteStaleByOrgStmt = null;
  deleteStaleByRepoStmt = null;
  findStaleByOrgStmt = null;
  findStaleByRepoStmt = null;
}
