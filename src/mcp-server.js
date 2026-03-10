import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = `http://127.0.0.1:${process.env.PATROL_PORT || 4000}`;

/**
 * Fetch a Patrol API endpoint and return the parsed JSON.
 * @param {string} path
 * @param {object} [options]
 * @returns {Promise<unknown>}
 */
async function api(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Patrol API ${res.status}: ${body}`);
  }
  return res.json();
}

const server = new McpServer({
  name: 'patrol',
  version: '1.0.0',
});

server.tool(
  'list_prs',
  'List all tracked pull requests. Optional filters: org, repo, draft, ci status, review status, merge status.',
  {
    org: z.string().optional().describe('Filter by GitHub org'),
    repo: z.string().optional().describe('Filter by repo name'),
    draft: z.boolean().optional().describe('Filter by draft status'),
    ci: z.enum(['pass', 'fail', 'pending']).optional().describe('Filter by CI status'),
    review: z.enum(['approved', 'changes_requested', 'pending']).optional().describe('Filter by review status'),
    mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional().describe('Filter by merge status'),
  },
  async ({ org, repo, draft, ci, review, mergeable }) => {
    const params = new URLSearchParams();
    if (org) params.set('org', org);
    if (repo) params.set('repo', repo);
    if (draft !== undefined) params.set('draft', String(draft));
    if (ci) params.set('ci', ci);
    if (review) params.set('review', review);
    if (mergeable) params.set('mergeable', mergeable);
    const qs = params.toString();
    const data = await api(`/api/prs${qs ? `?${qs}` : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'get_pr',
  'Get details for a single PR by its database ID.',
  {
    id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
  },
  async ({ id }) => {
    const data = await api(`/api/prs/${encodeURIComponent(id)}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'create_workspace',
  'Create a jj workspace (colocated worktree) for a PR. Returns the workspace path you should cd into.',
  {
    pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
  },
  async ({ pr_id }) => {
    const data = await api('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ pr_id }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'list_workspaces',
  'List workspaces. Defaults to active only. Optionally filter by PR ID, status, or repo.',
  {
    pr_id: z.string().optional().describe('Filter by PR database ID (e.g. "org/repo#42")'),
    status: z.enum(['active', 'destroyed']).optional().describe('Filter by workspace status (defaults to active)'),
    repo: z.string().optional().describe('Filter by repo name'),
  },
  async ({ pr_id, status, repo }) => {
    const params = new URLSearchParams();
    if (pr_id) params.set('pr_id', String(pr_id));
    if (status) params.set('status', status);
    if (repo) params.set('repo', repo);
    const qs = params.toString();
    const data = await api(`/api/workspaces${qs ? `?${qs}` : ''}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'destroy_workspace',
  'Destroy a workspace by its ID.',
  {
    id: z.string().describe('Workspace ID'),
  },
  async ({ id }) => {
    const data = await api(`/api/workspaces/${id}`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'cleanup_workspaces',
  'Destroy active workspaces whose PRs match the given conditions. For example: ci="pass" and mergeable="MERGEABLE" destroys workspaces for PRs that are passing CI and have no conflicts.',
  {
    ci: z.enum(['pass', 'fail', 'pending']).optional().describe('Only destroy workspaces where PR CI status matches'),
    review: z.enum(['approved', 'changes_requested', 'pending']).optional().describe('Only destroy workspaces where PR review status matches'),
    mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional().describe('Only destroy workspaces where PR merge status matches'),
    repo: z.string().optional().describe('Only destroy workspaces for this repo'),
  },
  async ({ ci, review, mergeable, repo }) => {
    const body = {};
    if (ci) body.ci = ci;
    if (review) body.review = review;
    if (mergeable) body.mergeable = mergeable;
    if (repo) body.repo = repo;
    const data = await api('/api/workspaces/cleanup', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'trigger_sync',
  'Trigger an immediate sync of PR data from GitHub.',
  {},
  async () => {
    const data = await api('/api/sync/trigger', { method: 'POST' });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'retrigger_checks',
  'Re-run failed CI checks for a PR.',
  {
    pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
  },
  async ({ pr_id }) => {
    const data = await api('/api/checks/retrigger', {
      method: 'POST',
      body: JSON.stringify({ pr_id }),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'get_check_logs',
  'Get the actual output of failed CI checks for a PR. Extracts only the relevant error sections, not the full job log. Optionally filter by run_id.',
  {
    id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    run_id: z.string().optional().describe('Optional: filter to a specific GitHub Actions run ID'),
  },
  async ({ id, run_id }) => {
    const params = run_id ? `?run_id=${run_id}` : '';
    const data = await api(`/api/prs/${encodeURIComponent(id)}/check-logs${params}`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'get_pr_comments',
  'Get review comments and conversation for a PR. Includes inline code review comments with file paths and diff positions, review summaries with state, and general PR conversation.',
  {
    id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
  },
  async ({ id }) => {
    const data = await api(`/api/prs/${encodeURIComponent(id)}/comments`);
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
