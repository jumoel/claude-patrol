# Plan: Actions Registry (precursor to rules engine)

## Context

`src/mcp-server.js` registers 14+ tools as hand-written wrappers. Each tool defines name, description, zod schema, and an inline argument-to-injection translator (URLSearchParams construction for GETs, JSON body shaping for POSTs, path-param interpolation, etc.). The MCP server itself is a thin Fastify-in-process dispatcher (`app.inject()` - no subprocess, no HTTP loopback).

Plan 18 (rules engine) needs the same dispatch logic addressable by tool name. To avoid duplicating each tool's translator, extract them into a shared registry now as a behavior-preserving refactor.

This plan is independent of the others and can land standalone.

---

## Scope (in)

- New `src/actions.js` with an `actionRegistry` keyed by tool name
- Each entry: `{ description, schema, ruleFireable, dispatch, transform? }`
- `dispatch(args)` returns `{ method, path, body? }` for `app.inject()`
- Optional `transform(result)` lets a tool reshape its response (used by `list_prs` to apply `summarizePR`)
- Helper `invokeAction(app, tool, args)` that validates with zod, runs `dispatch`, calls `app.inject`, throws on non-2xx, returns parsed JSON (no transform - rules consumers want raw data)
- `src/mcp-server.js` becomes a loop that registers each registry entry as an MCP tool, applying `transform` when present
- `ruleFireable: false` flag on read-only tools
- `wait_for_checks` is **not** in the registry - it's a multi-call polling loop, not a single dispatch. Stays as a one-off `server.tool()` call in `src/mcp-server.js`. Not addressable from rules at all.

## Scope (out)

- The rules engine itself (plan 18)
- Any behavioral change to existing tools - this is a no-op refactor
- Adding new tools

---

## Changes

### `src/actions.js` (new)

```js
import { z } from 'zod';

/**
 * Per-tool dispatch metadata. The MCP server reads `description` and `schema`
 * to register tools; the rules engine reads `ruleFireable` and uses the same
 * `dispatch` to translate args into Fastify in-process calls.
 *
 * @typedef {object} ActionEntry
 * @property {string} description
 * @property {z.ZodTypeAny} schema
 * @property {boolean} ruleFireable
 * @property {(args: object) => { method: string, path: string, body?: object }} dispatch
 * @property {(result: object) => object} [transform] - optional response reshape for MCP consumers
 */

/** @type {Record<string, ActionEntry>} */
export const actionRegistry = {
  list_prs: {
    description: 'List all tracked pull requests. Optional filters: org, repo, draft, ci status, review status, merge status.',
    schema: z.object({
      org: z.string().optional(),
      repo: z.string().optional(),
      draft: z.boolean().optional(),
      ci: z.enum(['pass', 'fail', 'pending']).optional(),
      review: z.enum(['approved', 'changes_requested', 'pending']).optional(),
      mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).optional(),
    }),
    ruleFireable: false, // read-only
    dispatch: (args) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined) params.set(k, String(v));
      const qs = params.toString();
      return { method: 'GET', path: `/api/prs${qs ? `?${qs}` : ''}` };
    },
    transform: (result) => ({ ...result, prs: result.prs?.map(summarizePR) ?? [] }),
  },
  // ... one entry per existing MCP tool
};

export async function invokeAction(app, tool, args) {
  const entry = actionRegistry[tool];
  if (!entry) throw new Error(`Unknown action: ${tool}`);
  const validated = entry.schema.parse(args);
  const { method, path, body } = entry.dispatch(validated);
  const res = await app.inject({
    method,
    url: path,
    payload: body,
    headers: body ? { 'content-type': 'application/json' } : {},
  });
  if (res.statusCode >= 400) {
    throw new Error(`${tool} failed (${res.statusCode}): ${res.body}`);
  }
  return res.json();
}
```

`ruleFireable: false` for: `list_prs`, `get_pr`, `get_pr_diff`, `get_pr_comments`, `get_check_logs`, `list_workspaces`. Everything else in the registry: `true`. (`wait_for_checks` is not in the registry, so it has no flag.)

### `src/mcp-server.js` (refactor)

`createMcpServer(app)` becomes:

```js
export function createMcpServer(app) {
  const server = new McpServer({ name: 'patrol', version: '1.0.0' });
  for (const [tool, entry] of Object.entries(actionRegistry)) {
    server.tool(tool, entry.description, entry.schema.shape, async (args) => {
      const raw = await invokeAction(app, tool, args);
      const result = entry.transform ? entry.transform(raw) : raw;
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
  }
  // wait_for_checks: not a single dispatch, stays as a hand-written tool.
  registerWaitForChecks(server, app);
  return server;
}
```

`NON_FINAL_STATUSES` stays in `mcp-server.js` (used by the wait_for_checks helper). `summarizePR` moves to `src/actions.js` next to the `list_prs` registry entry that uses it via `transform`.

---

## File Summary

| File | Change |
|---|---|
| `src/actions.js` | New: registry of all MCP tool dispatch entries |
| `src/mcp-server.js` | Refactor to loop over the registry; keep `NON_FINAL_STATUSES` and the `wait_for_checks` polling loop. `summarizePR` moves out (see actions.js row above). |

---

## Verification

1. **Endpoint parity:** for each tool, run a representative invocation against the underlying REST endpoint (e.g. `curl localhost:3000/api/prs?ci=fail`) on `main` and on the refactor branch. Bodies and status codes must match.
2. **MCP parity:** open a Claude session against the patrol MCP server. Run each tool with realistic args. Output must match the pre-refactor output (modulo ordering for queries with no stable sort).
3. **`ruleFireable` flag values:** assert at module load that `list_*` and `get_*` registry entries are `ruleFireable: false`, all other entries are `true`, and `wait_for_checks` is absent from the registry.
4. **No new lints/errors:** `pnpm lint` and `pnpm test` (if present) clean.

---

## Out-of-scope reminders

- Do not add new tools in this PR.
- Do not change any tool's argument schema or response shape.
- Do not introduce the rules engine's `mcp` action type yet - that lands in plan 18.
