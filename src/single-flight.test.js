import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SingleFlight } from './single-flight.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

test('single-flight never overlaps and coalesces pending requests', async () => {
  const gates = [deferred(), deferred()];
  const calls = [];
  let concurrent = 0;
  let maximumConcurrent = 0;
  const flight = new SingleFlight({
    merge: (previous, next) => ({ value: next.value, force: previous.force || next.force }),
    run: async (request) => {
      const index = calls.length;
      calls.push(request);
      concurrent++;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await gates[index].promise;
      concurrent--;
      return request.value;
    },
  });

  const first = flight.request({ value: 'first', force: false });
  const second = flight.request({ value: 'second', force: false });
  const third = flight.request({ value: 'latest', force: true });
  assert.equal(calls.length, 1);

  gates[0].resolve();
  assert.equal(await first, 'first');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[1], { value: 'latest', force: true });

  gates[1].resolve();
  assert.equal(await second, 'latest');
  assert.equal(await third, 'latest');
  await flight.whenIdle();
  assert.equal(maximumConcurrent, 1);
});

test('single-flight recovers after a rejected execution', async () => {
  let calls = 0;
  const flight = new SingleFlight({
    run: async () => {
      calls++;
      if (calls === 1) throw new Error('expected failure');
      return 'ok';
    },
  });

  await assert.rejects(flight.request('first'), /expected failure/);
  assert.equal(await flight.request('second'), 'ok');
});
