import { getDb } from '../db.js';
import { execFile } from '../utils.js';

/**
 * Fetch JSON from gh api with pagination.
 * @param {string} endpoint
 * @returns {Promise<object[]>}
 */
async function ghApi(endpoint) {
  const { stdout } = await execFile('gh', ['api', '--paginate', '--slurp', endpoint], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  // --slurp wraps pages in an outer array: [[page1items], [page2items]]
  const pages = JSON.parse(stdout);
  return pages.flat();
}

/**
 * Register comment routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerCommentRoutes(app) {
  app.get('/api/prs/:id/comments', async (request, reply) => {
    const db = getDb();
    const pr = db.prepare('SELECT org, repo, number FROM prs WHERE id = ?').get(
      decodeURIComponent(request.params.id),
    );
    if (!pr) {
      return reply.code(404).send({ error: 'PR not found' });
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
        body: c.body,
        created_at: c.created_at,
      });
    }

    // Build structured reviews
    const structuredReviews = reviews.map(r => ({
      id: r.id,
      author: r.user?.login ?? 'unknown',
      state: r.state,
      body: r.body || '',
      submitted_at: r.submitted_at,
      comments: commentsByReview.get(r.id) || [],
    }));

    // Build conversation
    const conversation = conversationComments.map(c => ({
      author: c.user?.login ?? 'unknown',
      body: c.body,
      created_at: c.created_at,
    }));

    return { reviews: structuredReviews, conversation };
  });
}
