import { ApiError } from './errors.js';

const BASE = '';

/**
 * Assign one known API contract at the response boundary. This is a static
 * contract, not runtime validation. Callers must still treat provider-defined
 * extension fields as unknown.
 * @template T
 * @param {Response} response
 * @returns {Promise<T>}
 */
function readJson(response) {
  return /** @type {Promise<T>} */ (response.json());
}

/**
 * Build an API path with every interpolated value URL-encoded, so ids such as
 * "org/repo#42" survive the round trip.
 * @param {TemplateStringsArray} strings
 * @param {...(string | number)} values
 */
function path(strings, ...values) {
  return strings.reduce(
    (acc, part, index) => acc + part + (index < values.length ? encodeURIComponent(String(values[index])) : ''),
    '',
  );
}

/** Empty envelope fields, so callers can rely on every key being present. */
const EMPTY_ENVELOPE = Object.freeze({
  detail: null,
  failed_provider: null,
  retry_action: null,
  recovery_actions: [],
});

/**
 * Turn a failed response into an ApiError. The server always answers with
 * `{ error: { code, message, ... } }`; anything else (a proxy, a crashed
 * process) becomes an `http_error` with the status text as the message.
 * @param {Response} response
 * @returns {Promise<ApiError>}
 */
async function toApiError(response) {
  /** @type {unknown} */
  const body = await response.json().catch(/** @returns {null} */ () => null);
  const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new ApiError(response.status, {
      ...EMPTY_ENVELOPE,
      .../** @type {import('../types').ApiErrorEnvelope} */ (error),
    });
  }
  const message = typeof error === 'string' ? error : `${response.status} ${response.statusText}`.trim();
  return new ApiError(response.status, { ...EMPTY_ENVELOPE, code: 'http_error', message });
}

/**
 * One request helper for every endpoint: JSON body encoding, one error type,
 * one place to add headers or credentials later.
 * @template T
 * @param {string} url
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} [init]
 * @returns {Promise<T>}
 */
