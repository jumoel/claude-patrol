import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { unlinkSync } from 'node:fs';
import { emitGhRateLimit, emitLocalChange } from './app-events.js';
import { getDb } from './db.js';
import { deriveCIStatus, formatPR } from './pr-status.js';
import { makePrId } from './utils.js';
import { destroyWorkspace } from './workspace.js';

export const pollerEvents = new EventEmitter();
pollerEvents.setMaxListeners(0);

/** Track in-flight PR summary generations to avoid concurrent batches stomping on each other. */
const prSummaryInFlight = new Set();

/** PRs per batched claude invocation. Bigger = fewer spawns, but worse worst-case latency / context use. */
const PR_SUMMARY_BATCH_SIZE = 20;
/** Max chars of body to include per PR in the batch prompt. */
const PR_SUMMARY_BODY_LIMIT = 2000;

/**
 * Run `claude --print --model haiku` with the given prompt piped on stdin.
 * @param {string} prompt
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<string>}
 */
function runClaudePrint(prompt, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--print', '--model', 'haiku'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claude exited ${code}: ${stderr.trim()}`));
    });
    proc.on('error', reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/**
 * Parse a batched summary response into an id->summary map.
 * The model is instructed to emit `### <id> ###` delimiters followed by the
 * one-line summary. We're lenient with surrounding whitespace and ignore any
 * IDs the model hallucinates that weren't in the request.
 * @param {string} text
 * @param {Set<string>} expectedIds
 * @returns {Map<string, string>}
 */
function parseBatchedSummaries(text, expectedIds) {
  const out = new Map();
  // Delimiter occupies its own line: "### <id> ###". PR ids contain '#'
  // (org/repo#N), so we require explicit spaces around the inner id rather
  // than relying on a `[^#]` class that would reject the id itself.
  // Split result interleaves: [pre, id1, body1, id2, body2, ...].
  const parts = text.split(/^###[ \t]+(.+?)[ \t]+###[ \t]*$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const id = parts[i].trim();
    if (!expectedIds.has(id)) continue;
    const summary = parts[i + 1].trim().split('\n')[0].trim();
    if (summary) out.set(id, summary);
  }
  return out;
}

/**
 * Build a single batched prompt that asks for one-line summaries of every PR
 * in the chunk. Bodies are clamped to keep context use bounded.
 * @param {Array<{id: string, title: string, body: string}>} chunk
 */
function buildBatchSummaryPrompt(chunk) {
  const blocks = chunk
    .map((p) => `### ${p.id} ###\nTitle: ${p.title}\nDescription:\n${p.body.slice(0, PR_SUMMARY_BODY_LIMIT)}`)
    .join('\n\n---\n\n');
  return `You are a PR summarizer. For each PR below, write exactly one short sentence (under 100 characters) that captures what it does and why - for a busy human scanning a list. No markdown, no quotes, no preamble.

Output format: for each PR, emit a delimiter line "### <id> ###" using the exact id given, then a newline, then the one-sentence summary on the next line. Do not summarize PRs that aren't listed below. Use the ids verbatim - they are opaque tokens.

${blocks}`;
}

/**
 * Summarize a list of PRs in one or a few batched claude calls and persist
 * the results. Replaces the old per-PR fire-and-forget loop, which spawned
 * one process per changed body. For initial syncs that's the difference
 * between 1 spawn and N spawns.
 * @param {Array<{id: string, title: string, body: string}>} prs
 */
async function generatePRSummariesBatch(prs) {
  const eligible = prs.filter((p) => p.body?.trim() && !prSummaryInFlight.has(p.id));
  if (eligible.length === 0) return;

  for (let i = 0; i < eligible.length; i += PR_SUMMARY_BATCH_SIZE) {
    const chunk = eligible.slice(i, i + PR_SUMMARY_BATCH_SIZE);
    for (const p of chunk) prSummaryInFlight.add(p.id);

    try {
      const prompt = buildBatchSummaryPrompt(chunk);
      const stdout = await runClaudePrint(prompt);
      const summaries = parseBatchedSummaries(stdout, new Set(chunk.map((p) => p.id)));
      if (summaries.size > 0) {
        const db = getDb();
        const update = db.prepare('UPDATE prs SET pr_summary = ? WHERE id = ?');
        db.exec('BEGIN');
        try {
          for (const [id, summary] of summaries) update.run(summary, id);
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        emitLocalChange();
        console.log(`[poller] Generated ${summaries.size}/${chunk.length} PR summaries (batch of ${chunk.length})`);
      } else {
        console.warn(`[poller] PR summary batch returned no parseable summaries (${chunk.length} PRs)`);
      }
    } catch (err) {
      console.warn(`[poller] PR summary batch failed (${chunk.length} PRs): ${err.message}`);
    } finally {
      for (const p of chunk) prSummaryInFlight.delete(p.id);
    }
  }
}

// Page size 50 with 30 inline check contexts. Larger inline payloads (100/100)
// 504 from GitHub's gateway once a search returns enough heavy PRs - the
// review-requested queue in a busy mono-repo can easily hit that, while the
// author queue almost never does. Pagination picks up the rest for PRs that
// exceed 30 checks (see CHECKS_PAGE_QUERY).
const GRAPHQL_QUERY = `
query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        id
        number
        title
        body
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

const PR_BODY_HTML_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      bodyHTML
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
 * Fetch a single PR's bodyHTML on demand. Returns the rendered HTML string,
 * or null if the call fails (e.g. rate-limited). Used by the detail route to
 * avoid pulling bodyHTML for every PR on every poll cycle.
 * @param {string} owner
 * @param {string} name
 * @param {number} number
 * @returns {Promise<string | null>}
 */
export async function fetchPRBodyHtml(owner, name, number) {
  try {
    const result = await ghGraphql(PR_BODY_HTML_QUERY, { owner, name, number });
    return result?.data?.repository?.pullRequest?.bodyHTML ?? null;
  } catch (err) {
    console.warn(`[poller] body_html fetch failed for ${owner}/${name}#${number}: ${err.message}`);
    return null;
  }
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
 *
 * @param {string} qualifier - e.g. "org:foo" or "repo:owner/repo" or
 *   "org:a org:b repo:c/d" (multiple qualifiers are OR'd by GitHub search).
 * @param {string} roleQualifier - one of "author:@me", "review-requested:@me".
 * @returns {Promise<{prs: object[]}>}
 */
async function fetchPRs(qualifier, roleQualifier) {
  const allPRs = [];
  let cursor = null;
  let hasNext = true;

  while (hasNext) {
    const vars = { q: `${qualifier} is:pr is:open ${roleQualifier} sort:updated-desc` };
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

  return { prs: allPRs };
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
    reviewer_type: r.author?.__typename ?? 'User',
    state: r.state,
    submitted_at: r.submittedAt,
  }));
}

