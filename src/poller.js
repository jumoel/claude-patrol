import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { unlinkSync } from 'node:fs';
import { emitGhRateLimit, emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { makePrId } from './utils.js';
import { destroyWorkspace } from './workspace.js';

export const pollerEvents = new EventEmitter();

/** Track in-flight PR summary generations */
const prSummaryInFlight = new Set();

/**
 * Generate a 1-line executive summary for a PR from its title + description.
 * Calls `claude --print --model haiku` and stores the result in the DB.
 * @param {string} prId
 * @param {string} title
 * @param {string} body
 */
async function generatePRSummary(prId, title, body) {
  if (prSummaryInFlight.has(prId)) return;
  prSummaryInFlight.add(prId);

  const prompt = `You are a PR summarizer. Given a PR title and description, write exactly one short sentence (under 100 characters) that captures what this PR does and why, for a busy human scanning a list. No markdown, no quotes, no preamble - just the sentence.

Title: ${title}

Description:
${body.slice(0, 4000)}`;

  try {
    const summary = await new Promise((resolve, reject) => {
      const proc = spawn('claude', ['--print', '--model', 'haiku'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d; });
      proc.stderr.on('data', (d) => { stderr += d; });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`claude exited ${code}: ${stderr.trim()}`));
      });
      proc.on('error', reject);
      proc.stdin.write(prompt);
      proc.stdin.end();
    });

    if (summary) {
      const db = getDb();
      db.prepare('UPDATE prs SET pr_summary = ? WHERE id = ?').run(summary, prId);
      emitLocalChange();
      console.log(`[poller] PR summary for ${prId}: ${summary}`);
    }
  } finally {
    prSummaryInFlight.delete(prId);
  }
}

const GRAPHQL_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id
        number
        title
        body
        bodyHTML
        url
        isDraft
        headRefName
        baseRefName
        isCrossRepository
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