async function request(url, { method = 'GET', body, signal } = {}) {
  /** @type {RequestInit} */
  const init = { method, signal };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${url}`, init);
  if (!response.ok) throw await toApiError(response);
  return readJson(response);
}

/**
 * Fetch PRs with optional filters.
 * @param {Record<string, string>} [filters]
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('../types').PullRequestListResponse>}
 */
export function fetchPRs(filters = {}, signal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== 'all') {
      params.set(key, value);
    }
  }
  return request(`/api/prs${params.toString() ? `?${params}` : ''}`, { signal });
}

/**
 * Fetch a single PR by ID.
 * @param {string} id
 * @returns {Promise<import('../types').PullRequest>}
 */
export function fetchPR(id) {
  return request(path`/api/prs/${id}`);
}

/**
 * Force-refresh a single PR from GitHub right now. Returns the updated PR row.
 * @param {string} id
 * @returns {Promise<import('../types').RefreshPullRequestResponse>}
 */
export function refreshPR(id) {
  return request(path`/api/prs/${id}/refresh`, { method: 'POST' });
}

/**
 * Trigger an immediate sync.
 * @returns {Promise<{ok: boolean}>}
 */
export function triggerSync() {
  return request('/api/sync/trigger', { method: 'POST' });
}

/**
 * Fetch public config.
 * @returns {Promise<import('../types').PublicConfig>}
 */
export function fetchConfig() {
  return request('/api/config');
}

/** Resolve noninteractive review capability for both agent providers. */
export function fetchProviderCapabilities(force = false) {
  return request(`/api/capabilities/providers${force ? '?refresh=true' : ''}`);
}

/**
 * Fetch workspaces, optionally filtered by PR ID.
 * @param {string} [prId]
 * @returns {Promise<import('../types').Workspace[]>}
 */
export function fetchWorkspaces(prId) {
  return request(prId ? path`/api/workspaces?pr_id=${prId}` : '/api/workspaces');
}

/**
 * Create a workspace for a PR.
 * @param {string} prId
 * @returns {Promise<{work_item: import('../types').WorkItemListItem}>}
 */
export function createWorkspace(prId) {
  return request('/api/work-items', { method: 'POST', body: { source: 'pull_request', pr_id: prId } });
}

/**
 * Fetch a single workspace by ID.
 * @param {string} id
 * @returns {Promise<import('../types').Workspace>}
 */
export function fetchWorkspace(id) {
  return request(path`/api/workspaces/${id}`);
}

/** @param {{type: 'workspace'|'work_item', id: string}} target */
function peerReviewPath(target) {
  const type = target.type === 'work_item' ? 'work-items' : 'workspaces';
  return path`/api/${type}/${target.id}/peer-review`;
}

/**
 * Fetch the current explicit peer review lifecycle for a local-work target.
 * @param {{type: 'workspace'|'work_item', id: string}} target
 * @param {string} [prId]
 * @returns {Promise<import('../types').PeerReviewStatusResponse>}
 */
export function fetchPeerReviewState(target, prId) {
  const query = target.type === 'work_item' && prId ? path`?pr_id=${prId}` : '';
  return request(`${peerReviewPath(target)}${query}`);
}

/**
 * Ask the attached session to run its reserved inverse-provider review tool.
 * @param {{type: 'workspace'|'work_item', id: string}} target
 * @param {string} [prId]
 * @returns {Promise<{review: import('../types').PeerReview, dispatchedAt: number}>}
 */
export function requestPeerReview(target, prId) {
  return request(peerReviewPath(target), {
    method: 'POST',
    body: target.type === 'work_item' ? { pr_id: prId } : {},
  });
}

/**
 * Destroy a workspace.
 * @param {string} workspaceId
 * @returns {Promise<{ok: boolean}>}
 */
export function destroyWorkspace(workspaceId) {
  return request(path`/api/workspaces/${workspaceId}`, { method: 'DELETE' });
}

/** @param {import('../types').SessionTarget} target */
function sessionTargetQuery(target) {
  const params = new URLSearchParams();
  if (target.type === 'workspace') params.set('workspace_id', target.id);
  else if (target.type === 'work_item') params.set('work_item_id', target.id);
  else params.set('global', 'true');
  return params.toString();
}

/**
 * Fetch sessions for one explicit target.
 * @param {import('../types').SessionTarget} [target]
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('../types').Session[]>}
 */
export function fetchSessions(target, signal) {
  return request(`/api/sessions${target ? `?${sessionTargetQuery(target)}` : ''}`, { signal });
}

/**
 * Create a session.
 * @param {import('../types').SessionTarget} target
 * @param {import('../types').AgentProvider} provider
 * @param {string} [name]
 * @returns {Promise<import('../types').Session>}
 */
export function createSession(target, provider, name) {
  const body =
    target.type === 'workspace'
      ? { workspace_id: target.id, provider }
      : target.type === 'work_item'
        ? { work_item_id: target.id, provider }
        : { global: true, provider, ...(name === undefined ? {} : { name }) };
  return request('/api/sessions', { method: 'POST', body });
}

/**
 * @param {string} sessionId
 * @param {string} name
 * @returns {Promise<import('../types').Session>}
 */
export function renameSession(sessionId, name) {
  return request(path`/api/sessions/${sessionId}`, { method: 'PATCH', body: { name } });
}

/**
 * Fetch CI check logs for a PR.
 * @param {string} prId
 * @param {string} [runId] - optional run ID filter
 * @returns {Promise<{logs: import('../types').CheckLog[]}>}
 */
export function fetchCheckLogs(prId, runId) {
  return request(path`/api/prs/${prId}/check-logs` + (runId ? path`?run_id=${runId}` : ''));
}

/**
 * Re-run the failed checks on a PR, optionally only those whose name contains
 * `checkName`.
 * @param {string} prId
 * @param {string} [checkName]
 * @returns {Promise<import('../types').RetriggerChecksResponse>}
 */
export function retriggerChecks(prId, checkName) {
  return request('/api/checks/retrigger', {
    method: 'POST',
    body: { pr_id: prId, ...(checkName ? { check_name: checkName } : {}) },
  });
}

/**
 * Fetch review comments for a PR.
 * @param {string} prId
 * @returns {Promise<import('../types').PullRequestCommentsResponse>}
 */
export function fetchPRComments(prId) {
  return request(path`/api/prs/${prId}/comments`);
}

/**
 * Kill a session.
 * @param {string} sessionId
 * @returns {Promise<{ok: boolean}>}
 */
export function killSession(sessionId) {
  return request(path`/api/sessions/${sessionId}`, { method: 'DELETE' });
}

/**
 * Promote a global session to a one-repository manual work item.
 * @param {string} sessionId
 * @param {string} repo - "org/repo" format
 * @param {string} branch - branch name
 * @returns {Promise<{work_item: import('../types').WorkItemDetail, session: import('../types').Session}>}
 */
export function promoteSession(sessionId, repo, branch) {
  return request(path`/api/sessions/${sessionId}/promote`, { method: 'POST', body: { repo, branch } });
}

/**
 * @param {string} sessionId
 * @returns {Promise<import('../types').Session>}
 */
export function reattachSession(sessionId) {
  return request(path`/api/sessions/${sessionId}/reattach`, { method: 'POST' });
}

/**
 * Fetch session history (killed sessions) for one explicit target.
 * @param {import('../types').SessionTarget} target
 * @returns {Promise<import('../types').Session[]>}
 */
export function fetchSessionHistory(target) {
  return request(`/api/sessions/history?${sessionTargetQuery(target)}`);
}

/** @param {AbortSignal} [signal] @returns {Promise<import('../types').WorkItemListResponse>} */
export function fetchWorkItems(signal) {
  return request('/api/work-items', { signal });
}

/** @param {string} id @param {AbortSignal} [signal] @returns {Promise<{work_item: import('../types').WorkItemDetail}>} */
export function fetchWorkItem(id, signal) {
  return request(path`/api/work-items/${id}`, { signal });
}

/**
 * @param {string} workItemId
 * @param {string} pr
 * @returns {Promise<{pull_request: import('../types').WorkItemPullRequest}>}
 */
export function linkWorkItemPullRequest(workItemId, pr) {
  return request(path`/api/work-items/${workItemId}/pull-requests`, { method: 'POST', body: { pr } });
}

/**
 * @param {string} workItemId
 * @param {string} pr
 * @returns {Promise<{removed: boolean, pr_id: string, work_item_id: string}>}
 */
export function unlinkWorkItemPullRequest(workItemId, pr) {
  return request(path`/api/work-items/${workItemId}/pull-requests`, { method: 'DELETE', body: { pr } });
}

/**
 * @param {string} reference
 * @param {import('../types').AgentProvider} resolverProvider
 * @returns {Promise<{work_item: import('../types').WorkItemListItem}>}
 */
export function createWorkItem(reference, resolverProvider) {
  return request('/api/work-items', {
    method: 'POST',
    body: { source: 'reference', reference, resolver_provider: resolverProvider },
  });
}

/**
 * @param {string} title
 * @param {string[]} repositories
 * @param {string} [bookmark]
 * @returns {Promise<{work_item: import('../types').WorkItemListItem}>}
 */
export function createManualWorkItem(title, repositories, bookmark) {
  return request('/api/work-items', {
    method: 'POST',
    body: {
      source: 'manual',
      title,
      repositories,
      ...(bookmark?.trim() ? { bookmark: bookmark.trim() } : {}),
    },
  });
}

/** @param {string} id @returns {Promise<{work_item: import('../types').WorkItemListItem}>} */
export function retryWorkItem(id) {
  return request(path`/api/work-items/${id}/retry`, { method: 'POST', body: {} });
}

/** @param {string} id @returns {Promise<{work_item: import('../types').WorkItemDetail}>} */
export function destroyWorkItem(id) {
  return request(path`/api/work-items/${id}`, { method: 'DELETE' });
}

/**
 * Fetch a session's transcript.
 * @param {string} sessionId
 * @returns {Promise<import('../types').TranscriptEntry[]>}
 */
export function fetchSessionTranscript(sessionId) {
  return request(path`/api/sessions/${sessionId}/transcript`);
}

/**
 * Save config (poll targets).
 * @param {{ poll: { orgs: string[], repos: string[], interval_seconds: number } }} config
 * @returns {Promise<{ok: boolean}>}
 */
export function saveConfig(config) {
  return request('/api/config', { method: 'POST', body: config });
}

/**
 * Fetch all available repos from configured orgs + explicit repos.
 * @returns {Promise<{repos: string[]}>}
 */
export function fetchAllRepos() {
  return request('/api/repos');
}

/**
 * Toggle a PR's draft status.
 * @param {string} prId
 * @param {boolean} draft - true to convert to draft, false to mark ready
 * @returns {Promise<{ok: boolean, draft: boolean}>}
 */
export function setPRDraft(prId, draft) {
  return request(path`/api/prs/${prId}/draft`, { method: 'POST', body: { draft } });
}

/**
 * @returns {Promise<{accounts: import('../types').SetupAccount[]}>}
 */
export function fetchSetupAccounts() {
  return request('/api/setup/accounts');
}

/**
 * Fetch repos for a GitHub account.
 * @param {string} account
 * @returns {Promise<{repos: import('../types').SetupRepo[]}>}
 */
export function fetchSetupRepos(account) {
  return request(path`/api/setup/repos?account=${account}`);
}

/**
 * Trigger git pull to update claude-patrol.
 * @returns {Promise<{ok: boolean, output?: string}>}
 */
export function triggerUpdate() {
  return request('/api/update', { method: 'POST' });
}

/**
 * Restart the server to apply a pulled update.
 * The server spawns a new process with --reattach (preserving terminal sessions)
 * then exits. The frontend should poll until the new instance is up.
 * @returns {Promise<{ok: boolean}>}
 */
export function triggerRestart() {
  return request('/api/restart', { method: 'POST' });
}

/** @returns {Promise<import('../types').RestartStatus>} */
export function fetchRestartStatus() {
  return request('/api/restart/status');
}

/**
 * Fetch loaded rules + per-rule load errors.
 * @returns {Promise<{rules: import('../types').RuleDefinition[], errors: import('../types').RuleLoadError[]}>}
 */
export function fetchRules() {
  return request('/api/rules');
}

/**
 * Fetch rule subscriptions for a PR.
 * @param {string} prId
 * @returns {Promise<import('../types').RuleSubscription[]>}
 */
export function fetchPRRuleSubscriptions(prId) {
  return request(path`/api/prs/${prId}/rule-subscriptions`);
}

/**
 * Subscribe a PR to a rule (only valid for `requires_subscription: true` rules).
 * @param {string} ruleId
 * @param {string} prId
 * @returns {Promise<{rule_id: string, pr_id: string, created: boolean}>}
 */
export function subscribeRuleForPR(ruleId, prId) {
  return request(path`/api/rules/${ruleId}/subscribe`, { method: 'POST', body: { pr_id: prId } });
}

/**
 * Unsubscribe a PR from a rule.
 * @param {string} ruleId
 * @param {string} prId
 * @returns {Promise<{rule_id: string, pr_id: string}>}
 */
export function unsubscribeRuleForPR(ruleId, prId) {
  return request(path`/api/rules/${ruleId}/subscribe`, { method: 'DELETE', body: { pr_id: prId } });
}

/**
 * Fire a rule manually against a PR or session.
 * @param {string} ruleId
 * @param {{pr_id?: string, session_id?: string, force?: boolean}} [options]
 * @returns {Promise<import('../types').RuleRun>}
 */
export async function runRuleManually(ruleId, { pr_id, session_id, force } = {}) {
  /** @type {import('../types').RuleRun} */
  const run = await request(path`/api/rules/${ruleId}/run` + (force ? '?force=true' : ''), {
    method: 'POST',
    body: { pr_id, session_id },
  });
  // The route returns 200 with the run row even when the action chain errored
  // (e.g. session_busy). Surface that so the UI doesn't swallow the failure.
  if (run.status === 'error') throw new Error(run.error || 'rule run failed');
  return run;
}
