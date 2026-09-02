import { sanitizePublicText } from './public-errors.js';

/**
 * One error shape for every route:
 *
 *   { error: { code, message, detail, failed_provider, retry_action, recovery_actions } }
 *
 * and one table from code to HTTP status. Routes call sendError with a code
 * and a message; the status comes from the table unless the caller has a
 * reason to override it. Unknown codes are internal errors (500).
 */
export const ERROR_STATUS = Object.freeze({
  // Request validation
  invalid_request: 400,
  invalid_provider: 400,
  invalid_session_name: 400,
  invalid_reference: 400,
  invalid_title: 400,
  invalid_bookmark: 400,
  invalid_repositories: 400,
  invalid_source: 400,
  invalid_repository: 400,
  invalid_revision: 400,
  invalid_pull_request: 400,
  invalid_config: 400,
  invalid_dry_run: 400,
  repository_not_configured: 400,
  repository_not_discovered: 400,
  repository_limit: 400,
  repository_not_in_work_item: 400,
  work_items_not_configured: 400,
  pull_request_not_found: 400,
  restart_not_needed: 400,
  // Auth
  authentication_required: 401,
  origin_not_allowed: 403,
  // Missing resources
  not_found: 404,
  pr_not_found: 404,
  workspace_not_found: 404,
  session_not_found: 404,
  work_item_not_found: 404,
  transcript_not_found: 404,
  rule_not_found: 404,
  // State conflicts
  invalid_state: 409,
  session_exists: 409,
  session_busy: 409,
  session_not_detached: 409,
  session_in_workspace: 409,
  provider_conflict: 409,
  provider_unsupported: 409,
  global_session_limit: 409,
  work_item_busy: 409,
  work_item_destroyed: 409,
  work_item_child_managed: 409,
  pull_request_owned: 409,
  legacy_workspace_exists: 409,
  review_in_progress: 409,
  review_not_ready: 409,
  reconciliation_busy: 409,
  no_interrupted_operation: 409,
  cooldown: 409,
  // Gone
  session_dead: 410,
  // Upstream and availability
  upstream_failed: 502,
  claude_unavailable: 503,
  codex_unavailable: 503,
  rules_engine_stopped: 503,
});

/**
 * @param {string | undefined} code
 * @param {number} [fallback]
 */
export function statusForCode(code, fallback = 500) {
  return (code && ERROR_STATUS[code]) || fallback;
}

/**
 * @param {string} code
 * @param {string} message
 * @param {{ detail?: string | null, failed_provider?: string | null, retry_action?: string | null, recovery_actions?: object[] }} [extras]
 */
export function errorEnvelope(code, message, extras = {}) {
  return {
    code,
    message: sanitizePublicText(message ?? 'Request failed', { maxBytes: 4096 }),
    detail: extras.detail ?? null,
    failed_provider: extras.failed_provider ?? null,
    retry_action: extras.retry_action ?? null,
    recovery_actions: extras.recovery_actions ?? [],
  };
}

/**
 * Send the standard error envelope.
 * @param {import('fastify').FastifyReply} reply
 * @param {string} code
 * @param {string} message
 * @param {{ status?: number } & Parameters<typeof errorEnvelope>[2]} [options]
 */
export function sendError(reply, code, message, { status, ...extras } = {}) {
  return reply.code(status ?? statusForCode(code)).send({ error: errorEnvelope(code, message, extras) });
}

/**
 * Send the envelope for a thrown error, using its `code` when it has one.
 * @param {import('fastify').FastifyReply} reply
 * @param {unknown} error
 * @param {{ code?: string, status?: number, message?: string } & Parameters<typeof errorEnvelope>[2]} [options]
 */
export function sendErrorFrom(reply, error, { code, status, message, ...extras } = {}) {
  const resolvedCode = code ?? /** @type {{ code?: string }} */ (error)?.code ?? 'internal_error';
  const resolvedMessage = message ?? /** @type {{ message?: string }} */ (error)?.message ?? 'Request failed';
  return sendError(reply, resolvedCode, resolvedMessage, { status, ...extras });
}
