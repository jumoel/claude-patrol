import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actionRegistry, invokeAction } from './actions.js';
import { appEvents } from './app-events.js';
import { configEvents } from './config.js';
import { getDb } from './db.js';
import { pollerEvents } from './poller.js';
import { formatPR } from './pr-status.js';
import {
  BOOT_TIMEOUT_MS_DEFAULT,
  createSession,
  getSessionStates,
  waitForFirstIdle,
  writeToSession,
} from './pty-manager.js';
import { createWorkspace } from './workspace.js';

/**
 * Rules engine. Subscribes to:
 *  - pollerEvents 'pr-changed' (for `on: 'ci.finalized'`)
 *  - appEvents 'session-state' (for `on: 'session.idle'`)
 *  - configEvents 'change' (live-reload of rules from config.json)
 *
 * Validates each rule independently via zod; bad rules surface in
 * `getRuleLoadErrors()` without blocking valid ones.
 *
 * State: in-memory `rules` map (keyed by rule id) and `loadErrors` array.
 * Persistent runs go to the `rule_runs` table.
 */

const FINAL_CI = new Set(['pass', 'fail']);

const PR_WHERE_FIELDS = new Set([
  'repo',
  'org',
  'branch',
  'base_branch',
  'author',
  'ci_status',
  'mergeable',
  'draft',
  'labels',
  'workspace_repo',
]);

const SESSION_WHERE_FIELDS = new Set(['workspace_repo']);

const SCALAR_OR_ARRAY = z.union([z.string(), z.array(z.string())]);
const BOOL_OR_ARRAY = z.union([z.boolean(), z.array(z.boolean())]);

const CI_STATUS = z.enum(['pass', 'fail', 'pending']);
const CI_STATUS_FIELD = z.union([CI_STATUS, z.array(CI_STATUS)]);
const MERGEABLE = z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']);
const MERGEABLE_FIELD = z.union([MERGEABLE, z.array(MERGEABLE)]);

const whereSchema = z
  .object({
    repo: SCALAR_OR_ARRAY.optional(),
    org: SCALAR_OR_ARRAY.optional(),
    branch: SCALAR_OR_ARRAY.optional(),
    base_branch: SCALAR_OR_ARRAY.optional(),
    author: SCALAR_OR_ARRAY.optional(),
    ci_status: CI_STATUS_FIELD.optional(),
    mergeable: MERGEABLE_FIELD.optional(),
    draft: BOOL_OR_ARRAY.optional(),
    labels: z.array(z.string()).optional(),
    workspace_repo: SCALAR_OR_ARRAY.optional(),
  })
  .strict();

const dispatchClaudeAction = z.object({
  type: z.literal('dispatch_claude'),
  prompt: z.string().min(1),
});

const mcpAction = z.object({
  type: z.literal('mcp'),
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});

const actionSchema = z.discriminatedUnion('type', [dispatchClaudeAction, mcpAction]);

const ruleSchema = z
  .object({
    id: z.string().min(1),
    on: z.enum(['ci.finalized', 'session.idle']),
    where: whereSchema.optional(),
    actions: z.array(actionSchema).min(1),
    cooldown_minutes: z.number().int().nonnegative().default(10),
  })
  .superRefine((rule, ctx) => {
    // session.idle + dispatch_claude is a self-dispatch loop trap.
    if (rule.on === 'session.idle') {
      const offending = rule.actions.findIndex((a) => a.type === 'dispatch_claude');
      if (offending !== -1) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', offending, 'type'],
          message: "dispatch_claude is not allowed on session.idle triggers (self-dispatch loop)",
        });
      }
    }

    // mcp actions must reference a tool that exists, is rule-fireable, and
    // has a `dispatch` (not just an mcpHandler).
    rule.actions.forEach((a, i) => {
      if (a.type !== 'mcp') return;
      const entry = actionRegistry[a.tool];
      if (!entry) {
        ctx.addIssue({ code: 'custom', path: ['actions', i, 'tool'], message: `unknown tool: ${a.tool}` });
        return;
      }
      if (!entry.dispatch) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'tool'],
          message: `tool '${a.tool}' is mcp-only and not rule-callable`,
        });
        return;
      }
      if (!entry.ruleFireable) {
        ctx.addIssue({
          code: 'custom',
          path: ['actions', i, 'tool'],
          message: `tool '${a.tool}' is read-only and not rule-fireable`,
        });
      }
    });

    // where keys must be valid for the trigger type.
    if (rule.where) {
      const allowed = rule.on === 'ci.finalized' ? PR_WHERE_FIELDS : SESSION_WHERE_FIELDS;
      for (const key of Object.keys(rule.where)) {
        if (!allowed.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: ['where', key],
            message: `where field '${key}' is not valid for trigger '${rule.on}'`,
          });
        }
      }
    }
  });

