import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeCapabilityService } from './claude-capability.js';

test('Claude capability requires the CLI and an authenticated login', async () => {
  const calls = [];
  const capability = new ClaudeCapabilityService({
    environment: { PATH: '/bin' },
    run: async (_command, args) => {
      calls.push(args);
      if (args[0] === '--version') return { stdout: '2.1.235 (Claude Code)\n' };
      return { stdout: JSON.stringify({ loggedIn: true }) };
    },
  });
  const result = await capability.refresh();
  assert.equal(result.available, true);
  assert.equal(result.version, '2.1.235 (Claude Code)');
  assert.deepEqual(calls, [['--version'], ['auth', 'status']]);
});

test('Claude capability rejects a successful but logged-out auth response', async () => {
  const capability = new ClaudeCapabilityService({
    environment: { PATH: '/bin' },
    run: async (_command, args) => ({
      stdout: args[0] === '--version' ? '2.1.235 (Claude Code)' : JSON.stringify({ loggedIn: false }),
    }),
  });
  const result = await capability.refresh();
  assert.equal(result.available, false);
  assert.equal(result.reason, 'Claude is not authenticated. Run claude auth login.');
});
