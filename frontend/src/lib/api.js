const BASE = '';

/**
 * Fetch PRs with optional filters.
 * @param {Record<string, string>} [filters]
 * @returns {Promise<{prs: object[], synced_at: string | null}>}
 */
export async function fetchPRs(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== 'all') {
      params.set(key, value);
    }
  }
  const url = `${BASE}/api/prs${params.toString() ? `?${params}` : ''}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch PRs: ${res.status}`);
  return res.json();
}

/**
 * Fetch a single PR by ID.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function fetchPR(id) {
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch PR: ${res.status}`);
  return res.json();
}

/**
 * Trigger an immediate sync.
 * @returns {Promise<{ok: boolean}>}
 */
export async function triggerSync() {
  const res = await fetch(`${BASE}/api/sync/trigger`, { method: 'POST' });
  if (!res.ok) throw new Error(`Sync trigger failed: ${res.status}`);
  return res.json();
}

/**
 * Fetch public config.
 * @returns {Promise<{poll: {orgs: string[], repos: string[], interval_seconds: number}}>}
 */
export async function fetchConfig() {
  const res = await fetch(`${BASE}/api/config`);
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
  return res.json();
}

/**
 * Fetch workspaces, optionally filtered by PR ID.
 * @param {string} [prId]
 * @returns {Promise<object[]>}
 */
export async function fetchWorkspaces(prId) {
  const url = prId ? `${BASE}/api/workspaces?pr_id=${encodeURIComponent(prId)}` : `${BASE}/api/workspaces`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch workspaces: ${res.status}`);
  return res.json();
}

/**
 * Create a workspace for a PR.
 * @param {string} prId
 * @returns {Promise<object>}
 */
export async function createWorkspace(prId) {
  const res = await fetch(`${BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pr_id: prId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create workspace: ${res.status}`);
  }
  return res.json();
}

/**
 * Create a scratch workspace (no PR).
 * @param {string} repo - "org/repo" format
 * @param {string} branch - branch name
 * @returns {Promise<object>}
 */
export async function createScratchWorkspace(repo, branch) {
  const res = await fetch(`${BASE}/api/workspaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, branch }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create scratch workspace: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch a single workspace by ID.
 * @param {string} id
 * @returns {Promise<object>}
 */
export async function fetchWorkspace(id) {
  const res = await fetch(`${BASE}/api/workspaces/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch workspace: ${res.status}`);
  return res.json();
}

/**
 * Fetch scratch workspaces (no PR).
 * @returns {Promise<object[]>}
 */
export async function fetchScratchWorkspaces() {
  const res = await fetch(`${BASE}/api/workspaces?type=scratch`);
  if (!res.ok) throw new Error(`Failed to fetch scratch workspaces: ${res.status}`);
  return res.json();
}

/**
 * Destroy a workspace.
 * @param {string} workspaceId
 * @returns {Promise<{ok: boolean}>}
 */
export async function destroyWorkspace(workspaceId) {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to destroy workspace: ${res.status}`);
  return res.json();
}

/**
 * Fetch sessions, optionally filtered by workspace ID.
 * @param {string} [workspaceId]
 * @returns {Promise<object[]>}
 */
export async function fetchSessions(workspaceId) {
  const url = workspaceId ? `${BASE}/api/sessions?workspace_id=${workspaceId}` : `${BASE}/api/sessions`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return res.json();
}

/**
 * Create a session.
 * @param {string | null} workspaceId
 * @returns {Promise<object>}
 */
export async function createSession(workspaceId) {
  const body = workspaceId ? { workspace_id: workspaceId } : { global: true };
  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create session: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch CI check logs for a PR.
 * @param {string} prId
 * @param {string} [runId] - optional run ID filter
 * @returns {Promise<{logs: object[]}>}
 */
export async function fetchCheckLogs(prId, runId) {
  const params = runId ? `?run_id=${runId}` : '';
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(prId)}/check-logs${params}`);
  if (!res.ok) throw new Error(`Failed to fetch check logs: ${res.status}`);
  return res.json();
}

/**
 * Fetch review comments for a PR.
 * @param {string} prId
 * @returns {Promise<{reviews: object[], conversation: object[]}>}
 */
export async function fetchPRComments(prId) {
  const res = await fetch(`${BASE}/api/prs/${encodeURIComponent(prId)}/comments`);
  if (!res.ok) throw new Error(`Failed to fetch PR comments: ${res.status}`);
  return res.json();
}

/**
 * Kill a session.
 * @param {string} sessionId
 * @returns {Promise<{ok: boolean}>}
 */
export async function killSession(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Failed to kill session: ${res.status}`);
  return res.json();
}

/**
 * Promote a global session to a scratch workspace.
 * @param {string} sessionId
 * @param {string} repo - "org/repo" format
 * @param {string} branch - branch name
 * @returns {Promise<{workspace: object, session: object}>}
 */
export async function promoteSession(sessionId, repo, branch) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, branch }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to promote session: ${res.status}`);
  }
  return res.json();
}

export async function reattachSession(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/reattach`, { method: 'POST' });
  if (!res.ok) throw new Error(`Failed to reattach session: ${res.status}`);
  return res.json();
}

/**
 * Fetch session history (killed sessions).
 * @param {string} [workspaceId]
 * @returns {Promise<object[]>}
 */
export async function fetchSessionHistory(workspaceId) {
  const url = workspaceId ? `${BASE}/api/sessions/history?workspace_id=${workspaceId}` : `${BASE}/api/sessions/history`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch session history: ${res.status}`);
  return res.json();
}

/**
 * Fetch a session's transcript.
 * @param {string} sessionId
 * @returns {Promise<object[]>}
 */
export async function fetchSessionTranscript(sessionId) {
  const res = await fetch(`${BASE}/api/sessions/${sessionId}/transcript`);
  if (!res.ok) throw new Error(`Failed to fetch transcript: ${res.status}`);
  return res.json();
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
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to save config: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch GitHub accounts (personal + orgs) for setup.
 * @returns {Promise<{accounts: Array<{login: string, type: string, avatar_url: string}>}>}
 */
/**
 * Fetch all available repos from configured orgs + explicit repos.
 * @returns {Promise<{repos: string[]}>}
 */
export async function fetchAllRepos() {
  const res = await fetch(`${BASE}/api/repos`);
  if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
  return res.json();
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
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to update draft status: ${res.status}`);
  }
  return res.json();
}

export async function fetchSetupAccounts() {
  const res = await fetch(`${BASE}/api/setup/accounts`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch accounts: ${res.status}`);
  }
  return res.json();
}

/**
 * Fetch repos for a GitHub account.
 * @param {string} account
 * @returns {Promise<{repos: Array<{name: string, nameWithOwner: string, description: string}>}>}
 */
export async function fetchSetupRepos(account) {
  const res = await fetch(`${BASE}/api/setup/repos?account=${encodeURIComponent(account)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to fetch repos: ${res.status}`);
  }
  return res.json();
}

/**
 * Trigger git pull to update claude-patrol.
 * @returns {Promise<{ok: boolean, output?: string}>}
 */
export async function triggerUpdate() {
  const res = await fetch(`${BASE}/api/update`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Update failed: ${res.status}`);
  }
  return res.json();
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
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Restart failed: ${res.status}`);
  }
  return res.json();
}
