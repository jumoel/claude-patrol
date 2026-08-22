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

function sendError(reply, status, code, message) {
  return reply.code(status).send({ error: message, code });
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
      return sendError(reply, 409, 'work_item_child_managed', 'Work-item children do not support peer review');
    }
    const workspace = findWorkspaceSession(getDb(), request.params.id);
    if (!workspace) return sendError(reply, 404, 'workspace_not_found', 'Workspace not found');
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
      return sendError(reply, 409, 'work_item_child_managed', 'Work-item children do not support peer review');
    }
    const body = request.body;
    if (
      body !== undefined &&
      (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)
    ) {
      return sendError(reply, 400, 'invalid_request', 'This endpoint does not accept request fields');
    }

    const row = findWorkspaceSession(getDb(), request.params.id, true);
    if (!row?.pr_id || !row.session_id) {
      return sendError(
        reply,
        409,
        'review_not_ready',
        'A ready PR workspace with an attached agent session is required',
      );
    }

    const reviewerProvider = inverseProvider(row.presenter_provider);
    const capability = await providerCapabilities[reviewerProvider].refreshIfStale();
    if (!capability.available) {
      return sendError(
        reply,
        503,
        `${reviewerProvider}_unavailable`,
        capability.reason || `${providerName(reviewerProvider)} is unavailable`,
      );
    }

    const readiness = getSessionPeerReviewReadiness(row.session_id);
    if (!readiness.ready) {
      return sendError(
        reply,
        409,
        readiness.reason,
        `Restart this ${providerName(row.presenter_provider)} session before requesting a peer review`,
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
      const status = error.code === 'review_in_progress' || error.code === 'session_busy' ? 409 : 500;
      return sendError(reply, status, error.code || 'review_dispatch_failed', error.message);
    }
  });
}
