import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { getDb } from './db.js';

const execFile = promisify(execFileCb);

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
                contexts(first: 50) {
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
 * @param {string} org
 * @param {string | null} cursor
 * @returns {Promise<object>}
 */
async function ghGraphql(org, cursor) {
  const args = ['api', 'graphql',
    '-f', `query=${GRAPHQL_QUERY}`,
    '-f', `q=org:${org} is:pr is:open author:@me`,
  ];
  if (cursor) {
    args.push('-f', `cursor=${cursor}`);
  }
  try {
    const { stdout } = await execFile('gh', args, { maxBuffer: 10 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`gh graphql failed for ${org}: ${err.stderr || err.message}`);
  }
}

/**
 * Fetch all open PRs for an org, handling pagination.
 * @param {string} org
 * @returns {Promise<object[]>}
 */
async function fetchPRsForOrg(org) {
  const allPRs = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const result = await ghGraphql(org, cursor);
    const search = result.data?.search;
    if (!search) {
      console.warn(`[poller] Unexpected response shape for ${org}:`, JSON.stringify(result).slice(0, 200));
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
  const contexts = commitNode?.statusCheckRollup?.contexts?.nodes ?? [];
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
let deleteStaleStmt = null;

/**
 * Get or create cached prepared statements.
 */
function getStatements() {
  const db = getDb();
  if (!upsertStmt) {
    upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO prs (id, number, title, repo, org, author, url, branch, draft, checks, reviews, labels, created_at, updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  if (!deleteStaleStmt) {
    deleteStaleStmt = db.prepare('DELETE FROM prs WHERE org = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  return { upsert: upsertStmt, deleteStale: deleteStaleStmt };
}

/**
 * Upsert PRs into the database and remove stale ones for the org.
 * @param {string} org
 * @param {object[]} prs
 */
function syncPRsToDb(org, prs) {
  const db = getDb();
  const now = new Date().toISOString();
  const { upsert, deleteStale } = getStatements();

  const seenIds = [];

  db.exec('BEGIN');
  try {
    for (const pr of prs) {
      const prOrg = pr.repository.owner.login;
      const repo = pr.repository.name;
      const id = `${prOrg}/${repo}#${pr.number}`;
      seenIds.push(id);

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
        JSON.stringify(extractChecks(pr)),
        JSON.stringify(extractReviews(pr)),
        JSON.stringify(extractLabels(pr)),
        pr.createdAt,
        pr.updatedAt,
        now,
      );
    }

    // Bulk delete PRs no longer open for this org
    deleteStale.run(org, JSON.stringify(seenIds));

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Run a single poll cycle across all orgs concurrently.
 * @param {string[]} orgs
 */
async function pollOnce(orgs) {
  const results = await Promise.allSettled(orgs.map(async (org) => {
    const prs = await fetchPRsForOrg(org);
    syncPRsToDb(org, prs);
    console.log(`[poller] Synced ${prs.length} PRs for ${org}`);
    return prs.length;
  }));

  let totalCount = 0;
  for (const result of results) {
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
 * @param {{ orgs: string[], poll_interval_seconds: number }} config
 */
export function startPoller(config) {
  stopPoller();
  console.log(`[poller] Starting - polling ${config.orgs.join(', ')} every ${config.poll_interval_seconds}s`);

  // Run immediately, then on interval
  pollOnce(config.orgs).catch(err => console.error(`[poller] Poll failed: ${err.message}`));
  intervalHandle = setInterval(
    () => pollOnce(config.orgs).catch(err => console.error(`[poller] Poll failed: ${err.message}`)),
    config.poll_interval_seconds * 1000,
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
 * Trigger an immediate poll with the given orgs.
 * @param {string[]} orgs
 * @returns {Promise<void>}
 */
export function triggerPoll(orgs) {
  return pollOnce(orgs);
}

/**
 * Reset cached prepared statements (needed if db is re-initialized).
 */
export function resetStatements() {
  upsertStmt = null;
  deleteStaleStmt = null;
}
