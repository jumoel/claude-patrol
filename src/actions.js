import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Strip verbose fields from a PR for compact list responses.
 * Full details are available via get_pr.
 */
export function summarizePR(pr) {
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
      failed: pr.checks?.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion)).length ?? 0,
    },
    labels: (pr.labels || []).map((l) => l.name),
    updated_at: pr.updated_at,
  };
}

const NON_FINAL_STATUSES = new Set(['IN_PROGRESS', 'QUEUED', 'WAITING', 'PENDING', 'REQUESTED']);

/**
 * Inject a Fastify route call and return parsed JSON. Throws on non-2xx.
 * @param {import('fastify').FastifyInstance} app
 * @param {{method: string, path: string, body?: object}} req
 */
async function inject(app, { method, path, body }) {
  const res = await app.inject({
    method,
    url: path,
    payload: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
  });
  if (res.statusCode >= 400) {
    throw new Error(`Patrol API ${res.statusCode}: ${res.body}`);
  }
  return res.json();
}

function buildQuery(args) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Per-tool metadata. Two ways to handle a call:
 *  1. `dispatch(args) -> { method, path, body? }` - the simple, rules-callable case.
 *     The MCP server applies optional `transform(result)` after the call. Rules
 *     engine bypasses transform; it wants raw data.
 *  2. `mcpHandler(app, args) -> McpToolResult` - for tools that need pre-call
 *     validation, multi-call composition, or filesystem access. Always run
 *     in MCP context; rules cannot fire these (set `ruleFireable: false`).
 *
 * A tool with `dispatch + mcpHandler` (e.g. retrigger_checks) gets the simple
 * dispatch in rules context and the rich behavior in MCP context.
 *
 * @typedef {object} ActionEntry
 * @property {string} description
 * @property {z.ZodObject<any>} schema
 * @property {boolean} ruleFireable
 * @property {(args: object) => { method: string, path: string, body?: object }} [dispatch]
 * @property {(result: any) => any} [transform]
 * @property {(app: import('fastify').FastifyInstance, args: object) => Promise<any>} [mcpHandler]
 */

