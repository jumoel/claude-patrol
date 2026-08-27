import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseClaudeNotification,
  parseCodexNotification,
  sendProviderActivityNotification,
} from './provider-activity-notify.js';

describe('Provider activity notifier', () => {
  it('rejects malformed and unrelated notifications', () => {
    assert.equal(parseCodexNotification('not json'), null);
    assert.equal(parseCodexNotification(JSON.stringify({ type: 'other', 'turn-id': 'turn-1' })), null);
  });

  it('posts only the turn id with the session capability', async () => {
    const calls = [];
    const sent = await sendProviderActivityNotification({
      provider: 'codex',
      raw: JSON.stringify({
        type: 'agent-turn-complete',
        'turn-id': 'turn-1',
        'thread-id': 'thread-1',
        'last-assistant-message': 'private response',
      }),
      url: 'http://127.0.0.1/activity/codex',
      token: 'session-secret',
      fetchImpl: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
    });

    assert.equal(sent, true);
    assert.equal(calls[0][0], 'http://127.0.0.1/activity/codex');
    assert.equal(calls[0][1].headers.Authorization, 'Bearer session-secret');
    assert.deepEqual(JSON.parse(calls[0][1].body), { event: 'turn_completed', run_id: 'turn-1' });
  });

  it('does not fail the provider when delivery is unavailable', async () => {
    assert.equal(
      await sendProviderActivityNotification({
        provider: 'codex',
        raw: JSON.stringify({ type: 'agent-turn-complete', 'turn-id': 'turn-1' }),
        url: 'http://127.0.0.1/activity/codex',
        token: 'session-secret',
        fetchImpl: async () => {
          throw new Error('offline');
        },
      }),
      false,
    );
  });

  it('strips Claude hook payloads down to lifecycle fields', () => {
    assert.deepEqual(
      parseClaudeNotification(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          prompt_id: 'prompt-1',
          tool_name: 'Bash',
          tool_input: { command: 'private command' },
          transcript_path: '/private/transcript',
        }),
      ),
      { hook_event_name: 'PreToolUse', prompt_id: 'prompt-1', tool_name: 'Bash' },
    );
  });
});