/** @type {Map<string, object>} */
const rules = new Map();
/** @type {Array<{rule_id: string, error: string}>} */
let loadErrors = [];

let app = null;
let currentConfig = null;
let started = false;

/**
 * Initialize and wire up the rules engine. Idempotent.
 * @param {import('fastify').FastifyInstance} fastifyApp
 * @param {object} initialConfig
 */
export function startRulesEngine(fastifyApp, initialConfig) {
  if (started) return;
  app = fastifyApp;
  currentConfig = initialConfig;
  started = true;

  // Reconcile any rule_runs that were left as 'running' when the server died.
  reconcileStaleRuns();

  loadRules(initialConfig?.rules);

  configEvents.on('change', (cfg) => {
    currentConfig = cfg;
    loadRules(cfg?.rules);
  });

  pollerEvents.on('pr-changed', (event) => {
    handlePrChanged(event).catch((err) => console.warn(`[rules] pr-changed handler error: ${err.message}`));
  });

  appEvents.on('session-state', (event) => {
    if (event.state !== 'idle') return;
    handleSessionIdle(event).catch((err) => console.warn(`[rules] session-state handler error: ${err.message}`));
  });
}

function reconcileStaleRuns() {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare("UPDATE rule_runs SET status = 'error', error = 'server_restarted', ended_at = ? WHERE status = 'running'")
    .run(now);
  if (result.changes > 0) {
    console.log(`[rules] Reconciled ${result.changes} stale rule_run(s) as 'server_restarted'`);
  }
}

