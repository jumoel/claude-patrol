import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { actionRegistry } from './actions.js';
import { closeDb, getDb, initDb } from './db.js';
import { insertTestWorkItem } from './test-support/work-items.js';

afterEach(() => closeDb());

function insertWorkItem(id, state = 'ready', provider = 'codex') {
  insertTestWorkItem(getDb(), { id, state, resolverProvider: provider });
}

function dispatcherFixture() {
  const calls = {
    created: [],
    reattached: [],
    waited: [],
    dispatched: [],
  };
  let sequence = 0;
  const appContext = {
    getDb,
    getConfig: () => ({ global_terminal_cwd: '/tmp' }),
    getSessionStates: () => [],
    getSessionSnapshot: () => ({ activityState: 'idle' }),
    createSession(target, cwd, provider) {
      sequence++;
      const session = {
        id: `created-${sequence}`,
        workspace_id: null,
        work_item_id: target.type === 'work_item' ? target.id : null,
        provider,
        status: 'active',
        started_at: `2026-08-27T12:00:0${sequence}.000Z`,
      };
      calls.created.push({ target, cwd, provider });
      getDb()
        .prepare(
          `INSERT INTO sessions (id, workspace_id, work_item_id, pid, provider, status, started_at)
           VALUES (?, ?, ?, 1, ?, 'active', ?)`,
        )
        .run(session.id, session.workspace_id, session.work_item_id, session.provider, session.started_at);
      return session;
    },
    reattachSession(sessionId) {
      calls.reattached.push(sessionId);
      getDb().prepare("UPDATE sessions SET status = 'active' WHERE id = ?").run(sessionId);
      return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    },
    async waitForFirstIdle(sessionId, timeout) {
      calls.waited.push({ sessionId, timeout });
    },
    async dispatchToSession(sessionId, prompt) {
      calls.dispatched.push({ sessionId, prompt });
      return 1_000 + calls.dispatched.length;
    },
  };
  return { app: { appContext }, appContext, calls };
}

test('work-item MCP dispatch creates, reuses, and self-rejects one root session', async () => {
  initDb(':memory:');
  insertWorkItem('ready');
  insertWorkItem('stopped');
  const { app, appContext, calls } = dispatcherFixture();
  const action = actionRegistry.send_prompt_to_session;
  const args = action.schema.parse({
    work_item_id: 'ready',
    provider: 'claude',
    prompt: 'inspect the work item',
  });

  const created = await action.mcpHandler(app, args, { callerSessionId: 'caller' });
  assert.deepEqual(created, {
    ok: true,
    session_id: 'created-1',
    workspace_id: null,
    work_item_id: 'ready',
    provider: 'claude',
    dispatched_at: 1001,
  });
  assert.deepEqual(calls.created, [
    { target: { type: 'work_item', id: 'ready' }, cwd: '/tmp/ready', provider: 'claude' },
  ]);
  assert.equal(getDb().prepare("SELECT provider FROM sessions WHERE id = 'created-1'").get().provider, 'claude');
  assert.equal(calls.waited.length, 1);

  const reused = await action.mcpHandler(app, { ...args, prompt: 'continue' }, { callerSessionId: 'caller' });
  assert.equal(reused.session_id, 'created-1');
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.dispatched.at(-1), { sessionId: 'created-1', prompt: 'continue' });

  const self = await action.mcpHandler(app, args, { callerSessionId: 'created-1' });
  assert.deepEqual(self, { ok: false, error: 'self_target', message: 'cannot send prompt to your own session' });
  assert.equal(calls.dispatched.length, 2);

  appContext.getSessionSnapshot = () => ({ activityState: 'working' });
  appContext.dispatchToSession = async () => {
    const error = new Error('session created-1 is currently working');
    error.code = 'session_busy';
    throw error;
  };
  const busy = await action.mcpHandler(app, args, { callerSessionId: 'caller' });
  assert.equal(busy.error, 'session_busy');

  const absent = await action.mcpHandler(
    app,
    { work_item_id: 'stopped', prompt: 'do not launch', create_if_missing: false },
    { callerSessionId: 'caller' },
  );
  assert.equal(absent.error, 'no_session');

  const ambiguous = await action.mcpHandler(
    app,
    { work_item_id: 'ready', workspace_id: 'workspace-1', prompt: 'do not choose' },
    { callerSessionId: 'caller' },
  );
  assert.equal(ambiguous.error, 'multiple_targets');
});

