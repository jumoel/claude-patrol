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
 * Read a server error without widening every JSON response to `any`.
 * @param {Response} response
 * @returns {Promise<string | null>}
 */
async function readError(response) {
  /** @type {unknown} */
  const body = await response.json().catch(/** @returns {null} */ () => null);
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
    return body.error;
  }
  if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object') {
    const envelope = /** @type {import('../types').ApiErrorEnvelope} */ (body.error);
    throw new ApiError(response.status, envelope);
  }
  return null;
}

/**
 * Fetch PRs with optional filters.
 * @param {Record<string, string>} [filters]
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('../types').PullRequestListResponse>}
 */
export async function fetchPRs(filters = {}, signal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== 'all') {
      params.set(key, value);
    }
  }
  const url = `${BASE}/api/prs${params.toString() ? `?${params}` : ''}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Failed to fetch PRs: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch a single PR by ID.
 * @param {string} id
 * @returns {Promise<import('../types').PullRequest>}
 */
export async function fetchPR(id) {
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch PR: ${res.status}`);
  return readJson(res);
}

/**
 * Force-refresh a single PR from GitHub right now. Returns the updated PR row.
 * @param {string} id
 * @returns {Promise<import('../types').RefreshPullRequestResponse>}
 */
export async function refreshPR(id) {
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to refresh PR: ${res.status}`);
  }
  return readJson(res);
}

/**
 * Trigger an immediate sync.
 * @returns {Promise<{ok: boolean}>}
 */
export async function triggerSync() {
  const res = await fetch(`${BASE}/api/sync/trigger`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sync trigger failed: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch public config.
 * @returns {Promise<import('../types').PublicConfig>}
 */
export async function fetchConfig() {
  const res = await fetch(`${BASE}/api/config`);
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
  return readJson(res);
}

/** Resolve noninteractive review capability for both agent providers. */
export async function fetchProviderCapabilities(force = false) {
  const res = await fetch(`${BASE}/api/capabilities/providers${force ? '?refresh=true' : ''}`);
  if (!res.ok) throw new Error(`Failed to check agent capabilities: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch workspaces, optionally filtered by PR ID.
 * @param {string} [prId]
 * @returns {Promise<import('../types').Workspace[]>}
 */
export async function fetchWorkspaces(prId) {
  const url = prId ? `${BASE}/api/workspaces?pr_id=${encodeURIComponent(prId)}` : `${BASE}/api/workspaces`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
  return readJson(res);
}

/**
 * Create a workspace for a PR.
 * @param {string} prId
 * @returns {Promise<import('../types').Workspace>}
 */
export async function createWorkspace(prId) {
  const res = await fetch(`${BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr_id: prId }),
  });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to create workspace: ${res.status}`);
  }
  return readJson(res);
}

/**
 * Create a scratch workspace (no PR).
 * @param {string} repo - "org/repo" format
 * @param {string} branch - branch name
 * @returns {Promise<import('../types').Workspace>}
 */
export async function createScratchWorkspace(repo, branch) {
  const res = await fetch(`${BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, branch }),
  });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to create scratch workspace: ${res.status}`);
  }
  return readJson(res);
}

/**
 * Fetch a single workspace by ID.
 * @param {string} id
 * @returns {Promise<import('../types').Workspace>}
 */
export async function fetchWorkspace(id) {
  const res = await fetch(`${BASE}/api/workspaces/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch workspace: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch the current explicit peer review lifecycle for a workspace.
 * @param {string} workspaceId
 * @returns {Promise<import('../types').PeerReviewStatusResponse>}
 */
export async function fetchPeerReviewState(workspaceId) {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/peer-review`);
  if (!res.ok) throw new Error((await readError(res)) || `Failed to fetch peer review: ${res.status}`);
  return readJson(res);
}

/**
 * Ask the attached session to run its reserved inverse-provider review tool.
 * @param {string} workspaceId
 * @returns {Promise<{review: import('../types').PeerReview, dispatchedAt: number}>}
 */
