import { getDb } from '../db.js';
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

/**
 * In-memory response cache for the comments endpoint. Clicking between PRs
 * normally re-fires three paginated REST calls per open; cache hits avoid all
 * three. Entries are invalidated when the PR's updated_at advances or after
 * the TTL, whichever comes first.
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
  app.get('/api/prs/:id/comments', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number, updated_at FROM prs WHERE id = ?').get(request.params.id);
    if (!pr) {
      return reply.code(404).send({ error: 'PR not found' });
    }

    const cacheId = request.params.id;
    const cacheKey = pr.updated_at || '';
    const now = Date.now();
    const cached = commentsCache.get(cacheId);
    if (cached && cached.key === cacheKey && now - cached.ts < COMMENTS_CACHE_TTL_MS) {
      return cached.data;
    }

    const { org, repo, number } = pr;

    // Fetch all three endpoints in parallel
    const [reviews, inlineComments, conversationComments] = await Promise.all([
      ghApi(`repos/${org}/${repo}/pulls/${number}/reviews`),
      ghApi(`repos/${org}/${repo}/pulls/${number}/comments`),
      ghApi(`repos/${org}/${repo}/issues/${number}/comments`),
    ]);

    // Group inline comments by review ID
    const commentsByReview = new Map();
    for (const c of inlineComments) {
      const reviewId = c.pull_request_review_id;
      if (!commentsByReview.has(reviewId)) {
        commentsByReview.set(reviewId, []);
      }
      commentsByReview.get(reviewId).push({
        path: c.path,
        diff_position: c.position,
        body_html: c.body_html || c.body,
        created_at: c.created_at,
      });
    }

    // Build structured reviews
    const structuredReviews = reviews.map((r) => ({
      id: r.id,
      author: r.user?.login ?? 'unknown',
      state: r.state,
      body_html: r.body_html || r.body || '',
      submitted_at: r.submitted_at,
      comments: commentsByReview.get(r.id) || [],
    }));

    // Build conversation
    const conversation = conversationComments.map((c) => ({
      author: c.user?.login ?? 'unknown',
      body_html: c.body_html || c.body,
      created_at: c.created_at,
    }));

    const payload = { reviews: structuredReviews, conversation };

    // Bound the cache so it can't grow unboundedly across long-lived sessions.
    if (commentsCache.size >= COMMENTS_CACHE_MAX_ENTRIES) {
      const oldest = commentsCache.keys().next().value;
      if (oldest !== undefined) commentsCache.delete(oldest);
    }
    commentsCache.set(cacheId, { key: cacheKey, ts: now, data: payload });
    return payload;
  });
}