/** @type {Record<string, ActionEntry>} */
export const actionRegistry = {
  list_prs: {
    description:
      'List all tracked pull requests. Optional filters: org, repo, draft, ci status, review status, merge status.',
    schema: z.object({
      org: z.string().optional().describe('Filter by GitHub org'),
      repo: z.string().optional().describe('Filter by repo name'),
      draft: z.boolean().optional().describe('Filter by draft status'),
      ci: z.enum(['pass', 'fail', 'pending']).optional().describe('Filter by CI status'),
      review: z.enum(['approved', 'changes_requested', 'pending']).optional().describe('Filter by review status'),
      mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional().describe('Filter by merge status'),
    }),
    ruleFireable: false,
    dispatch: (args) => ({ method: 'GET', path: `/api/prs${buildQuery(args)}` }),
    transform: (result) => ({ ...result, prs: (result.prs ?? []).map(summarizePR) }),
  },

  get_pr: {
    description: 'Get details for a single PR by its database ID.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    }),
    ruleFireable: false,
    dispatch: ({ id }) => ({ method: 'GET', path: `/api/prs/${encodeURIComponent(id)}` }),
  },

  create_workspace: {
    description: 'Create a jj workspace (colocated worktree) for a PR. Returns the workspace path you should cd into.',
    schema: z.object({
      pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    }),
    ruleFireable: true,
    dispatch: ({ pr_id }) => ({ method: 'POST', path: '/api/workspaces', body: { pr_id } }),
  },

  create_scratch_workspace: {
    description:
      'Create a scratch workspace to start new work without an existing PR. Specify a repo and branch name. Returns the workspace path you should cd into.',
    schema: z.object({
      repo: z.string().describe('Repository in "org/repo" format (e.g. "myorg/myrepo")'),
      branch: z.string().describe('Branch name for the new work (e.g. "feat/dark-mode")'),
    }),
    ruleFireable: true,
    dispatch: ({ repo, branch }) => ({ method: 'POST', path: '/api/workspaces', body: { repo, branch } }),
  },

  list_workspaces: {
    description: 'List workspaces. Defaults to active only. Optionally filter by PR ID, status, or repo.',
    schema: z.object({
      pr_id: z.string().optional().describe('Filter by PR database ID (e.g. "org/repo#42")'),
      status: z.enum(['active', 'destroyed']).optional().describe('Filter by workspace status (defaults to active)'),
      repo: z.string().optional().describe('Filter by repo name'),
    }),
    ruleFireable: false,
    dispatch: (args) => ({ method: 'GET', path: `/api/workspaces${buildQuery(args)}` }),
  },

  destroy_workspace: {
    description: 'Destroy a workspace by its ID.',
    schema: z.object({
      id: z.string().describe('Workspace ID'),
    }),
    ruleFireable: true,
    dispatch: ({ id }) => ({ method: 'DELETE', path: `/api/workspaces/${id}` }),
  },

  cleanup_workspaces: {
    description:
      'Destroy active workspaces whose PRs match the given conditions. For example: ci="pass" and mergeable="MERGEABLE" destroys workspaces for PRs that are passing CI and have no conflicts.',
    schema: z.object({
      ci: z.enum(['pass', 'fail', 'pending']).optional().describe('Only destroy workspaces where PR CI status matches'),
      review: z
        .enum(['approved', 'changes_requested', 'pending'])
        .optional()
        .describe('Only destroy workspaces where PR review status matches'),
      mergeable: z
        .enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN'])
        .optional()
        .describe('Only destroy workspaces where PR merge status matches'),
      repo: z.string().optional().describe('Only destroy workspaces for this repo'),
    }),
    ruleFireable: true,
    dispatch: (args) => {
      const body = {};
      for (const [k, v] of Object.entries(args)) if (v !== undefined) body[k] = v;
      return { method: 'POST', path: '/api/workspaces/cleanup', body };
    },
  },

  trigger_sync: {
    description: 'Trigger an immediate sync of PR data from GitHub.',
    schema: z.object({}),
    ruleFireable: true,
    dispatch: () => ({ method: 'POST', path: '/api/sync/trigger' }),
  },

  run_rule_for_all_matching_prs: {
    description:
      'Fire a rule against every PR matching its `where` clause at once. Returns the list of PRs the rule was fired on (`fired`) and those it was skipped for (`skipped`, with reasons). Fires happen in parallel in the background. Use this for bulk catch-up like "auto-rebase every conflicted PR right now". `subscribe: true` auto-subscribes matching PRs first when the rule has `requires_subscription: true` (one-shot rules will also consume those subscriptions on success). `force: true` bypasses cooldown and subscription gates entirely - use sparingly.',
    schema: z.object({
      rule_id: z.string().describe('Rule id from list_rules'),
      subscribe: z
        .boolean()
        .optional()
        .describe('Auto-subscribe matching PRs before firing (relevant when the rule has requires_subscription)'),
      force: z.boolean().optional().describe('Bypass cooldown and subscription gates'),
    }),
    ruleFireable: false,
    dispatch: ({ rule_id, subscribe, force }) => ({
      method: 'POST',
      path: `/api/rules/${encodeURIComponent(rule_id)}/run-all`,
      body: { subscribe, force },
    }),
  },

  subscribe_rule_for_all_matching_prs: {
    description:
      'Subscribe every PR matching a rule\'s `where` clause to that rule. Only valid for rules with `requires_subscription: true`. Returns `subscribed` (newly opted in), `already_subscribed` (no-op), and `skipped` (with reasons). Does not fire the rule - subscriptions take effect on the next matching trigger event for each PR.',
    schema: z.object({
      rule_id: z.string().describe('Rule id from list_rules; must have requires_subscription: true'),
    }),
    ruleFireable: false,
    dispatch: ({ rule_id }) => ({
      method: 'POST',
      path: `/api/rules/${encodeURIComponent(rule_id)}/subscribe-all`,
    }),
  },

  retrigger_checks: {
    description:
      'Re-run failed CI checks for a PR. Optionally filter to specific checks by name pattern. Use require_all_final=true to only retrigger when no checks are still running or queued. If check_name matches nothing, the response includes available_failed_checks so you can retry with a valid substring.',
    schema: z.object({
      pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      check_name: z
        .string()
        .optional()
        .describe(
          'Only retrigger checks whose name contains this substring (case-insensitive). Matched against both the workflow-prefixed name shown in get_pr/wait_for_checks (e.g. "smith-bench / @adobe/css-tools@4.4.4") and the bare matrix variant name from GitHub\'s REST API (e.g. "@adobe/css-tools@4.4.4"). If nothing matches, the response returns available_failed_checks listing every failed check name so you can pick a working pattern.',
        ),
      require_all_final: z
        .boolean()
        .optional()
        .describe(
          'If true, refuse to retrigger unless all checks are in a final state (no running/queued checks). Prevents retriggering while CI is still in progress.',
        ),
    }),
    ruleFireable: true,
    dispatch: ({ pr_id, check_name }) => {
      const body = { pr_id };
      if (check_name) body.check_name = check_name;
      return { method: 'POST', path: '/api/checks/retrigger', body };
    },
    mcpHandler: async (app, { pr_id, check_name, require_all_final }) => {
      if (require_all_final) {
        const pr = await inject(app, { method: 'GET', path: `/api/prs/${encodeURIComponent(pr_id)}` });
        const stillRunning = (pr.checks || []).filter(
          (c) => c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion,
        );
        if (stillRunning.length > 0) {
          const names = stillRunning.map((c) => c.name).join(', ');
          return {
            ok: false,
            error: 'checks_still_running',
            message: `${stillRunning.length} check(s) are not yet in a final state: ${names}`,
            still_running: stillRunning.map((c) => ({ name: c.name, status: c.status })),
          };
        }
      }
      const body = { pr_id };
      if (check_name) body.check_name = check_name;
      return inject(app, { method: 'POST', path: '/api/checks/retrigger', body });
    },
  },

  get_pr_diff: {
    description:
      'Get the diff for a PR. Use name_only=true for a quick file list (triage), omit for the full diff. Works without creating a workspace.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      name_only: z.boolean().optional().describe('If true, return only changed file names instead of the full diff'),
    }),
    ruleFireable: false,
    dispatch: ({ id, name_only }) => ({
      method: 'GET',
      path: `/api/prs/${encodeURIComponent(id)}/diff${name_only ? '?name_only=true' : ''}`,
    }),
  },

  get_check_logs: {
    description:
      'Get the actual output of failed CI checks for a PR. Extracts only the relevant error sections, not the full job log. Optionally filter by run_id.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      run_id: z.string().optional().describe('Optional: filter to a specific GitHub Actions run ID'),
    }),
    ruleFireable: false,
    dispatch: ({ id, run_id }) => ({
      method: 'GET',
      path: `/api/prs/${encodeURIComponent(id)}/check-logs${run_id ? `?run_id=${encodeURIComponent(run_id)}` : ''}`,
    }),
  },

  get_pr_comments: {
    description:
      'Get review comments and conversation for a PR. Includes inline code review comments with file paths and diff positions, review summaries with state, and general PR conversation.',
    schema: z.object({
      id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
    }),
    ruleFireable: false,
    dispatch: ({ id }) => ({ method: 'GET', path: `/api/prs/${encodeURIComponent(id)}/comments` }),
  },

  get_session_history: {
    description:
      'List previous Claude sessions for a PR or workspace. Returns session IDs, timestamps, and status. Use get_session_transcript to read what happened in a specific session.',
    schema: z.object({
      pr_id: z
        .string()
        .optional()
        .describe('PR database ID (e.g. "org/repo#42"). Finds all workspaces for this PR and returns their sessions.'),
      workspace_id: z.string().optional().describe('Workspace ID to list sessions for directly'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { pr_id, workspace_id }) => {
      if (!pr_id && !workspace_id) {
        return { error: 'Either pr_id or workspace_id is required.' };
      }
      if (pr_id && !workspace_id) {
        const workspaces = await inject(app, {
          method: 'GET',
          path: `/api/workspaces?pr_id=${encodeURIComponent(pr_id)}`,
        });
        const allSessions = [];
        for (const ws of workspaces) {
          const sessions = await inject(app, {
            method: 'GET',
            path: `/api/sessions/history?workspace_id=${encodeURIComponent(ws.id)}`,
          });
          for (const s of sessions) s.workspace_name = ws.name;
          allSessions.push(...sessions);
        }
        allSessions.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
        return allSessions;
      }
      return inject(app, {
        method: 'GET',
        path: `/api/sessions/history?workspace_id=${encodeURIComponent(workspace_id)}`,
      });
    },
  },

  get_session_transcript: {
    description:
      "Get a summary of a previous Claude session. Returns human messages and assistant text responses (no tool use, tool results, or thinking blocks). Also returns the full transcript path if you need raw details. Use get_session_history first to find session IDs.",
    schema: z.object({
      session_id: z.string().describe('Session ID from get_session_history'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { session_id }) => {
      const data = await inject(app, {
        method: 'GET',
        path: `/api/sessions/${encodeURIComponent(session_id)}/transcript?path_only=true&summary=true`,
      });
      let summary;
      try {
        summary = readFileSync(data.summary_path, 'utf8');
      } catch {
        summary = '(Could not read summary file)';
      }
      return { __text: `${summary}\n\n---\nFull transcript (JSONL): ${data.transcript_path}` };
    },
  },

  wait_for_checks: {
    description:
      'Wait until all CI checks on a PR reach a final state (no more running/queued checks). Polls the PR data at a configurable interval. Returns the final check summary. Useful before retriggering specific checks.',
    schema: z.object({
      pr_id: z.string().describe('PR database ID (e.g. "org/repo#42")'),
      poll_seconds: z.number().optional().describe('Seconds between polls (default: 30, min: 10, max: 300)'),
      timeout_minutes: z.number().optional().describe('Give up after this many minutes (default: 30, max: 120)'),
    }),
    ruleFireable: false,
    mcpHandler: async (app, { pr_id, poll_seconds, timeout_minutes }) => {
      const interval = Math.max(10, Math.min(300, poll_seconds || 30)) * 1000;
      const timeout = Math.max(1, Math.min(120, timeout_minutes || 30)) * 60 * 1000;
      const deadline = Date.now() + timeout;

      await inject(app, { method: 'POST', path: '/api/sync/trigger' }).catch(() => {});

      while (Date.now() < deadline) {
        const pr = await inject(app, { method: 'GET', path: `/api/prs/${encodeURIComponent(pr_id)}` });
        const checks = pr.checks || [];
        const stillRunning = checks.filter((c) => c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion);

        if (stillRunning.length === 0) {
          const failed = checks.filter((c) => ['FAILURE', 'ERROR', 'TIMED_OUT'].includes(c.conclusion));
          const passed = checks.filter((c) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion));
          return {
            ok: true,
            all_final: true,
            ci_status: pr.ci_status,
            total: checks.length,
            passed: passed.length,
            failed: failed.length,
            failed_checks: failed.map((c) => c.name),
          };
        }

        await new Promise((r) => setTimeout(r, interval));
        await inject(app, { method: 'POST', path: '/api/sync/trigger' }).catch(() => {});
      }

      const pr = await inject(app, { method: 'GET', path: `/api/prs/${encodeURIComponent(pr_id)}` });
      const checks = pr.checks || [];
      const stillRunning = checks.filter((c) => c.status && NON_FINAL_STATUSES.has(c.status) && !c.conclusion);
      return {
        ok: false,
        error: 'timeout',
        message: `Timed out after ${timeout_minutes || 30} minutes. ${stillRunning.length} check(s) still running.`,
        still_running: stillRunning.map((c) => ({ name: c.name, status: c.status })),
      };
    },
  },
};

/**
 * Validate args, dispatch, and return parsed JSON. For rules-engine consumers.
 * Tools without `dispatch` (mcpHandler-only) cannot be invoked here - those
 * are not rule-callable by design.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {string} tool
 * @param {object} args
 */
export async function invokeAction(app, tool, args) {
  const entry = actionRegistry[tool];
  if (!entry) throw new Error(`Unknown action: ${tool}`);
  if (!entry.dispatch) throw new Error(`Action not invocable from rules: ${tool} (mcp-only)`);
  if (!entry.ruleFireable) throw new Error(`Action not rule-fireable: ${tool}`);
  const validated = entry.schema.parse(args);
  return inject(app, entry.dispatch(validated));
}