const CHECKS_PAGE_QUERY = `
query($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on PullRequest {
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

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Detect rate-limit signals in gh output.
 * Matches both REST (HTTP 403 stderr text) and GraphQL (response body) patterns.
 * @param {string} text
 */
function isRateLimitMessage(text) {
  if (!text) return false;
  return (
    /API rate limit exceeded/i.test(text) ||
    /exceeded a secondary rate limit/i.test(text) ||
    /\brate limit\b.*\bexceeded\b/i.test(text) ||
    /"type"\s*:\s*"RATE_LIMITED"/.test(text)
  );
}

class RateLimitedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitedError';
    this.rateLimited = true;
  }
}

/** @type {{limited: boolean, message: string | null, detectedAt: string | null, resetAt: string | null}} */
let rateLimitState = { limited: false, message: null, detectedAt: null, resetAt: null };
let resetLookupInFlight = false;

/** Snapshot of the current gh rate-limit state. */
export function getGhRateLimitState() {
  return { ...rateLimitState };
}

function setRateLimited(rawMessage) {
  const message = (rawMessage || '').trim().slice(0, 500) || 'gh API rate limit exceeded';
  const wasLimited = rateLimitState.limited;
  rateLimitState = {
    limited: true,
    message,
    detectedAt: wasLimited ? rateLimitState.detectedAt : new Date().toISOString(),
    resetAt: rateLimitState.resetAt,
  };
  if (!wasLimited) {
    console.warn(`[poller] gh rate limit detected: ${message.slice(0, 200)}`);
    emitGhRateLimit(getGhRateLimitState());
    fetchRateLimitReset();
  }
}

function clearRateLimited() {
  if (!rateLimitState.limited) return;
  rateLimitState = { limited: false, message: null, detectedAt: null, resetAt: null };
  console.log('[poller] gh rate limit cleared');
  emitGhRateLimit(getGhRateLimitState());
}

/**
 * Best-effort fetch of `gh api rate_limit` to learn when the window resets.
 * The rate_limit endpoint is exempt from rate limiting per GitHub docs, so it
 * normally succeeds even while the user is throttled.
 */
function fetchRateLimitReset() {
  if (resetLookupInFlight) return;
  resetLookupInFlight = true;
  const child = spawn('gh', ['api', 'rate_limit'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.on('error', () => {
    resetLookupInFlight = false;
  });
  child.on('close', (code) => {
    resetLookupInFlight = false;
    if (code !== 0) return;
    try {
      const parsed = JSON.parse(Buffer.concat(out).toString());
      const buckets = parsed?.resources;
      if (!buckets) return;
      // Pick the soonest reset among buckets that are actually exhausted; fall
      // back to the soonest reset overall.
      let soonest = null;
      for (const b of Object.values(buckets)) {
        if (typeof b?.reset !== 'number') continue;
        if (b.remaining === 0 && (soonest === null || b.reset < soonest)) {
          soonest = b.reset;
        }
      }
      if (soonest === null) {
        for (const b of Object.values(buckets)) {
          if (typeof b?.reset !== 'number') continue;
          if (soonest === null || b.reset < soonest) soonest = b.reset;
        }
      }
      if (soonest !== null && rateLimitState.limited) {
        rateLimitState = { ...rateLimitState, resetAt: new Date(soonest * 1000).toISOString() };
        emitGhRateLimit(getGhRateLimitState());
      }
    } catch {
      /* ignore */
    }
  });
}

/**
 * Run a single gh api graphql call. Returns { stdout, stderr, code } or
 * rejects on spawn error.
 */
function ghGraphqlOnce(query, variables) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', ['api', 'graphql', '--input', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const chunks = [];
    const errChunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => errChunks.push(d));

    child.on('close', (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString(),
        stderr: Buffer.concat(errChunks).toString(),
        code,
      });
    });

    child.on('error', reject);
    child.stdin.end(JSON.stringify({ query, variables }));
  });
}

/**
 * Run a gh api graphql command with retry and exponential backoff.
 * Retries on non-zero exit codes and spawn errors (transient failures).
 * Does not retry on JSON parse errors (bad response, not transient).
 * @param {string} query - GraphQL query string
 * @param {Record<string, string>} variables
 * @returns {Promise<object>}
 */
async function ghGraphql(query, variables) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { stdout, stderr, code } = await ghGraphqlOnce(query, variables);

      if (code !== 0) {
        const errText = stderr || stdout;
        if (isRateLimitMessage(errText)) {
          setRateLimited(errText);
          throw new RateLimitedError(`gh rate limit exceeded: ${errText.slice(0, 200)}`);
        }
        lastError = new Error(`gh graphql failed (exit ${code}): ${errText}`);
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
          console.warn(
            `[poller] gh graphql failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${errText.slice(0, 120)}`,
          );
          await sleep(delay);
          continue;
        }
        throw lastError;
      }

      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // JSON parse error - not transient, don't retry
        throw new Error(`gh graphql returned non-JSON: ${stdout.slice(0, 200)}`);
      }

      // GraphQL primary rate limit returns HTTP 200 with errors[].type === 'RATE_LIMITED'.
      const rateLimitErr = parsed.errors?.find(
        (e) => e?.type === 'RATE_LIMITED' || isRateLimitMessage(e?.message || ''),
      );
      if (rateLimitErr) {
        setRateLimited(rateLimitErr.message || 'GraphQL rate limit exceeded');
        throw new RateLimitedError(`gh graphql rate limited: ${rateLimitErr.message || ''}`);
      }

      clearRateLimited();
      return parsed;
    } catch (err) {
      lastError = err;
      if (err instanceof RateLimitedError) throw err;
      // If it's a JSON parse error, don't retry
      if (err.message.startsWith('gh graphql returned non-JSON')) throw err;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
        console.warn(
          `[poller] gh graphql failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms: ${err.message.slice(0, 120)}`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Fetch remaining check contexts for a PR via pagination.
 * @param {string} nodeId - GitHub node ID of the PR
 * @param {string} startCursor - endCursor from the initial page
 * @returns {Promise<object[]>} additional context nodes
 */
async function fetchRemainingChecks(nodeId, startCursor) {
  const extra = [];
  let cursor = startCursor;
  let hasNext = true;

  while (hasNext) {
    const result = await ghGraphql(CHECKS_PAGE_QUERY, { id: nodeId, cursor });
    const contexts = result.data?.node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (!contexts) break;
    extra.push(...contexts.nodes);
    hasNext = contexts.pageInfo.hasNextPage;
    cursor = contexts.pageInfo.endCursor;
  }

  return extra;
}

/**
 * Fetch all open PRs for a search qualifier, handling pagination.
 * Also paginates check contexts for PRs that exceed 100 checks.
 * @param {string} qualifier - e.g. "org:foo" or "repo:owner/repo"
 * @returns {Promise<object[]>}
 */
async function fetchPRs(qualifier) {
  const allPRs = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const vars = { q: `${qualifier} is:pr is:open author:@me` };
    if (cursor) vars.cursor = cursor;
    const result = await ghGraphql(GRAPHQL_QUERY, vars);
    const search = result.data?.search;
    if (!search) {
      console.warn(`[poller] Unexpected response shape for ${qualifier}:`, JSON.stringify(result).slice(0, 200));
      break;
    }
    allPRs.push(...search.nodes);
    hasNext = search.pageInfo.hasNextPage;
    cursor = search.pageInfo.endCursor;
  }

  // Paginate checks for PRs that have more than 100
  for (const pr of allPRs) {
    const contextsConn = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
    if (contextsConn?.pageInfo?.hasNextPage) {
      const extra = await fetchRemainingChecks(pr.id, contextsConn.pageInfo.endCursor);
      contextsConn.nodes.push(...extra);
      contextsConn.pageInfo.hasNextPage = false;
    }
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
  return contexts.map((ctx) => {
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
  return (pr.reviews?.nodes ?? []).map((r) => ({
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
  return (pr.labels?.nodes ?? []).map((l) => ({ name: l.name, color: l.color }));
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
/** @type {import('node:sqlite').StatementSync | null} */
let getExistingBodyStmt = null;

/**
 * Get or create cached prepared statements.
 */
function getStatements() {
  const db = getDb();
  if (!upsertStmt) {
    upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO prs (id, number, title, body, body_html, repo, org, author, url, branch, base_branch, is_fork, draft, mergeable, checks, reviews, labels, created_at, updated_at, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  if (!deleteStaleByOrgStmt) {
    deleteStaleByOrgStmt = db.prepare('DELETE FROM prs WHERE org = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  if (!deleteStaleByRepoStmt) {
    deleteStaleByRepoStmt = db.prepare(
      'DELETE FROM prs WHERE org = ? AND repo = ? AND id NOT IN (SELECT value FROM json_each(?))',
    );
  }
  if (!findStaleByOrgStmt) {
    findStaleByOrgStmt = db.prepare('SELECT id FROM prs WHERE org = ? AND id NOT IN (SELECT value FROM json_each(?))');
  }
  if (!findStaleByRepoStmt) {
    findStaleByRepoStmt = db.prepare(
      'SELECT id FROM prs WHERE org = ? AND repo = ? AND id NOT IN (SELECT value FROM json_each(?))',
    );
  }
  if (!getExistingBodyStmt) {
    getExistingBodyStmt = db.prepare('SELECT body FROM prs WHERE id = ?');
  }
  return {
    upsert: upsertStmt,
    deleteStaleByOrg: deleteStaleByOrgStmt,
    deleteStaleByRepo: deleteStaleByRepoStmt,
    findStaleByOrg: findStaleByOrgStmt,
    findStaleByRepo: findStaleByRepoStmt,
    getExistingBody: getExistingBodyStmt,
  };
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
  // Clean up archived transcript files before deleting session rows
  const sessionsToDelete = db
    .prepare('SELECT transcript_path FROM sessions WHERE workspace_id IN (SELECT id FROM workspaces WHERE pr_id = ?)')
    .all(prId);
  for (const sess of sessionsToDelete) {
    if (sess.transcript_path) {
      try {
        unlinkSync(sess.transcript_path);
      } catch {
        /* best effort */
      }
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
  const { upsert, getExistingBody } = getStatements();
  const needsSummary = [];

  db.exec('BEGIN');
  try {
    for (const pr of prs) {
      const prOrg = pr.repository.owner.login;
      const repo = pr.repository.name;
      const id = makePrId(prOrg, repo, pr.number);
      const newBody = pr.body || '';

      // Check if body changed (new PR or updated description)
      const existing = getExistingBody.get(id);
      if (!existing || existing.body !== newBody) {
        needsSummary.push({ id, title: pr.title, body: newBody });
      }

      upsert.run(
        id,
        pr.number,
        pr.title,
        newBody,
        pr.bodyHTML || '',
        repo,
        prOrg,
        pr.author?.login ?? 'unknown',
        pr.url,
        pr.headRefName,
        pr.baseRefName || 'main',
        pr.isCrossRepository ? 1 : 0,
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

  // Fire-and-forget background summarization for PRs with new/changed bodies
  for (const { id, title, body } of needsSummary) {
    if (!body.trim()) continue;
    generatePRSummary(id, title, body).catch((err) => {
      console.warn(`[poller] PR summary failed for ${id}: ${err.message}`);
    });
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

  const staleRows = scope === 'org' ? findStaleByOrg.all(org, seenJson) : findStaleByRepo.all(org, repo, seenJson);

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
  const orgResults = await Promise.allSettled(
    orgs.map(async (org) => {
      const prs = await fetchPRs(`org:${org}`);
      upsertPRs(prs);
      const seenIds = prs.map((pr) => makePrId(pr.repository.owner.login, pr.repository.name, pr.number));
      await cleanupStale('org', org, null, seenIds, config);
      console.log(`[poller] Synced ${prs.length} PRs for org:${org}`);
      return prs.length;
    }),
  );

  for (const result of orgResults) {
    if (result.status === 'fulfilled') {
      totalCount += result.value;
    } else {
      console.error(`[poller] Error polling: ${result.reason.message}`);
    }
  }

  // Repo-level fetches
  const repoResults = await Promise.allSettled(
    repos.map(async (ownerRepo) => {
      const [owner, repo] = ownerRepo.split('/');
      // Skip if this repo's org is already covered by org-level polling
      if (orgSet.has(owner)) {
        console.log(`[poller] Skipping repo:${ownerRepo} (org:${owner} already polled)`);
        return 0;
      }
      const prs = await fetchPRs(`repo:${ownerRepo}`);
      upsertPRs(prs);
      const seenIds = prs.map((pr) => makePrId(pr.repository.owner.login, pr.repository.name, pr.number));
      await cleanupStale('repo', owner, repo, seenIds, config);
      console.log(`[poller] Synced ${prs.length} PRs for repo:${ownerRepo}`);
      return prs.length;
    }),
  );

  for (const result of repoResults) {
    if (result.status === 'fulfilled') {
      totalCount += result.value;
    } else {
      console.error(`[poller] Error polling: ${result.reason.message}`);
    }
  }

  // Adopt scratch workspaces whose branch matches a newly-synced PR
  adoptScratchWorkspaces();

  pollerEvents.emit('sync', { synced_at: new Date().toISOString(), pr_count: totalCount });
}

/** @type {import('node:sqlite').StatementSync | null} */
let findScratchesStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findPrByBranchStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findPrByBranchSuffixStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let adoptWorkspaceStmt = null;

/**
 * Adopt scratch workspaces that match newly-synced PRs.
 * A scratch workspace is adopted when its bookmark matches a PR's branch
 * and its repo column matches the PR's org/repo. Also handles prefix
 * mismatches (e.g. bookmark "my-branch" matches PR branch "user/my-branch").
 */
function adoptScratchWorkspaces() {
  const db = getDb();
  if (!findScratchesStmt) {
    findScratchesStmt = db.prepare("SELECT * FROM workspaces WHERE pr_id IS NULL AND status = 'active'");
    findPrByBranchStmt = db.prepare('SELECT id FROM prs WHERE org = ? AND repo = ? AND branch = ?');
    findPrByBranchSuffixStmt = db.prepare("SELECT id FROM prs WHERE org = ? AND repo = ? AND branch LIKE '%/' || ?");
    adoptWorkspaceStmt = db.prepare('UPDATE workspaces SET pr_id = ?, repo = NULL WHERE id = ?');
  }
  const scratches = findScratchesStmt.all();
  if (scratches.length === 0) return;

  let adopted = 0;
  for (const ws of scratches) {
    if (!ws.repo) continue;
    const [org, repo] = ws.repo.split('/');
    // Exact match first, then suffix match (handles user/ prefixes on branches)
    const pr = findPrByBranchStmt.get(org, repo, ws.bookmark) || findPrByBranchSuffixStmt.get(org, repo, ws.bookmark);
    if (pr) {
      adoptWorkspaceStmt.run(pr.id, ws.id);
      adopted++;
      console.log(`[poller] Adopted workspace ${ws.name} for PR ${pr.id}`);
    } else {
      console.log(`[poller] No PR match for scratch workspace ${ws.name} (repo=${ws.repo}, bookmark=${ws.bookmark})`);
    }
  }
  if (adopted > 0) {
    emitLocalChange();
  }
}

/**
 * Remove PRs from the DB that belong to orgs/repos no longer in the config.
 * Runs when targets change to avoid stale data from removed targets.
 * @param {object} config
 */
async function cleanupRemovedTargets(config) {
  const db = getDb();
  const orgSet = new Set(config.poll.orgs);
  const repoSet = new Set(config.poll.repos);

  // Find all distinct org/repo combos in the DB
  const dbEntries = db.prepare('SELECT DISTINCT org, repo FROM prs').all();
  for (const { org, repo } of dbEntries) {
    const fullRepo = `${org}/${repo}`;
    // Keep if the org is polled, or the specific repo is polled
    if (orgSet.has(org) || repoSet.has(fullRepo)) continue;

    // This org/repo combo is no longer monitored - clean it up
    const staleRows = db.prepare('SELECT id FROM prs WHERE org = ? AND repo = ?').all(org, repo);
    for (const row of staleRows) {
      await cleanupStalePR(row.id, config);
    }
    db.prepare('DELETE FROM prs WHERE org = ? AND repo = ?').run(org, repo);
    console.log(`[poller] Cleaned up ${staleRows.length} stale PR(s) from ${fullRepo} (no longer monitored)`);
  }
}

/** @type {ReturnType<typeof setInterval> | null} */
let intervalHandle = null;
let lastTargetsKey = null;

/**
 * Start the polling loop.
 * @param {object} config
 */
export function startPoller(config) {
  stopPoller();
  const targetsKey = [...config.poll.orgs.map((o) => `org:${o}`), ...config.poll.repos.map((r) => `repo:${r}`)]
    .sort()
    .join(',');
  const targets = targetsKey.replace(/,/g, ', ');
  console.log(`[poller] Starting - polling ${targets} every ${config.poll.interval_seconds}s`);

  // Only poll immediately if the targets changed (or first start)
  const targetsChanged = targetsKey !== lastTargetsKey;
  lastTargetsKey = targetsKey;
  if (targetsChanged) {
    cleanupRemovedTargets(config).catch((err) => console.error(`[poller] Cleanup failed: ${err.message}`));
    pollOnce(config).catch((err) => console.error(`[poller] Poll failed: ${err.message}`));
  }
  intervalHandle = setInterval(
    () => pollOnce(config).catch((err) => console.error(`[poller] Poll failed: ${err.message}`)),
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
  findScratchesStmt = null;
  findPrByBranchStmt = null;
  adoptWorkspaceStmt = null;
}