export async function requestPeerReview(workspaceId) {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/peer-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error((await readError(res)) || `Failed to request peer review: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch scratch workspaces (no PR).
 * @returns {Promise<import('../types').Workspace[]>}
 */
export async function fetchScratchWorkspaces() {
  const res = await fetch(`${BASE}/api/workspaces?type=scratch`);
  if (!res.ok) throw new Error((await readError(res)) || `Failed to fetch scratch workspaces: ${res.status}`);
  return readJson(res);
}

/**
 * Destroy a workspace.
 * @param {string} workspaceId
 * @returns {Promise<{ok: boolean}>}
 */
export async function destroyWorkspace(workspaceId) {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await readError(res)) || `Failed to destroy workspace: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch sessions for one explicit target.
 * @param {import('../types').SessionTarget} [target]
 * @param {AbortSignal} [signal]
 * @returns {Promise<import('../types').Session[]>}
 */
export async function fetchSessions(target, signal) {
  const url = `${BASE}/api/sessions${target ? `?${sessionTargetQuery(target)}` : ''}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error((await readError(res)) || `Failed to fetch sessions: ${res.status}`);
  return readJson(res);
}

/**
 * Create a session.
 * @param {import('../types').SessionTarget} target
 * @param {import('../types').AgentProvider} provider
 * @param {string} [name]
 * @returns {Promise<import('../types').Session>}
 */
export async function createSession(target, provider, name) {
  const body =
    target.type === 'workspace'
      ? { workspace_id: target.id, provider }
      : target.type === 'work_item'
        ? { work_item_id: target.id, provider }
        : { global: true, provider, ...(name === undefined ? {} : { name }) };
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to create session: ${res.status}`);
  }
  return readJson(res);
}

/**
 * @param {string} sessionId
 * @param {string} name
 * @returns {Promise<import('../types').Session>}
 */
export async function renameSession(sessionId, name) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error((await readError(res)) || `Failed to rename session: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch CI check logs for a PR.
 * @param {string} prId
 * @param {string} [runId] - optional run ID filter
 * @returns {Promise<{logs: import('../types').CheckLog[]}>}
 */
export async function fetchCheckLogs(prId, runId) {
  const params = runId ? `?run_id=${runId}` : '';
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(prId)}/check-logs${params}`);
  if (!res.ok) throw new Error(`Failed to fetch check logs: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch review comments for a PR.
 * @param {string} prId
 * @returns {Promise<import('../types').PullRequestCommentsResponse>}
 */
export async function fetchPRComments(prId) {
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(prId)}/comments`);
  if (!res.ok) throw new Error(`Failed to fetch PR comments: ${res.status}`);
  return readJson(res);
}

/**
 * Kill a session.
 * @param {string} sessionId
 * @returns {Promise<{ok: boolean}>}
 */
export async function killSession(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error((await readError(res)) || `Failed to kill session: ${res.status}`);
  return readJson(res);
}

/**
 * Promote a global session to a scratch workspace.
 * @param {string} sessionId
 * @param {string} repo - "org/repo" format
 * @param {string} branch - branch name
 * @returns {Promise<{workspace: import('../types').Workspace, session: import('../types').Session}>}
 */
export async function promoteSession(sessionId, repo, branch) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, branch }),
  });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to promote session: ${res.status}`);
  }
  return readJson(res);
}

/**
 * @param {string} sessionId
 * @returns {Promise<import('../types').Session>}
 */
export async function reattachSession(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/reattach`, { method: 'POST' });
  if (!res.ok) throw new Error((await readError(res)) || `Failed to reattach session: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch session history (killed sessions) for one explicit target.
 * @param {import('../types').SessionTarget} target
 * @returns {Promise<import('../types').Session[]>}
 */
export async function fetchSessionHistory(target) {
  const url = `${BASE}/api/sessions/history?${sessionTargetQuery(target)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error((await readError(res)) || `Failed to fetch session history: ${res.status}`);
  return readJson(res);
}

/** @param {import('../types').SessionTarget} target */
function sessionTargetQuery(target) {
  const params = new URLSearchParams();
  if (target.type === 'workspace') params.set('workspace_id', target.id);
  else if (target.type === 'work_item') params.set('work_item_id', target.id);
  else params.set('global', 'true');
  return params.toString();
}

/** @param {AbortSignal} [signal] @returns {Promise<import('../types').WorkItemListResponse>} */
export async function fetchWorkItems(signal) {
  const response = await fetch(`${BASE}/api/work-items`, { signal });
  if (!response.ok) throw new Error((await readError(response)) || `Failed to fetch work items: ${response.status}`);
  return readJson(response);
}

/** @param {string} id @param {AbortSignal} [signal] @returns {Promise<{work_item: import('../types').WorkItemDetail}>} */
export async function fetchWorkItem(id, signal) {
  const response = await fetch(`${BASE}/api/work-items/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) {
    throw new Error((await readError(response)) || `Failed to fetch work item: ${response.status}`);
  }
  return readJson(response);
}

/** @param {string} workItemId @param {string} pr */
export async function linkWorkItemPullRequest(workItemId, pr) {
  const response = await fetch(`${BASE}/api/work-items/${encodeURIComponent(workItemId)}/pull-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr }),
  });
  if (!response.ok) {
    throw new Error((await readError(response)) || `Failed to link pull request: ${response.status}`);
  }
  return /** @type {Promise<{pull_request: import('../types').WorkItemPullRequest}>} */ (readJson(response));
}

