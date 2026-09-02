import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateStartup } from './startup.js';

/** @param {Record<string, boolean>} available map of "cmd arg" to whether it succeeds */
function runner(available) {
  const calls = [];
  const run = async (cmd, args) => {
    const key = `${cmd} ${args.join(' ')}`;
    calls.push(key);
    if (available[key] === false) throw new Error(`${key} failed`);
    return { stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('without poll targets only jj and tmux are required', async () => {
  const { run, calls } = runner({});
  await validateStartup({ poll: { orgs: [], repos: [] } }, { run });
  assert.deepEqual(calls, ['jj --version', 'tmux -V']);
});

test('poll targets add gh and its authentication to the checks', async () => {
  const { run, calls } = runner({});
  await validateStartup({ poll: { orgs: ['acme'], repos: [] } }, { run });
  assert.deepEqual(calls, ['gh --version', 'jj --version', 'tmux -V', 'gh auth status']);
});

test('every missing tool is listed in one error, and an unauthenticated gh is its own message', async () => {
  const missing = runner({ 'jj --version': false, 'tmux -V': false });
  await assert.rejects(validateStartup({}, { run: missing.run }), (error) => {
    assert.match(error.message, /Startup validation failed/);
    assert.match(error.message, /Jujutsu \(jj\)/);
    assert.match(error.message, /tmux/);
    return true;
  });

  const unauthenticated = runner({ 'gh auth status': false });
  await assert.rejects(
    validateStartup({ poll: { orgs: [], repos: ['acme/widgets'] } }, { run: unauthenticated.run }),
    /GitHub CLI is not authenticated/,
  );
});
