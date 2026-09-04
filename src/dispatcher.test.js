import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { actionRegistry } from './actions.js';
import { closeDb, getDb, initDb } from './db.js';
import { ensureSessionAndSend } from './dispatcher.js';
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
  appContext.getSessionStates = () => [{ sessionId: 'global', state: 'working', activity_message: 'Planning changes' }];

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
    activity_message: null,
    started_at: now,
    is_global: false,
  });
  assert.equal(sessions.find((session) => session.session_id === 'global').is_global, true);
  assert.equal(sessions.find((session) => session.session_id === 'global').activity_state, 'working');
  assert.equal(sessions.find((session) => session.session_id === 'global').activity_message, 'Planning changes');
});

function insertPr(id) {
  const [repository, number] = id.split('#');
  const [org, repo] = repository.split('/');
  getDb()
    .prepare(
      `INSERT INTO prs (id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, 'octocat', 'https://example.test', 'feature', '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z')`,
    )
    .run(id, Number(number), `PR ${number}`, repo, org);
}

function insertWorkspace(id, { prId = null, path = `/tmp/${id}`, state = 'ready' } = {}) {
  getDb()
    .prepare(
      `INSERT INTO workspaces (id, pr_id, name, path, bookmark, repo, status, created_at, operation_state)
       VALUES (?, ?, ?, ?, 'feature', 'acme/widgets', 'active', '2026-08-27T12:00:00.000Z', ?)`,
    )
    .run(id, prId, id, path, state);
}