function loadRules(rulesArray) {
  rules.clear();
  loadErrors = [];

  if (!Array.isArray(rulesArray)) return;

  for (const raw of rulesArray) {
    const idHint = typeof raw?.id === 'string' ? raw.id : '<unknown>';
    const result = ruleSchema.safeParse(raw);
    if (!result.success) {
      loadErrors.push({
        rule_id: idHint,
        error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }
    const rule = result.data;
    if (rules.has(rule.id)) {
      loadErrors.push({ rule_id: rule.id, error: 'duplicate rule id' });
      continue;
    }
    rules.set(rule.id, rule);
  }

  console.log(`[rules] Loaded ${rules.size} rule(s); ${loadErrors.length} error(s)`);
  // Surface each error as a warning so the TUI status line shows it (the TUI
  // patches console.warn to render as WRN). The /api/rules endpoint still
  // carries the structured list for the dashboard.
  for (const err of loadErrors) {
    console.warn(`[rules] rule '${err.rule_id}' rejected: ${err.error}`);
  }
}

export function getRules() {
  return [...rules.values()];
}

export function getRuleLoadErrors() {
  return [...loadErrors];
}

/**
 * Dispatch a `pr-changed` event to matching rules with `on: 'ci.finalized'`.
 * @param {{pr: object, prev: object, changes: object}} event
 */
async function handlePrChanged(event) {
  const { pr, changes } = event;
  if (!changes?.ci_status) return;
  if (!FINAL_CI.has(changes.ci_status.to)) return;

  const predCtx = buildPrPredCtx(pr);
  const tmplCtx = { pr, session: null };

  for (const rule of rules.values()) {
    if (rule.on !== 'ci.finalized') continue;
    if (!matches(rule.where, predCtx)) continue;
    const cooldownKey = pr.id;
    if (!cooldownOk(rule, cooldownKey)) continue;
    await fireRule(rule, {
      trigger: 'ci.finalized',
      pr_id: pr.id,
      workspace_id: null,
      session_id: null,
      cooldown_key: cooldownKey,
      tmplCtx,
    });
  }
}

/**
 * Dispatch a `session-state idle` event to matching rules with `on: 'session.idle'`.
 * @param {{sessionId: string, workspaceId: string|null, state: string}} event
 */
async function handleSessionIdle(event) {
  const { sessionId, workspaceId } = event;

  // Resolve workspace_repo from workspaces (scratch) or via prs (PR-attached).
  let workspaceRepo = null;
  let prId = null;
  if (workspaceId) {
    const db = getDb();
    const ws = db.prepare('SELECT pr_id, repo FROM workspaces WHERE id = ?').get(workspaceId);
    if (ws) {
      prId = ws.pr_id;
      if (ws.repo) {
        workspaceRepo = ws.repo;
      } else if (ws.pr_id) {
        const pr = db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(ws.pr_id);
        if (pr) workspaceRepo = `${pr.org}/${pr.repo}`;
      }
    }
  }

  const predCtx = { workspace_repo: workspaceRepo };
  const tmplCtx = { pr: null, session: { id: sessionId, workspace_id: workspaceId, workspace_repo: workspaceRepo } };

  for (const rule of rules.values()) {
    if (rule.on !== 'session.idle') continue;
    if (!matches(rule.where, predCtx)) continue;
    const cooldownKey = sessionId;
    if (!cooldownOk(rule, cooldownKey)) continue;
    await fireRule(rule, {
      trigger: 'session.idle',
      pr_id: prId,
      workspace_id: workspaceId,
      session_id: sessionId,
      cooldown_key: cooldownKey,
      tmplCtx,
    });
  }
}

/**
 * Build the flat predicate context from a formatted PR.
 */
function buildPrPredCtx(pr) {
  return {
    repo: `${pr.org}/${pr.repo}`,
    org: pr.org,
    branch: pr.branch,
    base_branch: pr.base_branch,
    author: pr.author,
    ci_status: pr.ci_status,
    mergeable: pr.mergeable,
    draft: !!pr.draft,
    labels: Array.isArray(pr.labels) ? pr.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [],
  };
}

/**
 * Match a `where` predicate against a flat context. Implicit AND across keys.
 * Scalars use equality; arrays use membership; `labels` requires all to be present.
 */
function matches(where, predCtx) {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    const actual = predCtx[key];
    if (key === 'labels') {
      if (!Array.isArray(expected)) return false;
      if (!expected.every((l) => actual?.includes(l))) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}

/**
 * Substitute `{{pr.<field>}}` and `{{session.<field>}}` against the templating ctx.
 * Missing fields collapse to '' with a logged warning. Operates on strings only.
 */
function template(str, tmplCtx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(pr|session)\.([\w_]+)\}\}/g, (_, ns, field) => {
    const val = tmplCtx[ns]?.[field];
    if (val == null) {
      console.warn(`[rules] template miss: ${ns}.${field}`);
      return '';
    }
    return String(val);
  });
}

/**
 * Recursively template all string values in an object.
 */
function templateValue(val, tmplCtx) {
  if (typeof val === 'string') return template(val, tmplCtx);
  if (Array.isArray(val)) return val.map((v) => templateValue(v, tmplCtx));
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = templateValue(v, tmplCtx);
    return out;
  }
  return val;
}

