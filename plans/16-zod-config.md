# Plan: Zod Config Schema (precursor to rules engine)

## Context

`src/config.js` validates the loaded JSON with hand-rolled checks:

- Field presence assertions, type coercions, and `OWNER_REPO_RE.test(...)` per `poll.repos` entry
- Errors thrown as plain `Error("Invalid poll.repos entry...")` strings
- Defaults applied imperatively in `loadConfig` and `ensureConfig`

This is fine for the current shape but creaks once nested config grows. Plan 18 (rules engine) adds a `rules: [...]` array with its own schema; plan 17 (poller events) doesn't change config but other future automation likely will. zod gives:

- Structured errors with field paths (good for the TUI / UI surfacing)
- Defaults declared next to types
- A reusable schema object for any module that wants to introspect the config shape

zod is already a project dep (used heavily in `src/mcp-server.js`).

This plan is independent of the others and can land standalone.

---

## Scope (in)

- Replace the hand-rolled `validate(cfg)` and most of the imperative defaulting in `loadConfig` with a `configSchema` zod object
- Preserve current behavior: same fields, same defaults, same error-on-invalid semantics for the watchConfig path
- Keep `expandPath` over `PATH_FIELDS` exactly as today (zod parses strings; path expansion runs after)
- Migrate the `OWNER_REPO_RE` check into a zod refinement on `poll.repos`

## Scope (out)

- Rules schema (plan 18 owns its own; lives in `src/rules.js`)
- Adding new config fields
- Changing the live-reload mechanism (`watchFile` stays as-is)
- Migrating other modules to zod beyond this file

---

## Changes

### `src/config.js`

Define a top-level schema:

```js
import { z } from 'zod';

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export const configSchema = z.object({
  port: z.number().int().positive().default(3000),
  db_path: z.string().optional(),
  workspace_base_path: z.string().default('~/.claude-patrol/workspaces'),
  work_dir: z.string().default('~/.claude-patrol/workspaces'),
  global_terminal_cwd: z.string().optional(),
  symlink_memory: z.boolean().default(false),
  poll: z.object({
    interval_seconds: z.number().int().min(5).default(30),
    orgs: z.array(z.string()).default([]),
    repos: z
      .array(z.string().regex(OWNER_REPO_RE, 'must be "owner/repo" format'))
      .default([]),
  }).default({ interval_seconds: 30, orgs: [], repos: [] }),
  repos: z.record(
    z.string(),
    z.object({
      symlinks: z.array(z.object({ source: z.string(), target: z.string() })).optional(),
      initCommands: z.array(z.string()).optional(),
    }),
  ).optional(),
  // pass-through for unknown keys (rules array etc.)
}).passthrough();
```

The `.passthrough()` is important: plan 18 reads `cfg.rules` directly without it being in the schema. Validating rules in this central schema would mean a single bad rule rejects the entire config reload (current `watchConfig` behavior at `config.js:147-157` is `try { loadConfig() } catch { ignore }`). Rules engine validates its own array per-rule. Same applies to any other future passthrough sections.

`loadConfig` becomes:

```js
export function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  const cfg = result.data;
  if (!cfg.db_path) cfg.db_path = defaultDbPath();
  for (const field of PATH_FIELDS) {
    if (cfg[field]) {
      if (field === 'db_path' && !cfg[field].startsWith('~') && !isAbsolute(cfg[field])) {
        cfg[field] = resolve(dataDir(), cfg[field]);
      } else {
        cfg[field] = expandPath(cfg[field]);
      }
    }
  }
  return Object.freeze(cfg);
}
```

`ensureConfig` keeps its current template; it just needs to produce JSON that passes the new schema (it does today).

---

## File Summary

| File | Change |
|---|---|
| `src/config.js` | Replace hand-rolled validate with zod `configSchema`; preserve loadConfig defaults and path expansion |

---

## Verification

1. **Existing-config parity:** for each developer's checked-in `config.json` shape (the example, the user's own, edge cases), `loadConfig()` produces structurally-identical output before and after - same keys, same values, same defaults filled in. Compare via `JSON.stringify` with sorted keys.
2. **Real-config dry run:** before merging, run the new `loadConfig` against the user's actual `~/.claude-patrol/config.json` and `config.example.json` from the repo. Both must parse cleanly. If anything that previously loaded silently now fails (e.g. a tolerated missing field, an extra section that wasn't in the hand-rolled validator), surface it in the PR description so the user can decide to relax the schema or fix the config.
3. **Error message clarity:** invalid configs produce a multi-line error with field paths (`poll.repos.2: must be "owner/repo" format`) instead of a one-line string.
4. **Live-reload behavior:** edit `config.json` to introduce a type error; `[config] Invalid config change ignored` still logs and the previous config stays in effect (no crash).
5. **Defaults parity:** writing a `config.json` with only `poll.orgs` set produces the same expanded config object as `main` (defaults filled identically).
6. **Passthrough:** add `rules: [{ id: "x" }]` to the config; `loadConfig` returns the parsed object with `rules` intact. (Rules engine in plan 18 will validate its own contents.)
7. **Round-trip:** `ensureConfig` template loads cleanly with no warnings.

---

## Out-of-scope reminders

- Don't validate `rules` here. Plan 18 validates per-rule inside `src/rules.js` so a single bad rule doesn't reject the whole config.
- Don't break the existing `Object.freeze` on the returned config - downstream code relies on it being read-only.
- Don't change error semantics for `watchConfig` (still try/catch, still ignores invalid edits).
