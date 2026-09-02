import assert from 'node:assert/strict';
import { homedir, tmpdir } from 'node:os';
import { test } from 'node:test';

// Guards the --import preload in package.json test:backend. If it is dropped,
// every module that resolves `~` starts touching the developer's real home.
test('the test process runs against a throwaway home directory', () => {
  assert.ok(homedir().startsWith(tmpdir()), `homedir() is ${homedir()}, expected a path under ${tmpdir()}`);
  assert.equal(process.env.XDG_CONFIG_HOME, `${homedir()}/.config`);
  assert.equal(process.env.XDG_DATA_HOME, `${homedir()}/.local/share`);
  assert.equal(process.env.XDG_STATE_HOME, `${homedir()}/.local/state`);
  assert.equal(process.env.JJ_USER, 'Patrol Tests');
});