/** @param {string} workItemId @param {string} pr */
export async function unlinkWorkItemPullRequest(workItemId, pr) {
  const response = await fetch(`${BASE}/api/work-items/${encodeURIComponent(workItemId)}/pull-requests`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr }),
  });
  if (!response.ok) {
    throw new Error((await readError(response)) || `Failed to unlink pull request: ${response.status}`);
  }
  return /** @type {Promise<{removed: boolean, pr_id: string, work_item_id: string}>} */ (readJson(response));
}

/** @param {string} reference @param {import('../types').AgentProvider} workProvider */
export async function createWorkItem(reference, workProvider) {
  const response = await fetch(`${BASE}/api/work-items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference, work_provider: workProvider }),
  });
  if (!response.ok) {
    throw new Error((await readError(response)) || `Failed to create work item: ${response.status}`);
  }
  return /** @type {Promise<{work_item: import('../types').WorkItemListItem}>} */ (readJson(response));
}

/** @param {string} id */
export async function retryWorkItem(id) {
  const response = await fetch(`${BASE}/api/work-items/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error((await readError(response)) || `Failed to retry work item: ${response.status}`);
  }
  return /** @type {Promise<{work_item: import('../types').WorkItemListItem}>} */ (readJson(response));
}

/** @param {string} id */
export async function destroyWorkItem(id) {
  const response = await fetch(`${BASE}/api/work-items/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error((await readError(response)) || `Failed to destroy work item: ${response.status}`);
  }
  return /** @type {Promise<{work_item: import('../types').WorkItemDetail}>} */ (readJson(response));
}

/**
 * Fetch a session's transcript.
 * @param {string} sessionId
 * @returns {Promise<import('../types').TranscriptEntry[]>}
 */
export async function fetchSessionTranscript(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/transcript`);
  if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
  return readJson(res);
}

/**
 * Save config (poll targets).
 * @param {{ poll: { orgs: string[], repos: string[], interval_seconds: number } }} config
 * @returns {Promise<{ok: boolean}>}
 */
export async function saveConfig(config) {
  const res = await fetch(`${BASE}/api/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to save config: ${res.status}`);
  }
  return readJson(res);
}

/**
 * Fetch all available repos from configured orgs + explicit repos.
 * @returns {Promise<{repos: string[]}>}
 */
export async function fetchAllRepos() {
  const res = await fetch(`${BASE}/api/repos`);
  if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
  return readJson(res);
}

/**
 * Toggle a PR's draft status.
 * @param {string} prId
 * @param {boolean} draft - true to convert to draft, false to mark ready
 * @returns {Promise<{ok: boolean, draft: boolean}>}
 */
export async function setPRDraft(prId, draft) {
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(prId)}/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ draft }),
  });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to update draft status: ${res.status}`);
  }
  return readJson(res);
}

/**
 * @returns {Promise<{accounts: import('../types').SetupAccount[]}>}
 */
export async function fetchSetupAccounts() {
  const res = await fetch(`${BASE}/api/setup/accounts`);
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to fetch accounts: ${res.status}`);
  }
  return readJson(res);
}

/**
 * Fetch repos for a GitHub account.
 * @param {string} account
 * @returns {Promise<{repos: import('../types').SetupRepo[]}>}
 */
export async function fetchSetupRepos(account) {
  const res = await fetch(`${BASE}/api/setup/repos?account=${encodeURIComponent(account)}`);
  if (!res.ok) {
    throw new Error((await readError(res)) || `Failed to fetch repos: ${res.status}`);
  }
  return readJson(res);
}

/**
 * Trigger git pull to update claude-patrol.
 * @returns {Promise<{ok: boolean, output?: string}>}
 */
