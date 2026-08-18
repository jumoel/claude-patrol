import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AutomationQueue } from './automation-queue.js';
import { closeDb, getDb, initDb } from './db.js';

afterEach(() => closeDb());

function deferred() {
  let resolve;
  const promise = new Promise((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function run(id, overrides = {}) {
  return {
    id,
    rule_id: 'test-rule',
    trigger: 'ci.finalized',
    pr_id: `acme/widgets#${id}`,
    workspace_id: null,
    session_id: null,
    cooldown_key: overrides.cooldown_key ?? `key-${id}`,
    status: 'running',
    error: null,
    started_at: overrides.started_at ?? new Date().toISOString(),
    ended_at: null,
  };
}

test('automation queue enforces its concurrency limit', async () => {
  initDb(':memory:');
  const gates = [deferred(), deferred()];
  const started = [];
  const queue = new AutomationQueue({
    getDb,
    concurrency: 1,
    execute: async ({ index }) => {
      started.push(index);
      await gates[index].promise;
    },
  });
  queue.start();

  const first = queue.enqueue({ run: run('one'), payload: { index: 0 } });
  const second = queue.enqueue({ run: run('two'), payload: { index: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0]);

  gates[0].resolve();
  assert.equal((await first.completion).status, 'success');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);

  gates[1].resolve();
  assert.equal((await second.completion).status, 'success');
  await queue.stop();
});

test('cooldown reservation is atomic and duplicate event keys are rejected', async () => {
  initDb(':memory:');
  const gate = deferred();
  const queue = new AutomationQueue({
    getDb,
    execute: () => gate.promise,
  });
  queue.start();

  const first = queue.enqueue({
    run: run('one', { cooldown_key: 'shared' }),
    payload: {},
    cooldownMinutes: 10,
    dedupeKey: 'event-one',
  });
  assert.throws(
    () =>
      queue.enqueue({
        run: run('two', { cooldown_key: 'shared' }),
        payload: {},
        cooldownMinutes: 10,
      }),
    (error) => error.code === 'cooldown',
  );
  assert.throws(
    () =>
      queue.enqueue({
        run: run('three'),
        payload: {},
        bypassCooldown: true,
        dedupeKey: 'event-one',
      }),
    (error) => error.code === 'duplicate',
  );

  gate.resolve();
  await first.completion;
  await queue.stop();
});

test('queued jobs resume after a restart without replaying interrupted jobs', async () => {
  initDb(':memory:');
  const firstQueue = new AutomationQueue({ getDb, execute: async () => {} });
  firstQueue.start();
  firstQueue.enqueue({ run: run('queued'), payload: { value: 42 } });
  await firstQueue.stop({ drain: false });

  const executed = [];
  const secondQueue = new AutomationQueue({
    getDb,
    execute: async (payload) => executed.push(payload.value),
  });
  secondQueue.start();
  for (let attempt = 0; attempt < 20; attempt++) {
    const status = getDb().prepare('SELECT status FROM rule_runs WHERE id = ?').get('queued')?.status;
    if (status === 'success') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(executed, [42]);
  assert.equal(getDb().prepare('SELECT status FROM rule_runs WHERE id = ?').get('queued').status, 'success');
  await secondQueue.stop();

  getDb()
    .prepare(
      `INSERT INTO rule_runs
        (id, rule_id, trigger, cooldown_key, status, started_at)
       VALUES ('interrupted', 'test-rule', 'ci.finalized', 'interrupted', 'running', ?)`,
    )
    .run(new Date().toISOString());
  getDb()
    .prepare(
      `INSERT INTO automation_jobs (id, payload, status, created_at, updated_at)
       VALUES ('interrupted', '{}', 'running', ?, ?)`,
    )
    .run(new Date().toISOString(), new Date().toISOString());

  const thirdQueue = new AutomationQueue({ getDb, execute: async () => assert.fail('interrupted job replayed') });
  thirdQueue.start();
  assert.deepEqual(
    { ...getDb().prepare('SELECT status, error FROM rule_runs WHERE id = ?').get('interrupted') },
    {
      status: 'error',
      error: 'server_restarted',
    },
  );
  await thirdQueue.stop();
});
