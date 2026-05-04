# Plan: Rule Builder UI

## Context

Rules today are hand-written JSON in `config.json`. Adding one means: open the file in an editor, remember the schema, get the field names right, save, watch the dashboard for a load error, fix, save, repeat. The schema is small but unforgiving - typos in `ci_status` values, mistakes in `where` field names per trigger type, and forgotten templating syntax all surface only after a round trip.

A builder UI removes that loop. Users browse to a "New Rule" button on the dashboard, fill in a form with field-typed inputs (ci_status as a dropdown of `pass|fail|pending`, repo as autocomplete sourced from poll targets, action tool as a dropdown of rule-fireable tools), see live validation against the same zod schema the server uses, and save. The server writes back to `config.json` and the existing live-reload picks it up - same path as a manual edit.

This is a UI feature; the rule semantics and trigger plumbing don't change.

## Prerequisites

- Plans 13, 17, 18 (rules engine + actions registry + per-PR scoping) - all already landed.
- No new backend infrastructure required beyond CRUD endpoints and a small schema-export endpoint.

---

## Scope (v1)

**In:**
- New rule via form (single submission writes to `config.json`)
- Edit existing rule via the same form, pre-filled
- Delete a rule via a confirm prompt
- Live validation through `POST /api/rules/validate` against the server's zod schema (no schema mirroring on the frontend)
- Tool dropdown for `mcp` actions sourced from `/api/rules/tools` (action registry exposed as a JSON-friendly list)
- Multi-action chains (add/remove rows for actions, sequential)
- Both action types: `mcp` and `dispatch_claude`
- Both triggers: `ci.finalized` and `session.idle`
- All existing rule fields: `id`, `on`, `where`, `actions`, `cooldown_minutes`, `manual`, `requires_subscription`, `one_shot`
- Repo autocomplete sourced from `poll.orgs` + `poll.repos` plus the live PR table (any `org/repo` we've seen)

**Out (deferred unless asked):**
- Raw JSON editor mode (form is the primary surface; users with weird needs can still hand-edit `config.json`)
- Validation lint at PR-author level (e.g. "this rule will fire on every PR including drafts - are you sure?")
- Rule duplication / templating (right-click "duplicate" on an existing rule)
- Bulk import/export
- Versioning / undo

---

## Data flow

### Write path

The source of truth stays `config.json`. The server reads, parses, mutates the `rules` array, and writes back. The full algorithm:

```
1. realPath = fs.realpathSync(getConfigPath())
2. stat = fs.statSync(realPath)
3. raw = fs.readFileSync(realPath, 'utf8')
4. cfg = JSON.parse(raw)
5. cfg.rules = mutator(cfg.rules ?? [])           // user input goes in unchanged
6. for r of cfg.rules: ruleSchema.parse(r)        // validate, throw on bad input
7. recheck = fs.statSync(realPath)
8. if recheck.mtimeMs !== stat.mtimeMs: throw 409 // mtime guard
9. tmp = `${realPath}.tmp.${process.pid}`
10. try: fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n')
11. try: fs.renameSync(tmp, realPath)             // atomic on POSIX
12. catch on 10/11: fs.unlinkSync(tmp); rethrow
13. loadRules(cfg.rules)                          // reload immediately, don't wait for watcher
```

Each numbered step exists to defend against a specific failure:

- **Step 1 (realpathSync)**: the user's `~/.config/claude-patrol/config.json` is a symlink into a dotfiles repo. Without resolving, `renameSync(tmp, link)` would atomically replace the symlink with a regular file - the dotfiles repo would no longer see writes. Resolving up front means we read and write the actual target, leaving the symlink intact.
- **Step 6 (re-validate)**: defense against bypassing the API's own validation if a caller hand-crafts the request, and against schema drift across processes (the parse here uses the same `ruleSchema` the engine loads with). We pass the *raw user input* on to step 10, not `result.data` - users should see in `config.json` exactly what they submitted, not the schema's defaults filled in.
- **Step 7-8 (mtime guard)**: if the user (or another tool) edited `config.json` between the read at step 3 and the write at step 11, blow up with a 409. The frontend reloads the form. There is a TOCTOU window between step 8 and step 11 where a concurrent write could slip in; for a single-user local tool that's acceptable, and the next API call surfaces it as a stale-state 409 anyway.
- **Step 9-11 (tmp + rename)**: POSIX `rename(2)` is atomic. Either the old file or the new file is visible to a reader at any moment, never a partial write. The pid suffix on the tmp path avoids collisions if two patrol instances ever run concurrently (they shouldn't, but the cost is one extra string).
- **Step 12 (cleanup on failure)**: a failed write leaves a `.tmp` file behind unless we clean up. Wrap 10-11 in a try/finally and `unlinkSync(tmp)` on error.
- **Step 13 (immediate reload)**: don't rely on the `fs.watchFile` poll interval (1s) to pick up the change. Call `loadRules` directly so the next `GET /api/rules` reflects the write. The watcher will fire later and call `loadRules` again - that's a no-op (rules.clear + repopulate from the same data).

The existing `fs.watchFile` still works as the path for external edits. The API path is just faster.

### Validation flow

The form posts the in-progress rule object to `POST /api/rules/validate`. The server runs `ruleSchema.safeParse(raw)` and returns either `{ ok: true }` or `{ ok: false, errors: [{ path, message }] }`. The form keys errors to fields by `path[0]`/`path[1]` and renders inline.

This avoids mirroring the zod schema in the frontend (which would drift). The form is debounced to one validation call per ~300ms while typing.

### Tool catalog

The `mcp` action's `args` shape depends on which tool is selected. Adding `GET /api/rules/tools` returns:

```json
[
  {
    "tool": "retrigger_checks",
    "description": "Re-run failed CI checks for a PR...",
    "args_schema": {
      "type": "object",
      "properties": {
        "pr_id": { "type": "string", "description": "PR database ID..." },
        "check_name": { "type": "string", "description": "...", "optional": true }
      }
    }
  },
  ...
]
```

The schema field comes from `entry.schema._def.shape()` (zod 4 internal) converted to a small JSON shape - we don't need full JSON Schema, just enough for the form to render labeled inputs. Tools with `ruleFireable: false` are filtered out.

The frontend uses this list to:
- Populate the tool dropdown
- Render args inputs per-tool (text input per arg, with description as placeholder)

---

## Changes

### 1. Server: rule CRUD endpoints

**File:** `src/rules.js`

Add three persistence helpers that share the atomic-write primitive described above:

```js
function writeRulesToConfig(mutator) {
  const path = fs.realpathSync(getConfigPath());
  const stat = fs.statSync(path);
  const raw = fs.readFileSync(path, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config_unparseable: ${err.message}`);
  }
  cfg.rules = mutator(cfg.rules ?? []);
  for (const r of cfg.rules) ruleSchema.parse(r); // server-side guard
  const recheck = fs.statSync(path);
  if (recheck.mtimeMs !== stat.mtimeMs) throw new Error('config_modified_externally');
  const tmp = `${path}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`);
    fs.renameSync(tmp, path);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
  loadRules(cfg.rules);
}

