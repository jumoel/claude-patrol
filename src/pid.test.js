import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { pidPath } from './paths.js';
import { isRunning, readPid, removePid, writePid } from './pid.js';

// The test preload points XDG_STATE_HOME at a throwaway directory, so the PID
// file these tests write never touches a real installation.
afterEach(() => removePid());

test('writePid records this process and readPid parses it back', () => {
  writePid(4321);
  const data = readPid();
  assert.equal(data.pid, process.pid);
  assert.equal(data.port, 4321);
  assert.ok(Date.parse(data.startedAt) > 0);
  assert.equal(JSON.parse(readFileSync(pidPath(), 'utf8')).port, 4321);
});

test('readPid returns null for a missing or malformed file', () => {
  assert.equal(readPid(), null);
  writeFileSync(pidPath(), '{ not json');
  assert.equal(readPid(), null);
  writeFileSync(pidPath(), JSON.stringify({ pid: 'x', port: 1 }));
  assert.equal(readPid(), null);
});

test('isRunning reports a live process and removes a stale file for a dead one', () => {
  writePid(5000);
  assert.deepEqual(isRunning(), { running: true, pid: process.pid, port: 5000, startedAt: readPid().startedAt });

  // A PID no real process can have: max pid on macOS and Linux is far below this.
  writeFileSync(pidPath(), JSON.stringify({ pid: 2 ** 22 + 12345, port: 5000, startedAt: 'x' }));
  assert.deepEqual(isRunning(), { running: false });
  assert.equal(existsSync(pidPath()), false, 'the stale file is removed');
  assert.deepEqual(isRunning(), { running: false });
});
