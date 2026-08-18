import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { actionRegistry } from './actions.js';
import { createAppContext } from './app-context.js';
import { CodexReviewCoordinator } from './codex-review-coordinator.js';
import { parseConfig } from './config.js';
import { migrateDb } from './migrations.js';
import { createServer } from './server.js';

test('explicit review route dispatches Claude and only that session can claim the Codex result', async () => {
  const db = new DatabaseSync(':memory:');
  migrateDb(db);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO prs
      (id, number, title, repo, org, author, url, branch, base_branch, created_at, updated_at, synced_at)
     VALUES ('acme/app#1', 1, 'Review me', 'app', 'acme', 'octocat', 'https://example.test/1', 'feature', 'main', ?, ?, ?)`,
  ).run(now, now, now);
  db.prepare(
    `INSERT INTO workspaces
      (id, pr_id, name, path, bookmark, status, created_at, operation_state, operation_step, operation_updated_at)
     VALUES ('workspace-1', 'acme/app#1', 'review', '/tmp/review', 'feature', 'active', ?, 'ready', 'create:complete', ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, pid, status, started_at)
     VALUES ('session-1', 'workspace-1', 123, 'active', ?)`,
  ).run(now);

  const appEvents = new EventEmitter();
  const coordinator = new CodexReviewCoordinator({ events: appEvents });
  const dispatches = [];
  const idleWaits = [];
  const serviceCalls = [];
  const capability = {
    environment: { PATH: '/bin' },
    getSnapshot: () => ({ available: true, checking: false, reason: null, version: 'test', checkedAt: now }),
    refreshIfStale: async () => ({ available: true, checking: false, reason: null, version: 'test', checkedAt: now }),
  };
  const config = parseConfig({ poll: { interval_seconds: 30, orgs: [], repos: [] } });
  const context = createAppContext({
    getConfig: () => config,
    getDb: () => db,
    appEvents,
    pollerEvents: new EventEmitter(),
    getSessionStates: () => [],
    getGhRateLimitState: () => ({ limited: false }),
    codexCapability: capability,
    codexReviewCoordinator: coordinator,
    getSessionCodexReviewReadiness: () => ({ ready: true, reason: null }),
    waitForFirstIdle: async (sessionId) => idleWaits.push(sessionId),
    dispatchToSession: async (sessionId, prompt) => {
      dispatches.push({ sessionId, prompt });
      return 1234;
    },
    codexReviewService: {
      run: async (input) => {
        serviceCalls.push(input);
        return {
          result: 'Finding: src/app.js can return the wrong value.',
          noChanges: false,
          range: { fork: '1'.repeat(40), head: '2'.repeat(40) },
        };
      },
    },
  });
  const server = await createServer({ context, config });

  try {
    const nullBody = await server.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/codex-review',
      payload: 'null',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(nullBody.statusCode, 400);

    const requested = await server.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/codex-review',
      payload: {},
    });
    assert.equal(requested.statusCode, 202);
    assert.equal(requested.json().review.status, 'requested');
    assert.deepEqual(idleWaits, ['session-1']);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].sessionId, 'session-1');
    assert.match(dispatches[0].prompt, /review_with_codex/);

    const wrongSession = await actionRegistry.review_with_codex.mcpHandler(server, {}, { callerSessionId: 'other' });
    assert.equal(wrongSession.error, 'review_not_ready');

    const result = await actionRegistry.review_with_codex.mcpHandler(server, {}, { callerSessionId: 'session-1' });
    assert.deepEqual(result, {
      ok: true,
      review: 'Finding: src/app.js can return the wrong value.',
      no_changes: false,
      range: { fork: '1'.repeat(40), head: '2'.repeat(40) },
    });
    assert.equal(serviceCalls.length, 1);
    assert.equal(serviceCalls[0].workspace.id, 'workspace-1');
    assert.equal(coordinator.getByWorkspace('workspace-1').status, 'delivering');

    appEvents.emit('session-state', { sessionId: 'session-1', workspaceId: 'workspace-1', state: 'idle' });
    const status = await server.inject({ method: 'GET', url: '/api/workspaces/workspace-1/codex-review' });
    assert.equal(status.json().review.status, 'complete');
    assert.equal(status.json().ready, true);
  } finally {
    await server.close();
    db.close();
  }
});