/**
 * Extract issue comments from a PR node.
 * @param {object} pr
 * @returns {Array<{author: string, author_type: string, created_at: string}>}
 */
function extractComments(pr) {
  return (pr.comments?.nodes ?? []).map((c) => ({
    author: c.author?.login ?? 'unknown',
    author_type: c.author?.__typename ?? 'User',
    created_at: c.createdAt,
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
let clearRoleByOrgStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let clearRoleByRepoStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let clearReviewerRoleByOrgStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let clearReviewerRoleByRepoStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let findOrphanRowsStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let deleteOrphanRowStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let getExistingBodyStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let getExistingPrevStmt = null;
/** @type {import('node:sqlite').StatementSync | null} */
let getPrByIdStmt = null;

/**
 * Get or create cached prepared statements.
 */
function getStatements() {
  const db = getDb();
  if (!upsertStmt) {
    // Per-role flags are written here so a PR's role(s) reflect the most
    // recent poll. Anything not in the explicit column list resets to its
    // DEFAULT on REPLACE, by design - we want a fresh role tag per cycle.
    upsertStmt = db.prepare(`
      INSERT OR REPLACE INTO prs (id, number, title, body, body_html, repo, org, author, url, branch, base_branch, is_fork, draft, mergeable, checks, reviews, labels, comments, created_at, updated_at, synced_at, is_authored, is_review_requested)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }
  if (!clearRoleByOrgStmt) {
    clearRoleByOrgStmt = db.prepare(
      'UPDATE prs SET is_authored = 0 WHERE org = ? AND is_authored = 1 AND id NOT IN (SELECT value FROM json_each(?))',
    );
  }
  if (!clearRoleByRepoStmt) {
    clearRoleByRepoStmt = db.prepare(
      'UPDATE prs SET is_authored = 0 WHERE org = ? AND repo = ? AND is_authored = 1 AND id NOT IN (SELECT value FROM json_each(?))',
    );
  }
  if (!clearReviewerRoleByOrgStmt) {
    clearReviewerRoleByOrgStmt = db.prepare(
      'UPDATE prs SET is_review_requested = 0 WHERE org = ? AND is_review_requested = 1 AND id NOT IN (SELECT value FROM json_each(?))',
    );
  }
  if (!clearReviewerRoleByRepoStmt) {
    clearReviewerRoleByRepoStmt = db.prepare(
      'UPDATE prs SET is_review_requested = 0 WHERE org = ? AND repo = ? AND is_review_requested = 1 AND id NOT IN (SELECT value FROM json_each(?))',
    );
  }
  if (!findOrphanRowsStmt) {
    findOrphanRowsStmt = db.prepare('SELECT id FROM prs WHERE is_authored = 0 AND is_review_requested = 0');
  }
  if (!deleteOrphanRowStmt) {
    deleteOrphanRowStmt = db.prepare('DELETE FROM prs WHERE id = ?');
  }
  if (!getExistingBodyStmt) {
    getExistingBodyStmt = db.prepare('SELECT body, body_html FROM prs WHERE id = ?');
  }
  if (!getExistingPrevStmt) {
    getExistingPrevStmt = db.prepare('SELECT checks, mergeable, labels, draft FROM prs WHERE id = ?');
  }
  if (!getPrByIdStmt) {
    getPrByIdStmt = db.prepare('SELECT * FROM prs WHERE id = ?');
  }
  return {
    upsert: upsertStmt,
    clearRoleByOrg: clearRoleByOrgStmt,
    clearRoleByRepo: clearRoleByRepoStmt,
    clearReviewerRoleByOrg: clearReviewerRoleByOrgStmt,
    clearReviewerRoleByRepo: clearReviewerRoleByRepoStmt,
    findOrphanRows: findOrphanRowsStmt,
    deleteOrphanRow: deleteOrphanRowStmt,
    getExistingBody: getExistingBodyStmt,
    getExistingPrev: getExistingPrevStmt,
    getPrById: getPrByIdStmt,
  };
}

/**
 * Compute the diff between a previous DB row and the new GraphQL PR node for
 * the watched fields. Returns `null` if nothing in the watched set changed or
 * if there is no previous row (a brand-new PR is initial state, not a transition).
 * @param {object | undefined} prev - raw row from `prs` (with `checks`, `mergeable`, `labels`, `draft`) or undefined
 * @param {object} next - GraphQL PR node
 * @returns {object | null}
 */
function computeChanges(prev, next) {
  if (!prev) return null;
  const changes = {};

  const prevCi = deriveCIStatus(JSON.parse(prev.checks));
  const nextCi = deriveCIStatus(extractChecks(next));
  if (prevCi !== nextCi) changes.ci_status = { from: prevCi, to: nextCi };

  const nextMergeable = next.mergeable || 'UNKNOWN';
  if (prev.mergeable !== nextMergeable) changes.mergeable = { from: prev.mergeable, to: nextMergeable };

  const nextDraft = next.isDraft ? 1 : 0;
  if (prev.draft !== nextDraft) changes.draft = { from: !!prev.draft, to: !!next.isDraft };

  const prevLabels = new Set(JSON.parse(prev.labels).map((l) => l.name));
  const nextLabels = new Set(extractLabels(next).map((l) => l.name));
  const added = [...nextLabels].filter((l) => !prevLabels.has(l));
  const removed = [...prevLabels].filter((l) => !nextLabels.has(l));
  if (added.length || removed.length) changes.labels = { added, removed };

  return Object.keys(changes).length ? changes : null;
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
 * Upsert PRs into the database with their per-role flags.
 * @param {Array<{pr: object, roles: Set<string>}>} entries - raw PR nodes from GraphQL plus the role set we saw them in
 */
function upsertPRs(entries) {
  const db = getDb();
  const now = new Date().toISOString();
  const { upsert, getExistingBody, getExistingPrev, getPrById } = getStatements();
  const needsSummary = [];
  /** @type {Array<{id: string, prev: object, changes: object}>} */
  const pendingDiffs = [];

  db.exec('BEGIN');
  try {
    for (const { pr, roles } of entries) {
      const prOrg = pr.repository.owner.login;
      const repo = pr.repository.name;
      const id = makePrId(prOrg, repo, pr.number);
      const newBody = pr.body || '';

      // Check if body changed (new PR or updated description)
      const existing = getExistingBody.get(id);
      const bodyChanged = !existing || existing.body !== newBody;
      if (bodyChanged) {
        needsSummary.push({ id, title: pr.title, body: newBody });
      }

      // Capture prev row for transition detection. SELECT inside the
      // transaction to avoid any concurrent-write race (poller is
      // single-threaded today, but the cost is negligible).
      const prev = getExistingPrev.get(id);

      // body_html isn't fetched in the poll cycle (it's heavy and only used on
      // the detail view). Reuse any cached html as long as the body hasn't
      // changed; otherwise blank it so the detail route refetches it lazily.
      const newBodyHtml = bodyChanged ? '' : (existing?.body_html ?? '');

      upsert.run(
        id,
        pr.number,
        pr.title,
        newBody,
        newBodyHtml,
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
        JSON.stringify(extractComments(pr)),
        pr.createdAt,
        pr.updatedAt,
        now,
        roles.has('author') ? 1 : 0,
        roles.has('reviewer') ? 1 : 0,
      );

      const changes = computeChanges(prev, pr);
      if (changes) pendingDiffs.push({ id, prev, changes });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Emit pr-changed events only after the transaction has committed - if the
  // upsert rolled back, downstream consumers must not see transitions for
  // changes that didn't persist. Re-read each changed row and run it through
  // formatPR so consumers (notably the rules engine) get derived fields and
  // a flat label-name array directly.
  for (const { id, prev, changes } of pendingDiffs) {
    const row = getPrById.get(id);
    if (!row) continue;
    pollerEvents.emit('pr-changed', { pr: formatPR(row), prev, changes });
  }

  // Fire-and-forget batched summarization for PRs with new/changed bodies.
  // One claude spawn per chunk replaces N per-PR spawns.
  if (needsSummary.length > 0) {
    generatePRSummariesBatch(needsSummary).catch((err) => {
      console.warn(`[poller] PR summary batch failed: ${err.message}`);
    });
  }
}

/**
 * Clear a single role flag on rows in the given scope that weren't seen this cycle.
 * Doesn't destroy workspaces or delete rows - that happens later in `cleanupOrphans`
 * once we know a PR is gone from BOTH roles.
 * @param {'author' | 'reviewer'} role
 * @param {'org' | 'repo'} scope
 * @param {string} org
 * @param {string | null} repo
 * @param {string[]} seenIds
 */
function clearStaleRoleFlag(role, scope, org, repo, seenIds) {
  const { clearRoleByOrg, clearRoleByRepo, clearReviewerRoleByOrg, clearReviewerRoleByRepo } = getStatements();
  const seenJson = JSON.stringify(seenIds);
  if (role === 'author') {
    if (scope === 'org') clearRoleByOrg.run(org, seenJson);
    else clearRoleByRepo.run(org, repo, seenJson);
  } else {
    if (scope === 'org') clearReviewerRoleByOrg.run(org, seenJson);
    else clearReviewerRoleByRepo.run(org, repo, seenJson);
  }
}

/**
 * Destroy workspaces and delete PR rows that have no role flags set
 * (i.e. they no longer appear in any tab). Runs once per poll cycle after
 * both role searches have updated the flags.
 * @param {object} config
 */
async function cleanupOrphans(config) {
  const { findOrphanRows, deleteOrphanRow } = getStatements();
  const orphans = findOrphanRows.all();
  for (const row of orphans) {
    await cleanupStalePR(row.id, config);
    deleteOrphanRow.run(row.id);
  }
}

/**
 * Run a single poll cycle across all configured targets.
 * Every cycle does a full sweep so merged/closed PRs (which fall out of the
 * `is:open` result set) get cleaned up promptly.
 * @param {object} config
 */
async function pollOnce(config) {
  // Skip the cycle entirely if gh is rate-limited and we know when it resets.
  // Without a known reset time we still try, so we can detect recovery and
  // re-fetch the reset window. The first failed call will re-flag us as limited.
  const rl = getGhRateLimitState();
  if (rl.limited && rl.resetAt && Date.parse(rl.resetAt) > Date.now()) {
    console.log(`[poller] Skipping poll - gh rate-limited until ${rl.resetAt}`);
    return;
  }

  const orgs = config.poll.orgs;
  const orgSet = new Set(orgs);
  // Drop repos already covered by an org-level scan
  const repos = config.poll.repos.filter((r) => !orgSet.has(r.split('/')[0]));

  if (orgs.length === 0 && repos.length === 0) {
    pollerEvents.emit('sync', { synced_at: new Date().toISOString(), pr_count: 0 });
    return;
  }

  // Combine all configured targets into a single search. GitHub search OR's
  // multiple `org:` / `repo:` qualifiers, so one call covers everything.
  const qualifier = [...orgs.map((o) => `org:${o}`), ...repos.map((r) => `repo:${r}`)].join(' ');

  // Two searches per cycle: one for PRs the user authored, one for PRs they've
  // been asked to review. GitHub search doesn't support boolean OR on
  // qualifiers, so we run them in parallel and merge results by PR id.
  let authoredResult;
  let reviewerResult;
  try {
    [authoredResult, reviewerResult] = await Promise.all([
      fetchPRs(qualifier, 'author:@me'),
      fetchPRs(qualifier, 'review-requested:@me'),
    ]);
  } catch (err) {
    console.error(`[poller] Poll failed: ${err.message}`);
    return;
  }

  // Merge into one entry per PR id, tracking which roles found it.
  /** @type {Map<string, {pr: object, roles: Set<string>}>} */
  const byId = new Map();
  for (const pr of authoredResult.prs) {
    const id = makePrId(pr.repository.owner.login, pr.repository.name, pr.number);
    byId.set(id, { pr, roles: new Set(['author']) });
  }
  for (const pr of reviewerResult.prs) {
    const id = makePrId(pr.repository.owner.login, pr.repository.name, pr.number);
    const existing = byId.get(id);
    if (existing) existing.roles.add('reviewer');
    else byId.set(id, { pr, roles: new Set(['reviewer']) });
  }

  const entries = [...byId.values()];
  upsertPRs(entries);

  // Group seen ids per role so each role's stale-cleanup ignores PRs that
  // happen to be in the other role's list. A PR in the authored list that's
  // missing from the reviewer list shouldn't have its is_review_requested
  // flag cleared - it was never flagged in the first place. This loop builds
  // four buckets: (role, scope) -> [ids].
  const seenAuthorByOrg = new Map();
  const seenAuthorByRepo = new Map();
  const seenReviewerByOrg = new Map();
  const seenReviewerByRepo = new Map();
  for (const { pr, roles } of entries) {
    const o = pr.repository.owner.login;
    const r = pr.repository.name;
    const id = makePrId(o, r, pr.number);
    const inOrg = orgSet.has(o);
    const key = `${o}/${r}`;
    if (roles.has('author')) {
      if (inOrg) {
        if (!seenAuthorByOrg.has(o)) seenAuthorByOrg.set(o, []);
        seenAuthorByOrg.get(o).push(id);
      } else {
        if (!seenAuthorByRepo.has(key)) seenAuthorByRepo.set(key, []);
        seenAuthorByRepo.get(key).push(id);
      }
    }
    if (roles.has('reviewer')) {
      if (inOrg) {
        if (!seenReviewerByOrg.has(o)) seenReviewerByOrg.set(o, []);
        seenReviewerByOrg.get(o).push(id);
      } else {
        if (!seenReviewerByRepo.has(key)) seenReviewerByRepo.set(key, []);
        seenReviewerByRepo.get(key).push(id);
      }
    }
  }
  for (const org of orgs) {
    clearStaleRoleFlag('author', 'org', org, null, seenAuthorByOrg.get(org) || []);
    clearStaleRoleFlag('reviewer', 'org', org, null, seenReviewerByOrg.get(org) || []);
  }
  for (const ownerRepo of repos) {
    const [owner, repo] = ownerRepo.split('/');
    clearStaleRoleFlag('author', 'repo', owner, repo, seenAuthorByRepo.get(ownerRepo) || []);
    clearStaleRoleFlag('reviewer', 'repo', owner, repo, seenReviewerByRepo.get(ownerRepo) || []);
  }

  // Finally delete rows where both role flags are now 0 (workspace + DB cleanup).
  try {
    await cleanupOrphans(config);
  } catch (err) {
    console.error(`[poller] Orphan cleanup failed: ${err.message}`);
  }

  console.log(
    `[poller] Sync complete - ${entries.length} PRs (${authoredResult.prs.length} authored, ${reviewerResult.prs.length} review-requested) across ${qualifier}`,
  );

  // Adopt scratch workspaces whose branch matches a newly-synced PR
  adoptScratchWorkspaces();

  pollerEvents.emit('sync', { synced_at: new Date().toISOString(), pr_count: entries.length });
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
  clearRoleByOrgStmt = null;
  clearRoleByRepoStmt = null;
  clearReviewerRoleByOrgStmt = null;
  clearReviewerRoleByRepoStmt = null;
  findOrphanRowsStmt = null;
  deleteOrphanRowStmt = null;
  getExistingBodyStmt = null;
  getExistingPrevStmt = null;
  getPrByIdStmt = null;
  findScratchesStmt = null;
  findPrByBranchStmt = null;
  findPrByBranchSuffixStmt = null;
  adoptWorkspaceStmt = null;
}
