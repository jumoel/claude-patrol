const REVIEW_PROMPT =
  'Run the Patrol review_with_codex tool now. Wait for it to finish, then present the complete review findings to me. Do not edit files or act on the findings.';

function sendError(reply, status, code, message) {
  return reply.code(status).send({ error: message, code });
}

/** Register explicit, user-triggered Codex review routes. */
export function registerCodexReviewRoutes(app) {
  const {
    getDb,
    codexCapability,
    codexReviewCoordinator,
    dispatchToSession,
    waitForFirstIdle,
    getSessionCodexReviewReadiness,
  } = app.appContext;

  app.get('/api/workspaces/:id/codex-review', (request, reply) => {
    const workspace = getDb()
      .prepare(
        `SELECT w.id,
                w.pr_id,
                w.status,
                w.operation_state,
                s.id AS session_id
           FROM workspaces w
           LEFT JOIN sessions s ON s.workspace_id = w.id AND s.status = 'active'
          WHERE w.id = ?
          ORDER BY s.started_at DESC
          LIMIT 1`,
      )
      .get(request.params.id);
    if (!workspace) return sendError(reply, 404, 'workspace_not_found', 'Workspace not found');
    let readiness = { ready: true, reason: null };
    if (!workspace.pr_id) readiness = { ready: false, reason: 'pr_workspace_required' };
    else if (workspace.status !== 'active' || workspace.operation_state !== 'ready') {
      readiness = { ready: false, reason: 'review_not_ready' };
    } else if (!workspace.session_id) readiness = { ready: false, reason: 'active_session_required' };
    else readiness = getSessionCodexReviewReadiness(workspace.session_id);
    return { review: codexReviewCoordinator.getByWorkspace(request.params.id), ...readiness };
  });

  app.post('/api/workspaces/:id/codex-review', async (request, reply) => {
    const body = request.body;
    if (
      body !== undefined &&
      (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length > 0)
    ) {
      return sendError(reply, 400, 'invalid_request', 'This endpoint does not accept request fields');
    }

    const capability = await codexCapability.refreshIfStale();
    if (!capability.available) {
      return sendError(reply, 503, 'codex_unavailable', capability.reason || 'Codex is unavailable');
    }

    const row = getDb()
      .prepare(
        `SELECT w.id AS workspace_id,
                w.pr_id AS pr_id,
                s.id AS session_id
           FROM workspaces w
           JOIN prs p ON p.id = w.pr_id
           JOIN sessions s ON s.workspace_id = w.id AND s.status = 'active'
          WHERE w.id = ? AND w.status = 'active' AND w.operation_state = 'ready'
          ORDER BY s.started_at DESC
          LIMIT 1`,
      )
      .get(request.params.id);
    if (!row) {
      return sendError(
        reply,
        409,
        'review_not_ready',
        'A ready PR workspace with an attached Claude session is required',
      );
    }

    const readiness = getSessionCodexReviewReadiness(row.session_id);
    if (!readiness.ready) {
      return sendError(reply, 409, readiness.reason, 'Restart this Claude session before requesting a Codex review');
    }

    let review;
    try {
      review = codexReviewCoordinator.request({
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        prId: row.pr_id,
      });
      await waitForFirstIdle(row.session_id);
      const dispatchedAt = await dispatchToSession(row.session_id, REVIEW_PROMPT);
      return reply.code(202).send({ review, dispatchedAt });
    } catch (error) {
      if (review) codexReviewCoordinator.fail(review.id, error);
      const status = error.code === 'review_in_progress' || error.code === 'session_busy' ? 409 : 500;
      return sendError(reply, status, error.code || 'review_dispatch_failed', error.message);
    }
  });
}
