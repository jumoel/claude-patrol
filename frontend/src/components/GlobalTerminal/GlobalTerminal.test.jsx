import assert from 'node:assert/strict';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider } from '../../context/AgentProviderContext.jsx';
import { GlobalTerminal } from './GlobalTerminal.jsx';

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  killSession: vi.fn(),
  promoteSession: vi.fn(),
  reattachSession: vi.fn(),
  renameSession: vi.fn(),
  fetchProviderCapabilities: vi.fn(async () => ({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  })),
}));

vi.mock('../../lib/api.js', () => api);
vi.mock('../Terminal/LazyTerminal.jsx', () => ({
  /** @param {{wsUrl: string, onExit?: (code: number) => void}} props */
  LazyTerminal: ({ wsUrl, onExit }) => (
    <div data-testid="terminal" data-ws-url={wsUrl}>
      <button type="button" onClick={() => onExit?.(0)}>
        Simulate exit
      </button>
    </div>
  ),
}));

/** @param {Partial<import('../../types').Session> & {id: string}} overrides */
function session(overrides) {
  const { id, ...rest } = overrides;
  return /** @type {import('../../types').Session} */ ({
    id,
    workspace_id: null,
    work_item_id: null,
    name: 'Session',
    target: /** @type {const} */ ({ type: 'global' }),
    activity_state: null,
    pid: 1,
    provider: 'claude',
    status: 'active',
    started_at: '2026-08-22T00:00:00.000Z',
    ended_at: null,
    claude_project_dir: null,
    transcript_path: null,
    ...rest,
  });
}

const planner = session({ id: 'planner', name: 'Planner' });
const reviewer = session({ id: 'reviewer', name: 'Reviewer', provider: 'codex' });

function renderTerminal(/** @type {Partial<React.ComponentProps<typeof GlobalTerminal>>} */ overrides = {}) {
  const callbacks = {
    onToggle: vi.fn(),
    onReload: vi.fn(),
    onSelectSession: vi.fn(),
    onUpsertSession: vi.fn(),
    onRemoveSession: vi.fn(),
  };
  const props = {
    open: true,
    onToggle: callbacks.onToggle,
    sessions: [planner, reviewer],
    activeSession: planner,
    loading: false,
    loadError: null,
    onReload: callbacks.onReload,
    onSelectSession: callbacks.onSelectSession,
    onUpsertSession: callbacks.onUpsertSession,
    onRemoveSession: callbacks.onRemoveSession,
    ...overrides,
  };
  return {
    props,
    callbacks,
    view: render(
      <AgentProviderProvider>
        <GlobalTerminal {...props} />
      </AgentProviderProvider>,
    ),
  };
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockClear();
  localStorage.clear();
});

test('renders accessible tabs and mounts only the selected terminal', async () => {
  const { props, callbacks, view } = renderTerminal();
  const tabs = screen.getAllByRole('tab');
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'false');
  assert.equal(screen.getAllByTestId('terminal').length, 1);
  assert.equal(screen.getByTestId('terminal').getAttribute('data-ws-url'), '/ws/sessions/planner');

  tabs[0].focus();
  fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
  assert.deepEqual(callbacks.onSelectSession.mock.calls, [['reviewer']]);
  await waitFor(() => assert.equal(document.activeElement, tabs[1]));

  view.rerender(
    <AgentProviderProvider>
      <GlobalTerminal {...props} activeSession={reviewer} />
    </AgentProviderProvider>,
  );
  assert.equal(screen.getAllByTestId('terminal').length, 1);
  assert.equal(screen.getByTestId('terminal').getAttribute('data-ws-url'), '/ws/sessions/reviewer');
});

test('renames the selected tab and keeps it when kill fails', async () => {
  const user = userEvent.setup();
  const renamed = { ...planner, name: 'Architect' };
  api.renameSession.mockResolvedValue(renamed);
  api.killSession.mockRejectedValue(new Error('tmux refused'));
  const { callbacks } = renderTerminal({ sessions: [planner], activeSession: planner });

  await user.click(screen.getByRole('button', { name: 'Rename' }));
  const input = screen.getByLabelText('Session name');
  await user.clear(input);
  await user.type(input, 'Architect');
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => assert.deepEqual(callbacks.onUpsertSession.mock.calls, [[renamed]]));

  await user.click(screen.getByRole('button', { name: 'Kill' }));
  await screen.findByText('tmux refused');
  assert.equal(callbacks.onRemoveSession.mock.calls.length, 0);
});

test('keeps asynchronous action errors attached to their session', async () => {
  const user = userEvent.setup();
  /** @type {(error: Error) => void} */
  let rejectKill;
  api.killSession.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectKill = reject;
      }),
  );
  const { props, view } = renderTerminal({ activeSession: planner });

  await user.click(screen.getByRole('button', { name: 'Kill' }));
  view.rerender(
    <AgentProviderProvider>
      <GlobalTerminal {...props} activeSession={reviewer} />
    </AgentProviderProvider>,
  );
  await act(async () => rejectKill(new Error('planner kill failed')));
  assert.equal(screen.queryByText('planner kill failed'), null);

  view.rerender(
    <AgentProviderProvider>
      <GlobalTerminal {...props} activeSession={planner} />
    </AgentProviderProvider>,
  );
  await screen.findByText('planner kill failed');
});

test('removes only the session whose terminal exits', async () => {
  const user = userEvent.setup();
  const { callbacks, props, view } = renderTerminal({ sessions: [planner], activeSession: planner });
  await user.click(screen.getByRole('button', { name: 'Simulate exit' }));
  assert.deepEqual(callbacks.onRemoveSession.mock.calls, [['planner']]);

  view.rerender(
    <AgentProviderProvider>
      <GlobalTerminal {...props} sessions={[]} activeSession={null} />
    </AgentProviderProvider>,
  );
  assert.equal(api.createSession.mock.calls.length, 0);
});
