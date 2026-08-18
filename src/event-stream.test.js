import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventStreamHub } from '../frontend/src/lib/event-stream.js';

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type) {
    this.listeners.delete(type);
  }

  emit(type, data = '') {
    this.listeners.get(type)?.({ data });
  }

  close() {
    this.closed = true;
  }
}

test('event stream hub shares one source and closes it after the last subscriber', () => {
  const sources = [];
  const hub = new EventStreamHub((url) => {
    const source = new FakeEventSource(url);
    sources.push(source);
    return source;
  });
  const received = [];

  const unsubscribeSync = hub.subscribe('sync', (event) => received.push(`sync:${event.data}`));
  const unsubscribeTask = hub.subscribe('task-update', (event) => received.push(`task:${event.data}`));
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, '/api/events');

  sources[0].emit('sync', 'one');
  sources[0].emit('task-update', 'two');
  assert.deepEqual(received, ['sync:one', 'task:two']);

  unsubscribeSync();
  assert.equal(sources[0].closed, false);
  unsubscribeTask();
  assert.equal(sources[0].closed, true);
});