function insertSession(id, { workspaceId = null, workItemId = null, status = 'active', provider = 'claude' } = {}) {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, work_item_id, pid, provider, status, started_at)
       VALUES (?, ?, ?, 1, ?, ?, '2026-08-27T12:00:00.000Z')`,
    )
    .run(id, workspaceId, workItemId, provider, status);
}

test('workspace_id targets resolve the workspace session, refuse unknown workspaces, and create on demand', async () => {
  initDb(':memory:');
  insertWorkspace('ws-1');
  insertSession('ws-1-session', { workspaceId: 'ws-1' });
  const { appContext, calls } = dispatcherFixture();

  const existing = await ensureSessionAndSend({ workspace_id: 'ws-1', prompt: 'hi' }, appContext);
  assert.equal(existing.session_id, 'ws-1-session');
  assert.equal(existing.workspace_id, 'ws-1');
  assert.deepEqual(calls.dispatched.at(-1), { sessionId: 'ws-1-session', prompt: 'hi' });

  await assert.rejects(
    ensureSessionAndSend({ workspace_id: 'nope', prompt: 'hi' }, appContext),
    (error) => error.code === 'no_workspace',
  );

  insertWorkspace('ws-2');
  await assert.rejects(
    ensureSessionAndSend({ workspace_id: 'ws-2', prompt: 'hi' }, appContext),
    (error) => error.code === 'no_session',
  );
  const created = await ensureSessionAndSend({ workspace_id: 'ws-2', prompt: 'hi', autoCreate: true }, appContext);
  assert.equal(created.session_id, 'created-1');
  assert.deepEqual(calls.created.at(-1), {
    target: { type: 'workspace', id: 'ws-2' },
    cwd: '/tmp/ws-2',
    provider: 'claude',
  });
  assert.equal(calls.waited.length, 1, 'a fresh session waits for its first idle');
});

test('pr_id targets use the legacy workspace, the owning work item, or create local work through the service', async () => {
  initDb(':memory:');
  for (const id of ['acme/widgets#1', 'acme/widgets#2', 'acme/widgets#3']) insertPr(id);
  insertWorkspace('legacy', { prId: 'acme/widgets#1' });
  insertSession('legacy-session', { workspaceId: 'legacy' });
  const { appContext, calls } = dispatcherFixture();

  const legacy = await ensureSessionAndSend({ pr_id: 'acme/widgets#1', prompt: 'hi' }, appContext);
  assert.equal(legacy.session_id, 'legacy-session');

  await assert.rejects(
    ensureSessionAndSend({ pr_id: 'acme/widgets#2', prompt: 'hi' }, appContext),
    (error) => error.code === 'no_workspace',
  );

  insertWorkItem('owner');
  getDb()
    .prepare(
      "INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at) VALUES ('acme/widgets#3', 'owner', 'explicit', '2026-08-27T12:00:00.000Z')",
    )
    .run();
  const owned = await ensureSessionAndSend({ pr_id: 'acme/widgets#3', prompt: 'hi', autoCreate: true }, appContext);
  assert.equal(owned.work_item_id, 'owner');
  assert.deepEqual(calls.created.at(-1).target, { type: 'work_item', id: 'owner' });

  const service = {
    create({ source, pr_id }) {
      assert.equal(source, 'pull_request');
      assert.equal(pr_id, 'acme/widgets#2');
      insertWorkItem('fresh');
      return { id: 'fresh' };
    },
    async waitForIdle() {},
  };
  const created = await ensureSessionAndSend(
    { pr_id: 'acme/widgets#2', prompt: 'hi', autoCreate: true },
    { ...appContext, workItemService: service },
  );
  assert.equal(created.work_item_id, 'fresh');
  assert.equal(calls.created.at(-1).cwd, '/tmp/fresh');
});

test('global targets need zero or one live global session and create one in global_terminal_cwd', async () => {
  initDb(':memory:');
  const { appContext, calls } = dispatcherFixture();

  await assert.rejects(
    ensureSessionAndSend({ global: true, prompt: 'hi' }, appContext),
    (error) => error.code === 'no_session',
  );
  const created = await ensureSessionAndSend(
    { global: true, prompt: 'hi', autoCreate: true, provider: 'codex' },
    appContext,
  );
  assert.deepEqual(calls.created.at(-1), { target: { type: 'global' }, cwd: '/tmp', provider: 'codex' });
  assert.equal(created.provider, 'codex');

  insertSession('second-global', { provider: 'claude' });
  await assert.rejects(
    ensureSessionAndSend({ global: true, prompt: 'hi' }, appContext),
    (error) => error.code === 'ambiguous_target',
  );

  getDb().prepare("DELETE FROM sessions WHERE id = 'second-global'").run();
  getDb().prepare("UPDATE sessions SET status = 'detached' WHERE id = 'created-1'").run();
  await assert.rejects(
    ensureSessionAndSend({ global: true, prompt: 'hi' }, appContext),
    (error) => error.code === 'session_detached',
  );
});

test('waitForBusy queues behind a working session and prompts are cleaned before dispatch', async () => {
  initDb(':memory:');
  insertWorkspace('ws-1');
  insertSession('busy', { workspaceId: 'ws-1' });
  const { appContext, calls } = dispatcherFixture();
  appContext.getSessionSnapshot = () => ({ activityState: 'working' });

  await ensureSessionAndSend({ workspace_id: 'ws-1', prompt: 'line one\nline two\r\n', waitForBusy: true }, appContext);
  assert.equal(calls.waited.length, 1);
  assert.equal(calls.waited[0].timeout, 15 * 60_000, 'the busy wait uses the long timeout');
  assert.deepEqual(calls.dispatched.at(-1), { sessionId: 'busy', prompt: 'line one line two ' });

  calls.waited.length = 0;
  await ensureSessionAndSend({ workspace_id: 'ws-1', prompt: 'no wait' }, appContext);
  assert.equal(calls.waited.length, 0, 'without waitForBusy the busy check is left to dispatchToSession');

  await assert.rejects(
    ensureSessionAndSend({ workspace_id: 'ws-1', prompt: '\n\n  \n' }, appContext),
    (error) => error.code === 'invalid_prompt',
  );
  await assert.rejects(ensureSessionAndSend({ prompt: 'hi' }, appContext), (error) => error.code === 'no_target');
});
