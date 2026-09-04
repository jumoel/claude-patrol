import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { TerminalCard } from './TerminalCard.jsx';

vi.mock('../Terminal/LazyTerminal.jsx', () => ({
  /** @param {{wsUrl: string, borderless?: boolean, focusRequest?: number, onToggleMaximize?: () => void, tmuxScrollback?: boolean}} props */
  LazyTerminal: ({ wsUrl, borderless, focusRequest, onToggleMaximize, tmuxScrollback }) => (
    <div
      data-testid="terminal"
      data-ws-url={wsUrl}
      data-borderless={String(borderless)}
      data-focus-request={focusRequest}
      data-tmux-scrollback={String(tmuxScrollback)}
    >
      <button type="button" onClick={onToggleMaximize}>
        Toggle terminal size
      </button>
    </div>
  ),
}));

vi.mock('../QuickActions/QuickActions.jsx', () => ({
  /** @param {{workspaceId?: string, workItemId?: string, prId?: string}} props */
  QuickActions: ({ workspaceId, workItemId, prId }) => (
    <div data-testid="quick-actions" data-workspace={workspaceId} data-work-item={workItemId} data-pr={prId} />
  ),
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
    last_idle_at: null,
    claude_project_dir: null,
    transcript_path: null,
    activity_state: null,
    activity_changed_at: null,
    activity_message: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/#/work-item/item-1?pr=org%2Frepo%231');
});

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

  assert.ok(screen.getByRole('heading', { name: 'Repair JavaScript CVEs · codex Idle' }));
  const collapse = screen.getByRole('button', { name: 'Collapse' });
  assert.equal(collapse.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByRole('button', { name: 'Maximize' }));
  assert.ok(screen.getByRole('button', { name: 'Kill session' }));
  const resizeHandle = screen.getByRole('separator', { name: 'Resize terminal' });
  assert.equal(resizeHandle.getAttribute('aria-valuenow'), '400');
  assert.equal(screen.queryByRole('button', { name: /Close|Pop out/u }), null);
  const terminal = screen.getByTestId('terminal');
  assert.equal(terminal.getAttribute('data-ws-url'), '/ws/sessions/session-1');
  assert.equal(terminal.getAttribute('data-borderless'), 'true');
  assert.equal(terminal.getAttribute('data-focus-request'), '0');
  assert.equal(terminal.getAttribute('data-tmux-scrollback'), 'true');
  assert.equal(terminal.parentElement?.style.height, '400px');
  assert.ok(screen.getByTestId('quick-actions'));

  fireEvent.keyDown(resizeHandle, { key: 'ArrowDown' });
  assert.equal(screen.getByRole('separator', { name: 'Resize terminal' }).getAttribute('aria-valuenow'), '440');
  assert.equal(terminal.parentElement?.style.height, '440px');
  assert.equal(localStorage.getItem('claude-patrol-terminal-height'), '440');

  fireEvent.click(screen.getByRole('button', { name: 'Maximize' }));
  assert.ok(screen.getByRole('button', { name: 'Restore' }));
  assert.equal(window.location.hash, '#/work-item/item-1?pr=org%2Frepo%231&terminal=session-1');
  assert.equal(screen.queryByRole('button', { name: 'Collapse' }), null);
  assert.equal(screen.queryByRole('separator', { name: 'Resize terminal' }), null);
  assert.equal(screen.getByTestId('terminal'), terminal);
  assert.equal(terminal.getAttribute('data-focus-request'), '1');
  assert.equal(terminal.getAttribute('data-tmux-scrollback'), 'false');

  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  assert.ok(screen.getByRole('button', { name: 'Maximize' }));
  assert.equal(screen.getByRole('separator', { name: 'Resize terminal' }).getAttribute('aria-valuenow'), '440');
  assert.equal(window.location.hash, '#/work-item/item-1?pr=org%2Frepo%231');
  assert.equal(terminal.getAttribute('data-tmux-scrollback'), 'true');

  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  assert.equal(screen.getByRole('button', { name: 'Expand' }).getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByRole('separator', { name: 'Resize terminal' }), null);
  assert.ok(screen.getByTestId('terminal').closest('[hidden]'));

  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  assert.equal(screen.getByRole('button', { name: 'Collapse' }).getAttribute('aria-expanded'), 'true');
  assert.equal(screen.getByRole('separator', { name: 'Resize terminal' }).getAttribute('aria-valuenow'), '440');
  assert.equal(screen.getByTestId('terminal').closest('[hidden]'), null);

  fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal size' }));
  assert.ok(screen.getByRole('button', { name: 'Restore' }));
  assert.equal(screen.getByTestId('terminal'), terminal);
  assert.equal(terminal.getAttribute('data-focus-request'), '2');
});