function cooldownOk(rule, cooldownKey, force = false) {
  if (force) return true;
  const minutes = rule.cooldown_minutes ?? 10;
  if (minutes === 0) return true;
  const cutoff = new Date(Date.now() - minutes * 60_000).toISOString();
  const db = getDb();
  const recent = db
    .prepare("SELECT id FROM rule_runs WHERE rule_id = ? AND cooldown_key = ? AND started_at > ? LIMIT 1")
    .get(rule.id, cooldownKey, cutoff);
  if (recent) {
    console.log(`[rules] cooldown active: rule=${rule.id} key=${cooldownKey}`);
    return false;
  }
  return true;
}

/**
 * Run a rule's action chain in order, persist a rule_runs row, emit `rule-run`.
 * @param {object} rule - validated rule definition
 * @param {object} ctx - { trigger, pr_id, workspace_id, session_id, cooldown_key, tmplCtx }
 */
export async function fireRule(rule, ctx) {
  const db = getDb();
  const id = randomUUID();
  const startedAt = new Date().toISOString();

  let runRow = {
    id,
    rule_id: rule.id,
    trigger: ctx.trigger,
    pr_id: ctx.pr_id,
    workspace_id: ctx.workspace_id,
    session_id: ctx.session_id,
    cooldown_key: ctx.cooldown_key,
    status: 'running',
    error: null,
    started_at: startedAt,
    ended_at: null,
  };

  db.prepare(
    'INSERT INTO rule_runs (id, rule_id, trigger, pr_id, workspace_id, session_id, cooldown_key, status, error, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    runRow.id,
    runRow.rule_id,
    runRow.trigger,
    runRow.pr_id,
    runRow.workspace_id,
    runRow.session_id,
    runRow.cooldown_key,
    runRow.status,
    runRow.error,
    runRow.started_at,
    runRow.ended_at,
  );
  appEvents.emit('rule-run', runRow);

  let error = null;
  try {
    for (const action of rule.actions) {
      await runAction(action, ctx, runRow);
    }
  } catch (err) {
    error = err.message || String(err);
  }

  const endedAt = new Date().toISOString();
  const status = error ? 'error' : 'success';
  db.prepare('UPDATE rule_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(status, error, endedAt, id);

  runRow = { ...runRow, status, error, ended_at: endedAt };
  appEvents.emit('rule-run', runRow);

  return runRow;
}

async function runAction(action, ctx, runRow) {
  if (action.type === 'mcp') {
    const args = templateValue(action.args ?? {}, ctx.tmplCtx);
    await invokeAction(app, action.tool, args);
    return;
  }
  if (action.type === 'dispatch_claude') {
    const prompt = template(action.prompt, ctx.tmplCtx);
    await dispatchClaude(ctx, prompt, runRow);
    return;
  }
  throw new Error(`unknown action type: ${action.type}`);
}

/**
 * Resolve workspace + session for a PR-context fire and write a prompt.
 * Errors with 'session_busy' if the session is mid-turn so cooldown can retry.
 */
function updateRunRow(runRow, patch) {
  Object.assign(runRow, patch);
  const cols = Object.keys(patch);
  if (cols.length === 0) return;
  const sql = `UPDATE rule_runs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
  getDb()
    .prepare(sql)
    .run(...cols.map((c) => patch[c]), runRow.id);
  appEvents.emit('rule-run', { ...runRow });
}

async function dispatchClaude(ctx, prompt, runRow) {
  if (!ctx.pr_id) throw new Error('dispatch_claude requires a pr_id (ci.finalized trigger)');

  const db = getDb();
  let workspace = db.prepare("SELECT * FROM workspaces WHERE pr_id = ? AND status = 'active'").get(ctx.pr_id);
  if (!workspace) {
    const created = await createWorkspace(ctx.pr_id, currentConfig);
    workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(created.id);
  }
  updateRunRow(runRow, { workspace_id: workspace.id });

  let session = db.prepare("SELECT * FROM sessions WHERE workspace_id = ? AND status = 'active'").get(workspace.id);
  let isFresh = false;
  if (session) {
    const states = getSessionStates();
    const live = states.find((s) => s.sessionId === session.id);
    if (live && live.state === 'working') {
      throw new Error('session_busy');
    }
  } else {
    session = createSession(workspace.id, workspace.path);
    isFresh = true;
  }

  updateRunRow(runRow, { session_id: session.id });

  if (isFresh) {
    await waitForFirstIdle(session.id, BOOT_TIMEOUT_MS_DEFAULT);
  }

  const ok = writeToSession(session.id, `${prompt}\r`);
  if (!ok) throw new Error(`writeToSession failed for ${session.id}`);
}

/**
 * Manual trigger entry point for `POST /api/rules/:id/run`.
 * Synthesizes the same predCtx/tmplCtx the trigger handler would.
 * @param {string} ruleId
 * @param {{pr_id?: string, session_id?: string, force?: boolean}} options
 */
export async function manualRunRule(ruleId, options = {}) {
  const rule = rules.get(ruleId);
  if (!rule) throw new Error(`unknown rule: ${ruleId}`);

  const db = getDb();
  if (rule.on === 'ci.finalized') {
    if (!options.pr_id) throw new Error('pr_id required for ci.finalized rules');
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(options.pr_id);
    if (!row) throw new Error(`pr not found: ${options.pr_id}`);
    const pr = formatPR(row);
    const cooldownKey = pr.id;
    if (!options.force && !cooldownOk(rule, cooldownKey)) {
      throw new Error('cooldown active (pass force=true to bypass)');
    }
    return fireRule(rule, {
      trigger: 'ci.finalized',
      pr_id: pr.id,
      workspace_id: null,
      session_id: null,
      cooldown_key: cooldownKey,
      tmplCtx: { pr, session: null },
    });
  }

  if (rule.on === 'session.idle') {
    if (!options.session_id) throw new Error('session_id required for session.idle rules');
    const sess = db.prepare('SELECT id, workspace_id FROM sessions WHERE id = ?').get(options.session_id);
    if (!sess) throw new Error(`session not found: ${options.session_id}`);
    let workspaceRepo = null;
    let prId = null;
    if (sess.workspace_id) {
      const ws = db.prepare('SELECT pr_id, repo FROM workspaces WHERE id = ?').get(sess.workspace_id);
      if (ws) {
        prId = ws.pr_id;
        if (ws.repo) workspaceRepo = ws.repo;
        else if (ws.pr_id) {
          const pr = db.prepare('SELECT org, repo FROM prs WHERE id = ?').get(ws.pr_id);
          if (pr) workspaceRepo = `${pr.org}/${pr.repo}`;
        }
      }
    }
    const cooldownKey = sess.id;
    if (!options.force && !cooldownOk(rule, cooldownKey)) {
      throw new Error('cooldown active (pass force=true to bypass)');
    }
    return fireRule(rule, {
      trigger: 'session.idle',
      pr_id: prId,
      workspace_id: sess.workspace_id,
      session_id: sess.id,
      cooldown_key: cooldownKey,
      tmplCtx: {
        pr: null,
        session: { id: sess.id, workspace_id: sess.workspace_id, workspace_repo: workspaceRepo },
      },
    });
  }

  throw new Error(`unknown trigger: ${rule.on}`);
}

/**
 * Read recent rule_runs rows for the API surface.
 * @param {{limit?: number, rule_id?: string, pr_id?: string}} opts
 */
export function listRuleRuns(opts = {}) {
  const db = getDb();
  const limit = Math.max(1, Math.min(500, opts.limit ?? 50));
  const where = [];
  const params = [];
  if (opts.rule_id) {
    where.push('rule_id = ?');
    params.push(opts.rule_id);
  }
  if (opts.pr_id) {
    where.push('pr_id = ?');
    params.push(opts.pr_id);
  }
  const sql = `SELECT * FROM rule_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ?`;
  params.push(limit);
  return db.prepare(sql).all(...params);
}
