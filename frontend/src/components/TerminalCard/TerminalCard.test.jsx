import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';
import { TerminalCard } from './TerminalCard.jsx';

vi.mock('../Terminal/LazyTerminal.jsx', () => ({
  /** @param {{wsUrl: string, borderless?: boolean, onToggleMaximize?: () => void}} props */
  LazyTerminal: ({ wsUrl, borderless, onToggleMaximize }) => (
    <div data-testid="terminal" data-ws-url={wsUrl} data-borderless={String(borderless)}>
      <button type="button" onClick={onToggleMaximize}>
        Toggle terminal size
      </button>
    </div>
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

test('work-page presentation collapses in flow without window-management controls', () => {
  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      presentation="work-page"
    />,
  );

  assert.ok(screen.getByRole('heading', { name: 'Repair JavaScript CVEs · codex Waiting' }));
  const collapse = screen.getByRole('button', { name: 'Collapse' });
  assert.equal(collapse.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByRole('button', { name: 'Maximize' }));
  assert.ok(screen.getByRole('button', { name: 'Kill session' }));
  assert.equal(screen.queryByRole('button', { name: /Close|Pop out/u }), null);
  const terminal = screen.getByTestId('terminal');
  assert.equal(terminal.getAttribute('data-ws-url'), '/ws/sessions/session-1');
  assert.equal(terminal.getAttribute('data-borderless'), 'true');
  assert.equal(screen.queryByTestId('quick-actions'), null);

  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  assert.ok(screen.getByRole('button', { name: 'Restore' }));
  assert.equal(screen.queryByRole('button', { name: 'Collapse' }), null);
  assert.equal(screen.getByTestId('terminal'), terminal);

  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  assert.ok(screen.getByRole('button', { name: 'Maximize' }));

  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  assert.equal(screen.getByRole('button', { name: 'Expand' }).getAttribute('aria-expanded'), 'false');
  assert.ok(screen.getByTestId('terminal').closest('[hidden]'));

  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  assert.equal(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded'), 'true');
  assert.equal(screen.getByTestId('terminal').closest('[hidden]'), null);

  fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal size' }));
  assert.ok(screen.getByRole('button', { name: 'Restore' }));
  assert.equal(screen.getByTestId('terminal'), terminal);
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

  assert.ok(screen.getByRole('heading', { name: 'Terminal · codex Detached' }));
  assert.ok(screen.getByRole('button', { name: 'Reattach' }));
  assert.ok(screen.getByRole('button', { name: 'Kill session' }));
  assert.ok(screen.getByText('Session running in an external terminal.'));
  assert.equal(screen.queryByTestId('terminal'), null);
});