test('work-item MCP dispatch reattaches a detached root and replaces it only when dead', async () => {
  initDb(':memory:');
  insertWorkItem('ready');
  const now = '2026-08-27T12:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO sessions (id, work_item_id, pid, provider, status, started_at)
       VALUES ('detached-root', 'ready', 1, 'codex', 'detached', ?)`,
    )
    .run(now);
  const { app, appContext, calls } = dispatcherFixture();
  const action = actionRegistry.send_prompt_to_session;

  const result = await action.mcpHandler(
    app,
    { work_item_id: 'ready', prompt: 'resume this work', provider: 'codex' },
    { callerSessionId: 'caller' },
  );
  assert.equal(result.ok, true);
  assert.equal(result.session_id, 'detached-root');
  assert.deepEqual(calls.reattached, ['detached-root']);
  assert.equal(calls.created.length, 0);
  assert.equal(calls.waited.length, 0);

  getDb().prepare("UPDATE sessions SET status = 'detached' WHERE id = 'detached-root'").run();
  calls.reattached.length = 0;
  const conflict = await action.mcpHandler(
    app,
    { session_id: 'detached-root', prompt: 'wrong provider', provider: 'claude' },
    { callerSessionId: 'caller' },
  );
  assert.equal(conflict.error, 'provider_conflict');
  assert.deepEqual(calls.reattached, []);

  appContext.reattachSession = (sessionId) => {
    calls.reattached.push(sessionId);
    getDb().prepare("UPDATE sessions SET status = 'killed' WHERE id = ?").run(sessionId);
    throw new Error('Session tmux process is no longer alive');
  };
  const replacement = await action.mcpHandler(
    app,
    { work_item_id: 'ready', prompt: 'replace the dead session', provider: 'codex' },
    { callerSessionId: 'caller' },
  );
  assert.equal(replacement.ok, true);
  assert.equal(replacement.session_id, 'created-1');
  assert.deepEqual(calls.reattached, ['detached-root']);
  assert.equal(calls.created.length, 1);
});

test('work-item MCP dispatch reports each non-ready lifecycle state', async () => {
  initDb(':memory:');
  const { app } = dispatcherFixture();
  const action = actionRegistry.send_prompt_to_session;
  for (const state of ['resolving', 'preparing', 'error', 'destroying', 'destroyed']) {
    insertWorkItem(state, state);
    const result = await action.mcpHandler(
      app,
      { work_item_id: state, prompt: 'do not run' },
      { callerSessionId: 'caller' },
    );
    assert.equal(result.error, `work_item_${state}`);
  }
  const missing = await action.mcpHandler(
    app,
    { work_item_id: 'missing', prompt: 'do not run' },
    { callerSessionId: 'caller' },
  );
  assert.equal(missing.error, 'work_item_not_found');
});

test('list_sessions exposes work-item identity and only marks targetless sessions global', async () => {
  initDb(':memory:');
  insertWorkItem('ready');
  const now = '2026-08-27T12:00:00.000Z';
  getDb()
    .prepare(
      `INSERT INTO sessions (id, work_item_id, pid, provider, status, started_at)
       VALUES ('work-root', 'ready', 1, 'codex', 'detached', ?)`,
    )
    .run(now);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, name, pid, provider, status, started_at)
       VALUES ('global', 'Planner', 2, 'claude', 'active', ?)`,
    )
    .run(now);
  const { app, appContext } = dispatcherFixture();
  appContext.getSessionStates = () => [{ sessionId: 'global', state: 'working' }];

  const sessions = await actionRegistry.list_sessions.mcpHandler(app, {});
  const workItem = sessions.find((session) => session.session_id === 'work-root');
  assert.deepEqual(workItem, {
    session_id: 'work-root',
    name: null,
    provider: 'codex',
    status: 'detached',
    workspace_id: null,
    work_item_id: 'ready',
    pr_id: null,
    repo: null,
    bookmark: null,
    workspace_path: null,
    work_item_title: 'Work ready',
    work_item_reference: 'PROJECT-ready',
    work_item_path: '/tmp/ready',
    activity_state: null,
    started_at: now,
    is_global: false,
  });
  assert.equal(sessions.find((session) => session.session_id === 'global').is_global, true);
  assert.equal(sessions.find((session) => session.session_id === 'global').activity_state, 'working');
});