test('restores a maximized work-page terminal from the route', () => {
  history.replaceState(null, '', '/#/work-item/item-1?terminal=session-1');

  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      presentation="work-page"
    />,
  );

  assert.ok(screen.getByRole('button', { name: 'Restore' }));
  assert.equal(screen.queryByRole('button', { name: 'Collapse' }), null);
  assert.ok(screen.getByTestId('terminal'));
});

test('work-item terminals expose peer review against their selected PR', () => {
  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      workItemId="item-1"
      prId="org/repo#1"
      presentation="work-page"
    />,
  );

  const actions = screen.getByTestId('quick-actions');
  assert.equal(actions.getAttribute('data-work-item'), 'item-1');
  assert.equal(actions.getAttribute('data-pr'), 'org/repo#1');
  assert.equal(actions.getAttribute('data-workspace'), null);
});

test('work-item terminals retain quick actions before a PR is attached', () => {
  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      workItemId="item-1"
      presentation="work-page"
    />,
  );

  const actions = screen.getByTestId('quick-actions');
  assert.equal(actions.getAttribute('data-work-item'), 'item-1');
  assert.equal(actions.getAttribute('data-pr'), null);
});

test('global terminals do not expose work-target actions', () => {
  render(
    <TerminalCard
      session={session('active')}
      title="Codex session"
      onKill={vi.fn()}
      onExit={vi.fn()}
      presentation="global"
    />,
  );

  assert.equal(screen.queryByTestId('quick-actions'), null);
});

test('shows a spinner when the terminal session is working', () => {
  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      attentionState="working"
      presentation="work-page"
    />,
  );

  const heading = screen.getByRole('heading', { name: 'Repair JavaScript CVEs · codex Working' });
  assert.ok(heading.querySelector('[data-spinner="true"]'));
  assert.equal(heading.querySelector('[data-state-marker="working"]'), null);
});

test('resizes an inline work-page terminal by dragging its lower edge', () => {
  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      presentation="work-page"
    />,
  );

  const resizeHandle = screen.getByRole('separator', { name: 'Resize terminal' });
  resizeHandle.setPointerCapture = vi.fn();
  fireEvent(resizeHandle, new MouseEvent('pointerdown', { bubbles: true, clientY: 300 }));
  fireEvent(resizeHandle, new MouseEvent('pointermove', { bubbles: true, clientY: 380 }));
  fireEvent(resizeHandle, new MouseEvent('pointerup', { bubbles: true }));

  assert.equal(resizeHandle.getAttribute('aria-valuenow'), '480');
  assert.equal(screen.getByTestId('terminal').parentElement?.style.height, '480px');
  assert.equal(localStorage.getItem('claude-patrol-terminal-height'), '480');
});

test('uses the persisted height as the default for another terminal', () => {
  localStorage.setItem('claude-patrol-terminal-height', '520');

  render(
    <TerminalCard
      session={session('active')}
      title="Terminal - Repair JavaScript CVEs"
      onKill={vi.fn()}
      onExit={vi.fn()}
      presentation="work-page"
    />,
  );

  assert.equal(screen.getByRole('separator', { name: 'Resize terminal' }).getAttribute('aria-valuenow'), '520');
  assert.equal(screen.getByTestId('terminal').parentElement?.style.height, '520px');
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
