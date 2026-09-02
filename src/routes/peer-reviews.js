import { z } from 'zod';
import { parseBody, sendError, sendErrorFrom } from '../http-errors.js';

const REVIEW_TOOLS = Object.freeze({
  claude: 'review_with_claude',
  codex: 'review_with_codex',
});

function inverseProvider(provider) {
  return provider === 'claude' ? 'codex' : 'claude';
}

function providerName(provider) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function reviewPrompt(reviewerProvider) {
  return `Run the Patrol ${REVIEW_TOOLS[reviewerProvider]} tool now. Wait for it to finish, then present the complete review findings to me. Do not edit files or act on the findings.`;
}

function findWorkspaceSession(db, workspaceId, requireReady = false) {
  const stateFilter = requireReady ? "AND w.status = 'active' AND w.operation_state = 'ready'" : '';
  return db
    .prepare(
      `SELECT w.id AS workspace_id,
              w.pr_id AS pr_id,
              w.status,
              w.operation_state,
              s.id AS session_id,
              s.provider AS presenter_provider
         FROM workspaces w
         LEFT JOIN sessions s ON s.workspace_id = w.id AND s.status = 'active'
        WHERE w.id = ? AND w.work_item_id IS NULL ${stateFilter}
        ORDER BY s.started_at DESC
        LIMIT 1`,
    )
    .get(workspaceId);
}

function findWorkItemSession(db, workItemId, prId = null) {
  return db
    .prepare(
      `SELECT wi.id AS work_item_id,
              wi.state,
              s.id AS session_id,
              s.provider AS presenter_provider,
              l.pr_id AS pr_id,
              p.number,
              p.org,
              p.repo,
              p.base_branch,
              child.id AS workspace_id,
              child.path AS workspace_path,
              child.status AS workspace_status,
              child.operation_state AS workspace_operation_state
         FROM work_items wi
         LEFT JOIN sessions s
           ON s.work_item_id = wi.id AND s.status = 'active'
         LEFT JOIN work_item_pull_requests l
           ON l.work_item_id = wi.id AND l.pr_id = ?
         LEFT JOIN prs p ON p.id = l.pr_id
         LEFT JOIN workspaces child
           ON child.rowid = (
             SELECT candidate.rowid
               FROM workspaces candidate
              WHERE candidate.work_item_id = wi.id
                AND candidate.repo = p.org || '/' || p.repo
              ORDER BY candidate.created_at DESC, candidate.rowid DESC
              LIMIT 1
           )
        WHERE wi.id = ?
        ORDER BY s.started_at DESC
        LIMIT 1`,
    )
    .get(prId, workItemId);
}

function workItemReadiness(row, getSessionPeerReviewReadiness) {
  if (row.state !== 'ready') return { ready: false, reason: 'review_not_ready' };
  if (!row.session_id) return { ready: false, reason: 'active_session_required' };
  if (!row.pr_id) return { ready: false, reason: 'pull_request_required' };
  if (!row.number) return { ready: false, reason: 'tracked_pull_request_required' };
  if (row.workspace_status !== 'active' || row.workspace_operation_state !== 'ready') {
    return { ready: false, reason: 'repository_workspace_required' };
  }
  return getSessionPeerReviewReadiness(row.session_id);
}

const emptyBody = z.object({}).strict().optional();
const workItemReviewBody = z.object({ pr_id: z.string().min(1) }).strict();

