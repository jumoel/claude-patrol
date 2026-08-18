import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCodexEnvironment, CodexCapabilityService } from './codex-capability.js';

test('Codex child environment keeps only required auth and network context', () => {
  const environment = buildCodexEnvironment(
    {
      CODEX_HOME: '/codex',
      HTTPS_PROXY: 'https://proxy.test',
      OPENAI_API_KEY: 'must-not-leak',
      RANDOM_SECRET: 'must-not-leak',
    },
    { PATH: '/bin', HOME: '/home/test' },
  );
  assert.deepEqual(environment, {
    PATH: '/bin',
    HOME: '/home/test',
    CODEX_HOME: '/codex',
    HTTPS_PROXY: 'https://proxy.test',
  });
});

test('Codex capability requires CLI, mcp-server, and authenticated login', async () => {
  const calls = [];
  const capability = new CodexCapabilityService({
    environment: { PATH: '/bin' },
    run: async (_command, args) => {
      calls.push(args);
      if (args[0] === '--version') return { stdout: 'codex-cli 1.2.3\n' };
      return { stdout: '' };
    },
  });
  const result = await capability.refresh();
  assert.equal(result.available, true);
  assert.equal(result.version, 'codex-cli 1.2.3');
  assert.deepEqual(calls, [['--version'], ['mcp-server', '--help'], ['login', 'status']]);
});

test('Codex capability reports an unauthenticated CLI without throwing', async () => {
  const capability = new CodexCapabilityService({
    environment: { PATH: '/bin' },
    run: async (_command, args) => {
      if (args[0] === 'login') throw new Error('not logged in');
      return { stdout: args[0] === '--version' ? 'codex-cli 1.2.3' : '' };
    },
  });
  const result = await capability.refresh();
  assert.equal(result.available, false);
  assert.equal(result.reason, 'Codex is not authenticated. Run codex login.');
});
