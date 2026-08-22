import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider } from '../../context/AgentProviderContext.jsx';
import { StartWorkLauncher } from './StartWorkLauncher.jsx';

const api = vi.hoisted(() => ({
  createWorkItem: vi.fn(),
  createScratchWorkspace: vi.fn(),
  fetchProviderCapabilities: vi.fn(async () => ({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  })),
}));

vi.mock('../../lib/api.js', () => api);
vi.mock('../ui/RepoCombobox/RepoCombobox.jsx', () => ({
  /** @param {{value: string, onChange: (value: string) => void, disabled?: boolean}} props */
  RepoCombobox: ({ value, onChange, disabled }) => (
    <select
      aria-label="Repository"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      <option value="">Select repo</option>
      <option value="acme/widgets">acme/widgets</option>
    </select>
  ),
}));

/** @param {boolean} configured */
function renderLauncher(configured) {
  return render(
    <AgentProviderProvider>
      <StartWorkLauncher workItemsConfigured={configured} />
    </AgentProviderProvider>,
  );
}

beforeEach(() => {
  api.createWorkItem.mockReset();
  api.createScratchWorkspace.mockReset();
  window.location.hash = '';
  localStorage.clear();
});

test('defaults to Project reference when configured and dispatches only work-item creation', async () => {
  const user = userEvent.setup();
  api.createWorkItem.mockResolvedValue({ work_item: { id: 'work-item-1' } });
  renderLauncher(true);

  await user.click(screen.getByRole('button', { name: '+ Start work' }));
  assert.equal(
    /** @type {HTMLInputElement} */ (screen.getByRole('radio', { name: /Project reference/ })).checked,
    true,
  );
  assert.equal(
    /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: /Choose agent provider/ })).disabled,
    false,
  );
  const reference = screen.getByLabelText('Reference');
  await user.type(reference, 'ECO-3632');
  await user.click(screen.getByRole('button', { name: /Choose agent provider/ }));
  await user.click(screen.getByRole('menuitemradio', { name: /Codex/ }));
  await user.click(reference);
  await user.keyboard('{Enter}');

  assert.deepEqual(api.createWorkItem.mock.calls, [['ECO-3632', 'codex']]);
  assert.equal(api.createScratchWorkspace.mock.calls.length, 0);
  assert.equal(window.location.hash, '#/work-item/work-item-1');
});

test('defaults to Scratch repository when project references are unconfigured', async () => {
  const user = userEvent.setup();
  renderLauncher(false);

  await user.click(screen.getByRole('button', { name: '+ Start work' }));
  assert.equal(
    /** @type {HTMLInputElement} */ (screen.getByRole('radio', { name: /Scratch repository/ })).checked,
    true,
  );
  await user.click(screen.getByRole('radio', { name: /Project reference/ }));
  assert.ok(screen.getByText('Project references are not configured for this Patrol instance'));
  assert.equal(
    screen.getByRole('link', { name: 'Open Work Items settings' }).getAttribute('href'),
    '#/setup?section=work-items',
  );
});

test('scratch mode creates no session and dispatches only scratch creation', async () => {
  const user = userEvent.setup();
  api.createScratchWorkspace.mockResolvedValue({ id: 'workspace-1' });
  renderLauncher(true);

  await user.click(screen.getByRole('button', { name: '+ Start work' }));
  await user.click(screen.getByRole('radio', { name: /Scratch repository/ }));
  await user.selectOptions(screen.getByLabelText('Repository'), 'acme/widgets');
  await user.type(screen.getByLabelText('Branch'), 'feat/widgets');
  assert.equal(screen.queryByLabelText(/Choose agent provider/), null);
  await user.click(screen.getByRole('button', { name: 'Create scratch workspace' }));

  assert.deepEqual(api.createScratchWorkspace.mock.calls, [['acme/widgets', 'feat/widgets']]);
  assert.equal(api.createWorkItem.mock.calls.length, 0);
  assert.equal(window.location.hash, '#/workspace/workspace-1');
});

test('mode switching preserves values and cancel restores focus', async () => {
  const user = userEvent.setup();
  renderLauncher(true);

  const trigger = screen.getByRole('button', { name: '+ Start work' });
  await user.click(trigger);
  await user.type(screen.getByLabelText('Reference'), 'PROJECT-42');
  await user.click(screen.getByRole('radio', { name: /Scratch repository/ }));
  await user.click(screen.getByRole('radio', { name: /Project reference/ }));
  assert.equal(/** @type {HTMLInputElement} */ (screen.getByLabelText('Reference')).value, 'PROJECT-42');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  assert.equal(document.activeElement, screen.getByRole('button', { name: '+ Start work' }));
});

test('a pending launch locks mode, cancel, and repeat submission', async () => {
  const user = userEvent.setup();
  /** @type {(value: {work_item: {id: string}}) => void} */
  let resolveRequest = () => {};
  api.createWorkItem.mockReturnValue(
    new Promise((resolve) => {
      resolveRequest = resolve;
    }),
  );
  renderLauncher(true);

  await user.click(screen.getByRole('button', { name: '+ Start work' }));
  await user.type(screen.getByLabelText('Reference'), 'PROJECT-LOCK');
  await user.click(screen.getByRole('button', { name: 'Start work item' }));

  assert.equal(api.createWorkItem.mock.calls.length, 1);
  assert.equal(/** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Cancel' })).disabled, true);
  assert.equal(
    /** @type {HTMLFieldSetElement} */ (screen.getByRole('group', { name: 'Workspace type' })).disabled,
    true,
  );
  assert.equal(
    /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Starting work item...' })).disabled,
    true,
  );
  assert.equal(
    screen.getByRole('button', { name: /Choose agent provider/ }).getAttribute('title'),
    'Provider cannot be changed while the work item is starting',
  );

  resolveRequest({ work_item: { id: 'locked-item' } });
  await waitFor(() => assert.equal(window.location.hash, '#/work-item/locked-item'));
  assert.equal(api.createWorkItem.mock.calls.length, 1);
});

test('validates the reference using the backend UTF-8 byte limit', async () => {
  const user = userEvent.setup();
  renderLauncher(true);

  await user.click(screen.getByRole('button', { name: '+ Start work' }));
  await user.type(screen.getByLabelText('Reference'), 'é'.repeat(300));
  await user.click(screen.getByRole('button', { name: 'Start work item' }));

  assert.ok(screen.getByRole('alert').textContent?.includes('512 UTF-8 bytes'));
  assert.equal(api.createWorkItem.mock.calls.length, 0);
});
