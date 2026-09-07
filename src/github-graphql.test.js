import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createGraphqlTransport, decodeGraphql, graphqlProcess, requireGraphqlRoot } from './github-graphql.js';

const viewer = { id: 'viewer-1', login: 'alice' };
const rateLimit = { cost: 3, remaining: 4900, resetAt: '2026-09-06T00:00:00Z' };
const raw = (data, errors, code = 0) => ({
  stdout: JSON.stringify({ data, ...(errors ? { errors } : {}) }),
  stderr: '',
  code,
});

test('nonzero process exit preserves independently successful roots without retry', async () => {
  let attempts = 0;
  const telemetry = [];
  const transport = createGraphqlTransport({
    run: async () => {
      attempts++;
      return raw(
        { viewer, rateLimit, search: null, review0: { nodes: [] } },
        [{ message: 'Search failed', path: ['search'] }],
        1,
      );
    },
  });
  const result = await transport(
    'query { search { nodes { id } } }',
    {},
    { onTelemetry: (value) => telemetry.push(value) },
  );
  assert.deepEqual(requireGraphqlRoot(result, 'review0'), { nodes: [] });
  assert.throws(() => requireGraphqlRoot(result, 'search'));
  assert.equal(attempts, 1);
  assert.deepEqual(telemetry, [rateLimit]);
});

test('malformed, identity and unassignable errors cannot authorize partial data', () => {
  for (const value of [
    { stdout: '<html>', stderr: '', code: 0 },
    raw({ search: { nodes: [] } }),
    raw({ viewer }, [{ message: 'bad' }], 1),
    raw({ viewer }, [{ type: 'FORBIDDEN', path: ['search'] }], 1),
    raw({ viewer }, undefined, 1),
  ])
    assert.throws(() => decodeGraphql(value));
});

test('every transient attempt is charged, deterministic failures do not retry', async () => {
  let calls = 0;
  let charged = 0;
  const transport = createGraphqlTransport({
    pause: async () => {},
    run: async () => {
      calls++;
      if (calls < 3) return { stdout: '', stderr: 'HTTP 502', code: 1 };
      return raw({ viewer });
    },
  });
  await transport('query { viewer { id } }', {}, { onAttempt: () => charged++ });
  assert.equal(charged, 3);
  calls = 0;
  await assert.rejects(transport('query { viewer { id } }', {}, { maxAttempts: 2 }), { kind: 'transient' });
  assert.equal(calls, 2);
});

test('rate errors retain telemetry and do not retry; stale responses cannot touch the budget', async () => {
  let charged = 0;
  let limited = 0;
  const telemetry = [];
  const transport = createGraphqlTransport({
    run: async () => raw({ viewer, rateLimit }, [{ type: 'RATE_LIMITED', message: 'limit' }], 1),
  });
  const options = {
    onAttempt: () => charged++,
    onTelemetry: (value) => telemetry.push(value),
    onRateLimit: () => limited++,
  };
  await assert.rejects(transport('query { viewer { id } }', {}, options), { rateLimited: true });
  assert.equal(charged, 1);
  assert.equal(limited, 1);
  assert.deepEqual(telemetry, [rateLimit]);
  await assert.rejects(
    transport(
      'query { viewer { id } }',
      {},
      {
        ...options,
        acceptResponse: () => {
          throw new Error('obsolete');
        },
      },
    ),
    /obsolete/,
  );
  assert.equal(limited, 1);
  assert.equal(telemetry.length, 1);
});

function processFixture(emit) {
  let child;
  return {
    spawnProcess() {
      child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        queueMicrotask(() => child.emit('close', null));
        return true;
      };
      queueMicrotask(() => emit(child));
      return child;
    },
    checkCleanup() {
      assert.equal(child.listenerCount('close'), 0);
      assert.equal(child.listenerCount('error'), 0);
      assert.equal(child.stdout.listenerCount('data'), 0);
      assert.equal(child.stderr.listenerCount('data'), 0);
    },
  };
}

test('process adapter bounds stdout and stderr without parsing truncation', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const fixture = processFixture((child) => child[stream].write('too much output'));
    await assert.rejects(graphqlProcess('query {}', {}, { ...fixture, stdoutLimit: 4, stderrLimit: 4 }), {
      kind: 'overflow',
    });
    fixture.checkCleanup();
  }
});

test('process adapter terminates timed out and cancelled attempts and removes listeners', async () => {
  const timeout = processFixture(() => {});
  await assert.rejects(graphqlProcess('query {}', {}, { ...timeout, timeoutMs: 2 }), { kind: 'timeout' });
  timeout.checkCleanup();
  const controller = new AbortController();
  const cancelled = processFixture(() => controller.abort());
  await assert.rejects(graphqlProcess('query {}', {}, { ...cancelled, signal: controller.signal }), {
    kind: 'cancelled',
  });
  cancelled.checkCleanup();
});

test('process adapter returns both streams and a nonzero exit intact', async () => {
  const fixture = processFixture((child) => {
    child.stdout.write('{"data":');
    child.stdout.write('{}}');
    child.stderr.write('GraphQL field failed');
    child.emit('close', 1);
  });
  assert.deepEqual(await graphqlProcess('query {}', {}, fixture), {
    stdout: '{"data":{}}',
    stderr: 'GraphQL field failed',
    code: 1,
  });
  fixture.checkCleanup();
});
