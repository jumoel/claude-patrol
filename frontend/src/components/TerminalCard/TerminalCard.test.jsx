import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';
import { TerminalCard } from './TerminalCard.jsx';

vi.mock('../Terminal/LazyTerminal.jsx', () => ({
  /** @param {{wsUrl: string, borderless?: boolean}} props */
  LazyTerminal: ({ wsUrl, borderless }) => (
    <div data-testid="terminal" data-ws-url={wsUrl} data-borderless={String(borderless)} />
  ),
}));

vi.mock('../QuickActions/QuickActions.jsx', () => ({
  QuickActions: () => <div data-testid="quick-actions" />,
}));

/** @param {'active' | 'detached'} status */
function session(status) {
  return {
    id: 'session-1',
    workspace_id: null,
    work_item_id: 'item-1',
    name: null,
    target: { type: /** @type {'work_item'} */ ('work_item'), id: 'item-1' },
    pid: 123,
    provider: /** @type {'codex'} */ ('codex'),
    status,
    started_at: '2026-08-26T00:00:00.000Z',
    ended_at: null,
    claude_project_dir: null,
    transcript_path: null,
    activity_state: null,
    activity_changed_at: null,
  };
}

test('work-page presentation keeps the terminal in flow without window-management controls', () => {
  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      presentation="work-page"
    />,
  );

  assert.ok(screen.getByRole('heading', { name: 'Terminal - Repair JavaScript CVEs' }));
  assert.ok(screen.getByRole('button', { name: 'Kill session' }));
  assert.equal(screen.queryByRole('button', { name: /Maximize|Close|Pop out/u }), null);
  assert.equal(screen.getByTestId('terminal').getAttribute('data-ws-url'), '/ws/sessions/session-1');
  assert.equal(screen.getByTestId('terminal').getAttribute('data-borderless'), 'true');
  assert.ok(screen.getByTestId('quick-actions'));
});

test('detached work-page terminal remains a normal document section', () => {
  render(
    <TerminalCard
      session={session('detached')}
      title="Terminal"
      onKill={vi.fn()}
      onExit={vi.fn()}
      onReattach={vi.fn()}
      presentation="work-page"
    />,
  );

  assert.ok(screen.getByRole('heading', { name: 'Terminal' }));
  assert.ok(screen.getByRole('button', { name: 'Reattach' }));
  assert.ok(screen.getByText('Session running in an external terminal.'));
  assert.equal(screen.queryByTestId('terminal'), null);
});
