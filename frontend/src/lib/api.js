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
  const url = `${BASE}/api/prs${params.toString() ? '?' + params : ''}`;
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
