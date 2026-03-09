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
 * @returns {Promise<{orgs: string[], poll_interval_seconds: number}>}
 */
export async function fetchConfig() {
  const res = await fetch(`${BASE}/api/config`);
  if (!res.ok) throw new Error(`Failed to fetch config: ${res.status}`);
  return res.json();
}
