import { sendError } from '../http-errors.js';
import { execFile } from '../utils.js';

/**
 * Fetch JSON from gh api with pagination.
 * @param {string} endpoint
 * @returns {Promise<object[]>}
 */
async function ghApi(endpoint) {
  const { stdout } = await execFile(
    'gh',
    ['api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github.v3.html+json', endpoint],
    {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  // --slurp wraps pages in an outer array: [[page1items], [page2items]]
  const pages = JSON.parse(stdout);
  return pages.flat();
}

const REVIEW_THREAD_RESOLUTION_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $endCursor) {
          nodes {
            isResolved
            comments(first: 1) {
              nodes { id }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

/**
 * Fetch the root comment node IDs for resolved review threads. The CLI
 * paginates reviewThreads through the query's endCursor variable.
 * @param {string} owner
 * @param {string} repo
 * @param {number} number
 * @returns {Promise<Set<string>>}
 */
async function resolvedReviewThreadRoots(owner, repo, number) {
  const { stdout } = await execFile(
    'gh',
    [
      'api',
      'graphql',
      '--paginate',
      '--slurp',
      '-f',
      `query=${REVIEW_THREAD_RESOLUTION_QUERY}`,
      '-F',
      `owner=${owner}`,
      '-F',
      `repo=${repo}`,
      '-F',
      `number=${number}`,
    ],
    {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  return resolvedThreadRootIds(JSON.parse(stdout));
}

/**
 * @param {object[]} pages
 * @returns {Set<string>}
 */
export function resolvedThreadRootIds(pages) {
  const resolved = new Set();
  for (const page of pages) {
    const pullRequest = page?.data?.repository?.pullRequest;
    if (!pullRequest) throw new Error('Pull request was not found on GitHub');
    for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
      const rootId = thread.comments?.nodes?.[0]?.id;
      if (thread.isResolved && typeof rootId === 'string') resolved.add(rootId);
    }
  }
  return resolved;
}

/**
 * @param {object[]} reviews
 * @param {object[]} inlineComments
 * @param {object[]} conversationComments
 * @param {Set<string>} resolvedRoots
 */
export function buildCommentsPayload(reviews, inlineComments, conversationComments, resolvedRoots) {
  const inlineCommentsById = new Map(inlineComments.map((comment) => [String(comment.id), comment]));

  const rootNodeId = (comment) => {
    let current = comment;
    const seen = new Set();
    while (current?.in_reply_to_id != null && !seen.has(String(current.id))) {
      seen.add(String(current.id));
      const parent = inlineCommentsById.get(String(current.in_reply_to_id));
      if (!parent) break;
      current = parent;
    }
    return current?.node_id;
  };

  // Group inline comments by review ID.
  const commentsByReview = new Map();
  for (const comment of inlineComments) {
    const reviewId = comment.pull_request_review_id;
    if (!commentsByReview.has(reviewId)) commentsByReview.set(reviewId, []);
    commentsByReview.get(reviewId).push({
      path: comment.path,
      diff_position: comment.position,
      body_html: comment.body_html || comment.body,
      created_at: comment.created_at,
      resolved: resolvedRoots.has(rootNodeId(comment)),
    });
  }

  // Build structured reviews.
  const structuredReviews = reviews.map((review) => ({
    id: review.id,
    author: review.user?.login ?? 'unknown',
    state: review.state,
    body_html: review.body_html || review.body || '',
    submitted_at: review.submitted_at,
    comments: commentsByReview.get(review.id) || [],
  }));

  // Build conversation.
  const conversation = conversationComments.map((comment) => ({
    author: comment.user?.login ?? 'unknown',
    body_html: comment.body_html || comment.body,
    created_at: comment.created_at,
  }));

  return { reviews: structuredReviews, conversation };
}

/**
 * In-memory response cache for the comments endpoint. Clicking between PRs
 * normally re-fires three paginated REST calls and one GraphQL call per open;
 * cache hits avoid all four. Entries are invalidated when the PR's updated_at
 * advances or after the TTL, whichever comes first.
 * @type {Map<string, {key: string, ts: number, data: object}>}
 */
const commentsCache = new Map();
const COMMENTS_CACHE_TTL_MS = 60_000;
const COMMENTS_CACHE_MAX_ENTRIES = 200;

/**
 * Register comment routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerCommentRoutes(app) {
  const { getDb } = app.appContext;
  app.get('/api/prs/:id/comments', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number, updated_at FROM prs WHERE id = ?').get(request.params.id);
    if (!pr) {
      return sendError(reply, 'pr_not_found', 'PR not found');
    }

    const cacheId = request.params.id;
    const cacheKey = pr.updated_at || '';
    const now = Date.now();
    const cached = commentsCache.get(cacheId);
    if (cached && cached.key === cacheKey && now - cached.ts < COMMENTS_CACHE_TTL_MS) {
      return cached.data;
    }

    const { org, repo, number } = pr;

    const [reviews, inlineComments, conversationComments, resolvedRoots] = await Promise.all([
      ghApi(`repos/${org}/${repo}/pulls/${number}/reviews`),
      ghApi(`repos/${org}/${repo}/pulls/${number}/comments`),
      ghApi(`repos/${org}/${repo}/issues/${number}/comments`),
      resolvedReviewThreadRoots(org, repo, number),
    ]);

    const payload = buildCommentsPayload(reviews, inlineComments, conversationComments, resolvedRoots);

    // Bound the cache so it can't grow unboundedly across long-lived sessions.
    if (commentsCache.size >= COMMENTS_CACHE_MAX_ENTRIES) {
      const oldest = commentsCache.keys().next().value;
      if (oldest !== undefined) commentsCache.delete(oldest);
    }
    commentsCache.set(cacheId, { key: cacheKey, ts: now, data: payload });
    return payload;
  });
}