export async function triggerUpdate() {
  const res = await fetch(`${BASE}/api/update`, { method: 'POST' });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Update failed: ${res.status}`);
  }
  return readJson(res);
}

/**
 * Restart the server to apply a pulled update.
 * The server spawns a new process with --reattach (preserving terminal sessions)
 * then exits. The frontend should poll until the new instance is up.
 * @returns {Promise<{ok: boolean}>}
 */
export async function triggerRestart() {
  const res = await fetch(`${BASE}/api/restart`, { method: 'POST' });
  if (!res.ok) {
    throw new Error((await readError(res)) || `Restart failed: ${res.status}`);
  }
  return readJson(res);
}

/** @returns {Promise<import('../types').RestartStatus>} */
export async function fetchRestartStatus() {
  const res = await fetch(`${BASE}/api/restart/status`);
  if (!res.ok) throw new Error(`Failed to fetch restart status: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch the current task list (running + recently completed background ops).
 * @returns {Promise<import('../types').Task[]>}
 */
export async function fetchTasks() {
  const res = await fetch(`${BASE}/api/tasks`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch loaded rules + per-rule load errors.
 * @returns {Promise<{rules: import('../types').RuleDefinition[], errors: import('../types').RuleLoadError[]}>}
 */
export async function fetchRules() {
  const res = await fetch(`${BASE}/api/rules`);
  if (!res.ok) throw new Error(`Failed to fetch rules: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch recent rule_runs rows.
 * @param {{limit?: number, rule_id?: string, pr_id?: string}} [filters]
 * @returns {Promise<import('../types').RuleRun[]>}
 */
export async function fetchRuleRuns(filters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  const res = await fetch(`${BASE}/api/rules/runs${qs ? `?${qs}` : ''}`);
  if (!res.ok) throw new Error(`Failed to fetch rule runs: ${res.status}`);
  return readJson(res);
}

/**
 * Fetch rule subscriptions for a PR.
 * @param {string} prId
 * @returns {Promise<import('../types').RuleSubscription[]>}
 */
export async function fetchPRRuleSubscriptions(prId) {
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(prId)}/rule-subscriptions`);
  if (!res.ok) throw new Error(`Failed to fetch subscriptions: ${res.status}`);
  return readJson(res);
}

/**
 * Subscribe a PR to a rule (only valid for `requires_subscription: true` rules).
 * @param {string} ruleId
 * @param {string} prId
 * @returns {Promise<{rule_id: string, pr_id: string, created: boolean}>}
 */
export async function subscribeRuleForPR(ruleId, prId) {
  const res = await fetch(`${BASE}/api/rules/${encodeURIComponent(ruleId)}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pr_id: prId }),
  });
  if (!res.ok) throw new Error((await readError(res)) || `Failed: ${res.status}`);
  return readJson(res);
}

/**
 * Unsubscribe a PR from a rule.
 * @param {string} ruleId
 * @param {string} prId
 * @returns {Promise<{rule_id: string, pr_id: string}>}
 */
export async function unsubscribeRuleForPR(ruleId, prId) {
  const res = await fetch(`${BASE}/api/rules/${encodeURIComponent(ruleId)}/subscribe`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pr_id: prId }),
  });
  if (!res.ok) throw new Error((await readError(res)) || `Failed: ${res.status}`);
  return readJson(res);
}

/**
 * Fire a rule manually against a PR or session.
 * @param {string} ruleId
 * @param {{pr_id?: string, session_id?: string, force?: boolean}} [options]
 * @returns {Promise<import('../types').RuleRun>}
 */
export async function runRuleManually(ruleId, { pr_id, session_id, force } = {}) {
  const url = new URL(`${BASE}/api/rules/${encodeURIComponent(ruleId)}/run`, window.location.origin);
  if (force) url.searchParams.set('force', 'true');
  const res = await fetch(url.pathname + url.search, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pr_id, session_id }),
  });
  if (!res.ok) throw new Error((await readError(res)) || `Failed: ${res.status}`);
  const run = await readJson(res);
  // The route returns 200 with the run row even when the action chain errored
  // (e.g. session_busy). Surface that so the UI doesn't swallow the failure.
  if (run.status === 'error') throw new Error(run.error || 'rule run failed');
  return run;
}

/**
 * Fire a rule against every PR matching its `where` clause. Returns a list
 * of fired PRs and skipped PRs (with reasons). Fires happen async server-side.
 * @param {string} ruleId
 * @param {{subscribe?: boolean, force?: boolean}} [options]
 * @returns {Promise<import('../types').BulkRuleRunResponse>}
 */
export async function runRuleForAll(ruleId, { subscribe, force } = {}) {
  const res = await fetch(`${BASE}/api/rules/${encodeURIComponent(ruleId)}/run-all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscribe: !!subscribe, force: !!force }),
  });
  if (!res.ok) throw new Error((await readError(res)) || `Failed: ${res.status}`);
  return readJson(res);
}

/**
 * Subscribe every PR matching a rule's `where` clause. Only valid for rules
 * with `requires_subscription: true`. Returns subscribed/already/skipped lists.
 * @param {string} ruleId
 * @returns {Promise<import('../types').BulkRuleSubscriptionResponse>}
 */
export async function subscribeRuleForAll(ruleId) {
  const res = await fetch(`${BASE}/api/rules/${encodeURIComponent(ruleId)}/subscribe-all`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error((await readError(res)) || `Failed: ${res.status}`);
  return readJson(res);
}
