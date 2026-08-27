import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import { clearMaximizedTerminal, maximizedTerminalId, replaceMaximizedTerminal } from './terminal-url.js';

beforeEach(() => {
  history.replaceState(null, '', '/#/');
});

test('reads and writes a maximized terminal in the route query', () => {
  replaceMaximizedTerminal('session/one');

  assert.equal(window.location.hash, '#/?terminal=session%2Fone');
  assert.equal(maximizedTerminalId(), 'session/one');
});

test('preserves other route parameters when setting and clearing a terminal', () => {
  history.replaceState(null, '', '/#/work-item/item-1?pr=org%2Frepo%231');

  replaceMaximizedTerminal('session-1');
  assert.equal(window.location.hash, '#/work-item/item-1?pr=org%2Frepo%231&terminal=session-1');

  clearMaximizedTerminal('session-1');
  assert.equal(window.location.hash, '#/work-item/item-1?pr=org%2Frepo%231');
});

test('does not clear a terminal owned by another component', () => {
  history.replaceState(null, '', '/#/work-item/item-1?terminal=work-session');

  clearMaximizedTerminal('global-session');

  assert.equal(maximizedTerminalId(), 'work-session');
});