/** Register explicit, user-triggered peer review routes. */
export function registerPeerReviewRoutes(app) {
  const {
    getDb,
    providerCapabilities,
    peerReviewCoordinator,
    dispatchToSession,
    waitForFirstIdle,
    getSessionPeerReviewReadiness,
  } = app.appContext;

  app.get('/api/workspaces/:id/peer-review', (request, reply) => {
    const child = getDb().prepare('SELECT work_item_id FROM workspaces WHERE id = ?').get(request.params.id);
    if (child?.work_item_id) {
      return sendError(reply, 'work_item_child_managed', 'Work-item children do not support peer review');
    }
    const workspace = findWorkspaceSession(getDb(), request.params.id);
    if (!workspace) return sendError(reply, 'workspace_not_found', 'Workspace not found');
    const reviewerProvider = workspace.presenter_provider ? inverseProvider(workspace.presenter_provider) : null;
    let readiness = { ready: true, reason: null };
    if (!workspace.pr_id) readiness = { ready: false, reason: 'pr_workspace_required' };
    else if (workspace.status !== 'active' || workspace.operation_state !== 'ready') {
      readiness = { ready: false, reason: 'review_not_ready' };
    } else if (!workspace.session_id) readiness = { ready: false, reason: 'active_session_required' };
    else readiness = getSessionPeerReviewReadiness(workspace.session_id);
    return {
      review: peerReviewCoordinator.getByWorkspace(request.params.id),
      presenterProvider: workspace.presenter_provider,
      reviewerProvider,
      ...readiness,
    };
  });

  app.post('/api/workspaces/:id/peer-review', async (request, reply) => {
    const child = getDb().prepare('SELECT work_item_id FROM workspaces WHERE id = ?').get(request.params.id);
    if (child?.work_item_id) {
      return sendError(reply, 'work_item_child_managed', 'Work-item children do not support peer review');
    }
    if (parseBody(emptyBody, request.body).error) {
      return sendError(reply, 'invalid_request', 'This endpoint does not accept request fields');
    }

    const row = findWorkspaceSession(getDb(), request.params.id, true);
    if (!row?.pr_id || !row.session_id) {
      return sendError(reply, 'review_not_ready', 'A ready PR workspace with an attached agent session is required');
    }

    const reviewerProvider = inverseProvider(row.presenter_provider);
    const capability = await providerCapabilities[reviewerProvider].refreshIfStale();
    if (!capability.available) {
      return sendError(
        reply,
        `${reviewerProvider}_unavailable`,
        capability.reason || `${providerName(reviewerProvider)} is unavailable`,
      );
    }

    const readiness = getSessionPeerReviewReadiness(row.session_id);
    if (!readiness.ready) {
      return sendError(
        reply,
        readiness.reason,
        `Restart this ${providerName(row.presenter_provider)} session before requesting a peer review`,
        { status: 409 },
      );
    }

    let review;
    try {
      review = peerReviewCoordinator.request({
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        prId: row.pr_id,
        presenterProvider: row.presenter_provider,
        reviewerProvider,
      });
      await waitForFirstIdle(row.session_id);
      const dispatchedAt = await dispatchToSession(row.session_id, reviewPrompt(reviewerProvider));
      return reply.code(202).send({ review, dispatchedAt });
    } catch (error) {
      if (review) peerReviewCoordinator.fail(review.id, error);
      return sendErrorFrom(reply, error, { code: error.code || 'review_dispatch_failed' });
    }
  });

  app.get('/api/work-items/:id/peer-review', (request, reply) => {
    const prId = typeof request.query?.pr_id === 'string' ? request.query.pr_id : null;
    const row = findWorkItemSession(getDb(), request.params.id, prId);
    if (!row) return sendError(reply, 'work_item_not_found', 'Work item not found');
    const reviewerProvider = row.presenter_provider ? inverseProvider(row.presenter_provider) : null;
    return {
      review: peerReviewCoordinator.getByWorkItem(request.params.id),
      presenterProvider: row.presenter_provider,
      reviewerProvider,
      ...workItemReadiness(row, getSessionPeerReviewReadiness),
    };
  });

  app.post('/api/work-items/:id/peer-review', async (request, reply) => {
    const body = parseBody(workItemReviewBody, request.body);
    if (body.error) return sendError(reply, 'invalid_request', `This endpoint requires pr_id (${body.error})`);

    const row = findWorkItemSession(getDb(), request.params.id, body.data.pr_id);
    if (!row) return sendError(reply, 'work_item_not_found', 'Work item not found');
    const readiness = workItemReadiness(row, getSessionPeerReviewReadiness);
    if (!readiness.ready) {
      return sendError(reply, readiness.reason, 'A ready work item, linked PR, repository, and session are required', {
        status: 409,
      });
    }

    const reviewerProvider = inverseProvider(row.presenter_provider);
    const capability = await providerCapabilities[reviewerProvider].refreshIfStale();
    if (!capability.available) {
      return sendError(
        reply,
        `${reviewerProvider}_unavailable`,
        capability.reason || `${providerName(reviewerProvider)} is unavailable`,
      );
    }

    let review;
    try {
      review = peerReviewCoordinator.request({
        workItemId: row.work_item_id,
        sessionId: row.session_id,
        prId: row.pr_id,
        presenterProvider: row.presenter_provider,
        reviewerProvider,
      });
      await waitForFirstIdle(row.session_id);
      const dispatchedAt = await dispatchToSession(row.session_id, reviewPrompt(reviewerProvider));
      return reply.code(202).send({ review, dispatchedAt });
    } catch (error) {
      if (review) peerReviewCoordinator.fail(review.id, error);
      return sendErrorFrom(reply, error, { code: error.code || 'review_dispatch_failed' });
    }
  });
}
