import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeClaudeAgentStatus,
  normalizeCodexPaneStatus,
  parseTmuxProviderPanes,
  pollProviderSessionStatuses,
} from './provider-status-poller.js';

const separator = '\x1f';

describe('provider status polling', () => {
  it('parses Patrol panes without reading their terminal contents', () => {
    const panes = parseTmuxProviderPanes(
      [
        `patrol-claude-one${separator}101${separator}claude${separator}workspace`,
        `patrol-codex-one${separator}202${separator}codex${separator}\u2834 workspace`,
        `unrelated${separator}303${separator}zsh${separator}shell`,
      ].join('\n'),
    );

    assert.deepEqual(
      [...panes],
      [
        ['claude-one', { panePid: 101, currentCommand: 'claude', title: 'workspace' }],
        ['codex-one', { panePid: 202, currentCommand: 'codex', title: '\u2834 workspace' }],
      ],
    );
  });

  it('normalizes provider-owned working, blocked, and idle states', () => {
    assert.equal(normalizeClaudeAgentStatus({ state: 'working' }), 'working');
    assert.equal(normalizeClaudeAgentStatus({ state: 'needs_input' }), 'blocked');
    assert.equal(normalizeClaudeAgentStatus({ status: 'waiting' }), 'blocked');
    assert.equal(normalizeClaudeAgentStatus({ state: 'idle' }), 'idle');
    assert.equal(normalizeClaudeAgentStatus({ state: 'completed' }), null);

    assert.equal(normalizeCodexPaneStatus({ currentCommand: 'codex', title: '\u2834 workspace' }), 'working');
    assert.equal(normalizeCodexPaneStatus({ currentCommand: 'codex', title: 'workspace' }), 'idle');
    assert.equal(normalizeCodexPaneStatus({ currentCommand: 'zsh', title: 'workspace' }), null);
    assert.equal(normalizeCodexPaneStatus({ currentCommand: 'codex', title: '' }), null);
  });

  it('polls each provider once and maps Claude sessions by pane pid', async () => {
    const calls = [];
    const execFileImpl = async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'tmux') {
        return {
          stdout: [
            `patrol-claude-working${separator}101${separator}claude${separator}claude workspace`,
            `patrol-claude-blocked${separator}102${separator}claude${separator}claude workspace`,
            `patrol-codex-working${separator}201${separator}codex${separator}\u2834 codex workspace`,
            `patrol-codex-idle${separator}202${separator}codex${separator}codex workspace`,
          ].join('\n'),
        };
      }
      return {
        stdout: JSON.stringify([
          { pid: 101, state: 'working' },
          { pid: 102, state: 'needs_input' },
        ]),
      };
    };

    const statuses = await pollProviderSessionStatuses(
      [
        { sessionId: 'claude-working', provider: 'claude' },
        { sessionId: 'claude-blocked', provider: 'claude' },
        { sessionId: 'codex-working', provider: 'codex' },
        { sessionId: 'codex-idle', provider: 'codex' },
      ],
      { execFileImpl },
    );

    assert.deepEqual(
      [...statuses],
      [
        ['claude-working', { state: 'working', source: 'claude_status_poll' }],
        ['claude-blocked', { state: 'blocked', source: 'claude_status_poll' }],
        ['codex-working', { state: 'working', source: 'codex_status_poll' }],
        ['codex-idle', { state: 'idle', source: 'codex_status_poll' }],
      ],
    );
    assert.equal(calls.filter(([command]) => command === 'tmux').length, 1);
    assert.equal(calls.filter(([command]) => command === 'claude').length, 1);
  });

  it('keeps missing and malformed provider results unknown', async () => {
    const statuses = await pollProviderSessionStatuses([{ sessionId: 'claude-unknown', provider: 'claude' }], {
      execFileImpl: async (command) =>
        command === 'tmux'
          ? {
              stdout: `patrol-claude-unknown${separator}101${separator}claude${separator}workspace`,
            }
          : { stdout: 'not json' },
    });

    assert.deepEqual([...statuses], []);
  });
});
