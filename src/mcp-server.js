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
  const headers = options.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(`${BASE_URL}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Patrol API ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Strip verbose fields from a PR for compact list responses.
 * Full details are available via get_pr.
 */
function summarizePR(pr) {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    org: pr.org,
    repo: pr.repo,
    author: pr.author,
    branch: pr.branch,
    url: pr.url,
    draft: pr.draft,
    ci_status: pr.ci_status,
    review_status: pr.review_status,
    mergeable: pr.mergeable,
    checks_summary: {
      total: pr.checks?.length ?? 0,
      failed: pr.checks?.filter(c => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion)).length ?? 0,
    },
    labels: (pr.labels || []).map(l => l.name),
    updated_at: pr.updated_at,
  };
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
    const compact = { ...data, prs: data.prs.map(summarizePR) };
    return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
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
  'create_scratch_workspace',
  'Create a scratch workspace to start new work without an existing PR. Specify a repo and branch name. Returns the workspace path you should cd into.',
  {
    repo: z.string().describe('Repository in "org/repo" format (e.g. "myorg/myrepo")'),
    branch: z.string().describe('Branch name for the new work (e.g. "feat/dark-mode")'),
  },
  async ({ repo, branch }) => {
    const data = await api('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ repo, branch }),
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
  'Re-run failed CI checks for a PR. Optionally filter to specific checks by name pattern. Use require_all_final=true to only retrigger when no checks are still running or queued.',
  {
    pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    check_name: z.string().optional().describe('Only retrigger checks whose name contains this substring (case-insensitive). E.g. "smith-bench" to only retrigger smith-bench failures.'),
    require_all_final: z.boolean().optional().describe('If true, refuse to retrigger unless all checks are in a final state (no running/queued checks). Prevents retriggering while CI is still in progress.'),
  },
  async ({ pr_id, check_name, require_all_final }) => {
    // When require_all_final is set, check that no checks are still in progress
    if (require_all_final) {
      const pr = await api(`/api/prs/${encodeURIComponent(pr_id)}`);
      const nonFinalStatuses = new Set(['IN_PROGRESS', 'QUEUED', 'WAITING', 'PENDING', 'REQUESTED']);
      const stillRunning = (pr.checks || []).filter(c =>
        c.status && nonFinalStatuses.has(c.status) && !c.conclusion
      );
      if (stillRunning.length > 0) {
        const names = stillRunning.map(c => c.name).join(', ');
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: false,
              error: 'checks_still_running',
              message: `${stillRunning.length} check(s) are not yet in a final state: ${names}`,
              still_running: stillRunning.map(c => ({ name: c.name, status: c.status })),
            }, null, 2),
          }],
        };
      }
    }

    const body = { pr_id };
    if (check_name) body.check_name = check_name;
    const data = await api('/api/checks/retrigger', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  },
);

server.tool(
  'get_pr_diff',
  'Get the diff for a PR. Use name_only=true for a quick file list (triage), omit for the full diff. Works without creating a workspace.',
  {
    id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    name_only: z.boolean().optional().describe('If true, return only changed file names instead of the full diff'),
  },
  async ({ id, name_only }) => {
    const params = name_only ? '?name_only=true' : '';
    const data = await api(`/api/prs/${encodeURIComponent(id)}/diff${params}`);
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

const NON_FINAL_STATUSES = new Set(['IN_PROGRESS', 'QUEUED', 'WAITING', 'PENDING', 'REQUESTED']);

server.tool(
  'wait_for_checks',
  'Wait until all CI checks on a PR reach a final state (no more running/queued checks). Polls the PR data at a configurable interval. Returns the final check summary. Useful before retriggering specific checks.',
  {
    pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    poll_seconds: z.number().optional().describe('Seconds between polls (default: 30, min: 10, max: 300)'),
    timeout_minutes: z.number().optional().describe('Give up after this many minutes (default: 30, max: 120)'),
  },
  async ({ pr_id, poll_seconds, timeout_minutes }) => {
    const interval = Math.max(10, Math.min(300, poll_seconds || 30)) * 1000;
    const timeout = Math.max(1, Math.min(120, timeout_minutes || 30)) * 60 * 1000;
    const deadline = Date.now() + timeout;

    // Trigger a sync first so we have fresh data
    await api('/api/sync/trigger', { method: 'POST' }).catch(() => {});

    while (Date.now() < deadline) {
      const pr = await api(`/api/prs/${encodeURIComponent(pr_id)}`);
      const checks = pr.checks || [];
      const stillRunning = checks.filter(c =>
        c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion
      );

      if (stillRunning.length === 0) {
        const failed = checks.filter(c =>
          ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion)
        );
        const passed = checks.filter(c =>
          ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion)
        );
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              all_final: true,
              ci_status: pr.ci_status,
              total: checks.length,
              passed: passed.length,
              failed: failed.length,
              failed_checks: failed.map(c => c.name),
            }, null, 2),
          }],
        };
      }

      // Wait before next poll, but trigger a sync first
      await new Promise(r => setTimeout(r, interval));
      await api('/api/sync/trigger', { method: 'POST' }).catch(() => {});
    }

    // Timed out
    const pr = await api(`/api/prs/${encodeURIComponent(pr_id)}`);
    const checks = pr.checks || [];
    const stillRunning = checks.filter(c =>
      c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: false,
          error: 'timeout',
          message: `Timed out after ${timeout_minutes || 30} minutes. ${stillRunning.length} check(s) still running.`,
          still_running: stillRunning.map(c => ({ name: c.name, status: c.status })),
        }, null, 2),
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