export function createRule(rule) {
  writeRulesToConfig((rs) => {
    if (rs.some((r) => r.id === rule.id)) throw new Error(`rule already exists: ${rule.id}`);
    return [...rs, rule];
  });
}
export function updateRule(id, rule) {
  writeRulesToConfig((rs) => {
    const i = rs.findIndex((r) => r.id === id);
    if (i === -1) throw new Error(`unknown rule: ${id}`);
    return rs.map((r, j) => (j === i ? rule : r));
  });
}
export function deleteRule(id) {
  writeRulesToConfig((rs) => {
    if (!rs.some((r) => r.id === id)) throw new Error(`unknown rule: ${id}`);
    return rs.filter((r) => r.id !== id);
  });
}

export function validateRule(raw) {
  const result = ruleSchema.safeParse(raw);
  if (result.success) return { ok: true };
  return { ok: false, errors: result.error.issues.map((i) => ({ path: i.path, message: i.message })) };
}
```

The `mutator` shape lets each helper be one-line and forces them to live with the locking discipline; if a future helper bypasses `writeRulesToConfig` it'll have to re-derive every safety check, which surfaces the cost.

### 2. Server: routes

**File:** `src/routes/rules.js`

```
POST   /api/rules           - create. body: rule object
PUT    /api/rules/:id       - update. body: rule object
DELETE /api/rules/:id       - delete
POST   /api/rules/validate  - validate without persist. body: rule object
GET    /api/rules/tools     - rule-fireable tool catalog
```

`POST /api/rules/validate` always returns 200 with `{ ok, errors? }` so the form can render errors without needing to handle non-200 paths separately.

`POST /api/rules` and `PUT /api/rules/:id` return 409 when the mtime check fails (`{ error: "config_modified_externally" }`). Frontend handles this with a "config was edited - reload?" prompt.

### 3. Server: tool catalog endpoint

**File:** `src/actions.js`

Add a helper:

```js
export function ruleFireableTools() {
  return Object.entries(actionRegistry)
    .filter(([_, e]) => e.ruleFireable && e.dispatch)
    .map(([tool, e]) => ({
      tool,
      description: e.description,
      args_schema: zodToSimpleShape(e.schema),
    }));
}
```

`zodToSimpleShape` walks `entry.schema._def.shape()` and returns `{ properties: { [name]: { type, description, optional, enum? } } }`. Just enough for the form. About 30 LOC.

### 4. Frontend: form component

**File:** New `frontend/src/components/RuleBuilder/RuleBuilder.jsx` + `.module.css`

Single component, modal-style overlay. Sections:

- **Identity**: `id` (text), `cooldown_minutes` (number, default 10)
- **Scoping**: three checkboxes (`manual`, `requires_subscription`, `one_shot`) with help text describing each. Disabled states honor the schema rules (`one_shot` requires `requires_subscription`, `manual + requires_subscription` errors).
- **Trigger**: `on` (radio: `ci.finalized` or `session.idle`)
- **Where**: dynamic field list keyed off the trigger choice. For ci.finalized: dropdowns for `ci_status` / `mergeable`, multi-select for `labels`, repo autocomplete, draft toggle, etc. For session.idle: only `workspace_repo`.
- **Actions**: list of action rows. Each row has a type selector (`mcp` / `dispatch_claude`). For `mcp`, a tool dropdown sourced from `/api/rules/tools`, then dynamic args inputs. For `dispatch_claude`, a textarea for `prompt` with a small "insert" dropdown for templating tokens (`{{pr.id}}`, `{{pr.title}}`, etc.). "Add action" / "Remove action" buttons.

Bottom bar:
- "Validate" button (debounced auto-validate also runs on field blur)
- "Cancel" / "Save"
- Errors panel showing validation results, keyed to fields when path lines up

### 5. Frontend: API helpers

**File:** `frontend/src/lib/api.js`

```js
export async function createRule(rule) { ... }
export async function updateRule(id, rule) { ... }
export async function deleteRule(id) { ... }
export async function validateRule(rule) { ... }
export async function fetchRuleTools() { ... }
```

Standard fetch wrappers, mirror existing helpers.

### 6. Frontend: dashboard integration

**File:** `frontend/src/components/DashboardSummary/DashboardSummary.jsx` (and possibly a new `RulesPage`)

The Rules dropdown gains a "New rule..." link at the top that opens the builder. Each existing rule entry gets an "Edit" / "Delete" affordance (small icon buttons).

Bad-rule entries show "Edit" (the form pre-fills with the failed JSON, which lets the user fix typos directly) but no "Delete" through the menu - they can still delete by removing from `config.json` manually since the rule isn't loaded; OR the delete handler can grep `config.json` by `id`. v1: only allow delete on loaded rules.

### 7. MCP exposure

**File:** `src/actions.js`

The MCP server already speaks the action registry; expose rule administration as five new tools so Claude can build, edit, and delete rules from inside a session. All five are `ruleFireable: false` - administrative tools should never be invocable by other rules (no meta-rules, no recursion).

| Tool | Maps to | Purpose |
|---|---|---|
| `list_rules` | `GET /api/rules` | Returns loaded rules + load errors so Claude can introspect |
| `list_rule_tools` | `GET /api/rules/tools` | Catalog of which `mcp` actions the user's rules can call |
| `validate_rule` | `POST /api/rules/validate` | Dry-run validation; Claude can fix typos before persisting |
| `create_rule` | `POST /api/rules` | Persist a new rule |
| `update_rule` | `PUT /api/rules/:id` | Replace an existing rule by id |
| `delete_rule` | `DELETE /api/rules/:id` | Remove a rule by id |

Each entry in `actionRegistry` is a thin `dispatch` over the corresponding REST endpoint. The argument schemas accept the rule object verbatim - we don't pre-shape it because the underlying validate/create endpoint will reject malformed input with structured errors that Claude can read and act on.

Schema for the rule-input tools uses `z.object({ rule: z.record(z.string(), z.unknown()) })` (or `id + rule` for update). We don't mirror `ruleSchema` here because the validate/create endpoints already do the authoritative check; mirroring would just create a second source of truth that could drift.

The `delete_rule` tool takes only `{ id }`. Claude will (per Claude Code's normal tool-use approval flow) prompt the user before each call, so destructive admin tools don't need extra in-band confirmation.

System-prompt updates: `src/patrol-system-prompt.md` should mention these tools exist and when to use them ("if the user asks to set up auto-retrigger or any other rule, use `list_rule_tools` first to see what `mcp` actions they can wire up, then `validate_rule`, then `create_rule`"). One paragraph, no behavior change.

### 8. README update

**File:** `README.md`

Mention the builder under the Rules section: "You can also create and edit rules from the dashboard's New rule button - the form is backed by the same zod schema and writes to your `config.json`."

Keep the example JSON in the README since some users prefer config-as-code.

---

## File Summary

| File | Change |
|---|---|
| `src/rules.js` | New `createRule`, `updateRule`, `deleteRule`, `validateRule`, atomic-write helper |
| `src/actions.js` | New `ruleFireableTools()` exporter; new `list_rules`, `list_rule_tools`, `validate_rule`, `create_rule`, `update_rule`, `delete_rule` registry entries |
| `src/routes/rules.js` | New POST/PUT/DELETE/validate/tools routes |
| `src/patrol-system-prompt.md` | One-paragraph mention of the rule-admin tools |
| `frontend/src/lib/api.js` | New API helpers |
| `frontend/src/components/RuleBuilder/RuleBuilder.jsx` | New |
| `frontend/src/components/RuleBuilder/RuleBuilder.module.css` | New |
| `frontend/src/components/DashboardSummary/DashboardSummary.jsx` | "New rule" link + per-rule edit/delete |
| `README.md` | Builder mention |
| `BUILD_LOG.md` | Per-commit entries |

---

## Implementation phases

Four commits, in order:

1. **Server CRUD + validate + tool catalog + atomic-write primitive.** Backend-only, behavior-additive, no frontend dependency. Verifiable via `curl`. Lands the symlink-safe write path, mtime guard, tmp-file cleanup, and immediate `loadRules` after API write.
2. **MCP rule-admin tools + system-prompt update.** Six new registry entries plus a paragraph in `patrol-system-prompt.md`. Verifiable via `tools/list` returning the new names and a `tools/call create_rule` round-trip. Independent of frontend work, useful even without it.
3. **Frontend RuleBuilder component + API helpers.** Standalone component, not yet wired in. Tested via a hidden hash route or by mounting it temporarily.
4. **Dashboard integration.** Wire "New rule", "Edit", "Delete" into `DashboardSummary`. The user-visible feature becomes available here.

---

## Verification

1. **Atomic write parity.** Create a rule via `POST /api/rules`. Read `config.json` after - the rule is in the array, the rest of the config (poll, port, repos, etc.) is byte-identical to before modulo the rules array, formatting is 2-space pretty-printed.
2. **Mtime guard.** Read `config.json` mtime, send `POST /api/rules` after manually `touch`ing the file. Response is 409 `config_modified_externally`.
3. **Validation parity.** Submit a rule with `ci_status: "success"` to `/api/rules/validate`. Response: `{ ok: false, errors: [{ path: ["where", "ci_status"], message: "Invalid input" }] }`. Same shape as the load-time error from `getRuleLoadErrors`.
4. **Tool catalog.** `GET /api/rules/tools` returns the rule-fireable subset (no `list_*`, `get_*`, `wait_for_checks`). Each entry has `tool`, `description`, and an `args_schema.properties` object.
5. **Live-reload after API write.** `POST /api/rules` succeeds. Within ~1.5s (the `fs.watchFile` poll interval), `GET /api/rules` shows the new rule loaded. Server log carries `[rules] Loaded N rule(s)`.
6. **Update flow.** `PUT /api/rules/:id` rewrites the rule. Mtime is updated. `GET /api/rules` shows the change after the watcher fires.
7. **Delete flow.** `DELETE /api/rules/:id` removes the entry. `GET /api/rules` no longer lists it. If the rule had subscriptions, the rows are orphaned (this is fine - they're harmless if the rule reappears later, and harmless if it doesn't).
8. **Form happy path.** Open the builder, fill in `id=test`, `on=ci.finalized`, `where: { ci_status: "fail" }`, one `mcp/trigger_sync` action, save. Rule appears in the dashboard Rules dropdown.
9. **Form error display.** Type `bogus` into the `id` field with whitespace, hit save. Error renders inline near the field.
10. **Edit existing.** Click Edit on a loaded rule. Form pre-fills with current values. Change `cooldown_minutes`, save. Rule updates in place.
11. **Delete confirm.** Click Delete. Confirm dialog appears. Cancel keeps the rule. Confirm removes it.
12. **JSON formatting.** After a save, `config.json` opens cleanly in a JSON-aware editor with no trailing comma issues, no unicode escapes for normal text, 2-space indent matching the example.
13. **Symlink survives.** With `~/.config/claude-patrol/config.json` symlinked to a dotfiles repo, run `POST /api/rules` and confirm the symlink is still a symlink (`lstat` returns symlink), the dotfiles repo sees the change, and a `git status` in the dotfiles repo shows the modified file.
14. **Tmp cleanup on failure.** Inject a write failure (e.g. simulate ENOSPC in a test, or chmod the directory non-writable mid-write). After the API errors, no `.tmp.<pid>` file remains in the config directory.
15. **Unparseable config error path.** Corrupt the config file with invalid JSON. `POST /api/rules` returns 400 with `config_unparseable: <details>`. The frontend renders the message clearly; the user can fix manually.
16. **MCP round-trip.** Open a Claude session, call `tools/list`, see the new rule-admin tools listed. Call `validate_rule` with a deliberately-bad rule, get back `{ ok: false, errors: [...] }` with field paths. Call `create_rule` with a valid rule, get the persisted form back; the rule shows up in the dashboard within the next watcher cycle.
17. **MCP `ruleFireable: false` enforcement.** Configure a rule that tries to use `create_rule` as an `mcp` action. At rule load it's rejected with a clear "tool 'create_rule' is read-only and not rule-fireable" error.
18. **Concurrent API writes lose deterministically.** Two parallel `POST /api/rules` requests with different rule ids. One succeeds, the other gets 409 `config_modified_externally`. The successful rule is in the file, the rejected one isn't.

---

## Known limitations (document in README)

- Comments and non-JSON formatting in `config.json` are not preserved across UI writes. Patrol's loader doesn't support them anyway, but anyone using a JSONC-aware editor on the side should know.
- The builder validates against the schema but doesn't validate semantics: a rule with a `where` clause that matches no PR you'll ever own is "valid" as far as the schema is concerned.
- `dispatch_claude` prompts are single-line in v1 (matches the rules engine's runtime limitation). The textarea visually allows multi-line but the schema rejects newlines.
- Rules that fail to load remain editable but the form pre-fills from the raw JSON (not the validated shape), so some defaults won't be shown.

---

## Risks

Each risk is paired with the mitigation that's already in the algorithm or implementation above.

**1. Symlink replacement.** The user's `~/.config/claude-patrol/config.json` is a symlink into a dotfiles repo. `fs.renameSync(tmp, link)` would atomically replace the symlink itself with a regular file, divorcing patrol's writes from the dotfiles repo. *Mitigation:* `fs.realpathSync(path)` once at the top of `writeRulesToConfig`. All subsequent reads, stats, writes, and renames target the resolved real path. The symlink stays intact and writes propagate naturally.

**2. Disk-write failure leaves a tmp file behind.** If `writeFileSync` succeeds but `renameSync` fails (e.g. cross-device move, permission flip), or if the tmp write itself errors mid-stream, we'd accumulate `.tmp.<pid>` files. *Mitigation:* try/catch around steps 10-11, `fs.unlinkSync(tmp)` in the catch, swallow ENOENT (the tmp may not have been created).

**3. TOCTOU between read and write.** Another writer (the user in their editor, or another patrol instance, or a future API caller in flight) modifies `config.json` between our read at step 3 and our rename at step 11. *Mitigation:* mtime check at step 7-8 catches the common case (someone wrote between our read and our write). The narrow window between step 8 and step 11 is unprotected; for a single-user local tool that's acceptable. The next API call will see a stale mtime and 409 anyway.

**4. Concurrent API writes.** Two `POST /api/rules` calls in flight simultaneously. Both pass the mtime check before either writes. Whichever rename runs second succeeds (POSIX `rename(2)` doesn't fail just because the destination existed); the loser's data is lost. *Mitigation:* not addressed in v1. Frontend is a single user, browser submits are serialized through the form's "Saving..." state. Backend admins via curl are presumed to know what they're doing. If multi-user becomes a concern, add a `flock`-style mutex around `writeRulesToConfig`.

**5. Unparseable existing config.** The user's `config.json` has a syntax error from a manual edit gone wrong. `JSON.parse` throws inside `writeRulesToConfig`. *Mitigation:* explicit try/catch around `JSON.parse`, error rebranded as `config_unparseable: <details>`. The frontend shows the error and tells the user to fix the file by hand. Don't try to recover - we have no clean way to round-trip an unparseable file.

**6. Schema drift.** A rule that passes `validateRule` (in-memory parse) somehow fails at `loadRules` (also in-memory parse against the same schema, post-write). *Mitigation:* impossible by construction - both call `ruleSchema.safeParse` against the same module-level constant. Documented here so a reviewer doesn't add a separate validator and create the drift.

**7. Live-reload latency surfaces stale state.** API responds 200, user immediately fetches `/api/rules`, sees the old list because the watcher hasn't fired yet (1s `fs.watchFile` poll cadence). *Mitigation:* call `loadRules(cfg.rules)` directly at step 13 of the algorithm, before the API responds. The watcher firing later is a no-op (clear + repopulate from the same data, idempotent).

**8. Defaults bloat.** Writing `result.data` (zod's parsed shape) to disk would expand every rule with explicit defaults (`cooldown_minutes: 10`, `manual: false`, `requires_subscription: false`, `one_shot: false`). *Mitigation:* write the user's raw input, not the parsed shape. Step 5 of the algorithm passes `mutator(cfg.rules ?? [])` to step 10 unchanged; step 6 only validates, it doesn't replace.

**9. Defaults drift.** The user creates a rule with no `cooldown_minutes` field, gets schema default 10. We later change the default to 5. The user's behavior silently changes on next load. *Mitigation:* document. This is a known cost of relying on schema defaults; preserving the user's intent across schema changes requires writing the default *into* the file at create time, which trades upgrade safety for a verbose config. v1 picks the lean config.

**10. MCP recursion / meta-rules.** A rule that calls `create_rule` could recursively create more rules. *Mitigation:* the new admin tools are `ruleFireable: false`, the rules engine rejects them at `loadRules` time with a clear error, and `invokeAction` rejects them at runtime as a defense-in-depth backup.

**11. Multi-tab edits.** Two browser tabs editing the same rule. *Mitigation:* the file-level mtime check covers the common case (whoever saves first wins; the second's mtime is now stale and gets a 409). Per-rule etag would be cleaner; not in v1.

**12. Crash between write and `loadRules`.** Server SIGKILL'd between step 11 (file rename) and step 13 (in-memory reload). *Mitigation:* the file is on disk; next startup runs `loadRules(initialConfig.rules)` from the new file. No state is lost. The API caller gets a connection error and reissues the request, which is now a no-op (rule already in file) - except create with `if (rs.some((r) => r.id === rule.id)) throw` would 400. v1 acceptable: the user retries by editing instead of creating.
