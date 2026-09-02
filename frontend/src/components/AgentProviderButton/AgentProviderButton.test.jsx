import assert from 'node:assert/strict';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider, useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { assertFocused } from '../../test-support/dom.js';
import { AgentProviderButton } from './AgentProviderButton.jsx';

const api = vi.hoisted(() => ({
  fetchProviderCapabilities: vi.fn(async () => ({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  })),
}));

vi.mock('../../lib/api.js', () => api);

const STORAGE_KEY = 'claude-patrol-agent-provider';

/** Exposes the context value so tests can tell a display override from a real change. */
function ProviderProbe() {
  const { provider } = useAgentProvider();
  return <span data-testid="context-provider">{provider}</span>;
}

/**
 * @param {{
 *   disabled?: boolean,
 *   providerDisabled?: boolean,
 *   providerDisabledTitle?: string,
 *   value?: import('../../types').AgentProvider,
 * }} [props]
 */
function Harness(props = {}) {
  return (
    <AgentProviderProvider>
      <AgentProviderButton onClick={onAction} {...props}>
        Start session
      </AgentProviderButton>
      <ProviderProbe />
    </AgentProviderProvider>
  );
}

const onAction = vi.fn();

beforeEach(() => {
  onAction.mockReset();
  localStorage.clear();
});

test('shows the context provider, and choosing another one updates the context and storage', async () => {
  const user = userEvent.setup();
  render(<Harness />);

  assert.equal(screen.getByTestId('context-provider').textContent, 'claude');
  const trigger = screen.getByRole('button', { name: 'Choose agent provider, currently Claude' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.getAttribute('title'), 'Choose agent provider');
  assert.equal(screen.queryByRole('menu'), null);

  await user.click(screen.getByRole('button', { name: 'Start session' }));
  assert.equal(onAction.mock.calls.length, 1);
  assert.equal(screen.queryByRole('menu'), null, 'the action segment does not open the menu');

  await user.click(trigger);
  const menu = screen.getByRole('menu', { name: 'Agent provider' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(
    within(menu)
      .getAllByRole('menuitemradio')
      .map((option) => [option.textContent, option.getAttribute('aria-checked')]),
    [
      ['CClaudeClaude Code', 'true'],
      ['CCodexCodex CLI', 'false'],
    ],
  );

  await user.click(screen.getByRole('menuitemradio', { name: /Codex/ }));
  assert.equal(screen.queryByRole('menu'), null);
  assert.ok(screen.getByRole('button', { name: 'Choose agent provider, currently Codex' }));
  assert.equal(screen.getByTestId('context-provider').textContent, 'codex');
  assert.equal(localStorage.getItem(STORAGE_KEY), 'codex');
  assertFocused(trigger, 'focus returns to the trigger after choosing');
});

test('an explicit value overrides the displayed provider without changing the context', async () => {
  const user = userEvent.setup();
  render(<Harness value="codex" />);

  assert.ok(screen.getByRole('button', { name: 'Choose agent provider, currently Codex' }));
  assert.equal(screen.getByTestId('context-provider').textContent, 'claude');

  await user.click(screen.getByRole('button', { name: /Choose agent provider/ }));
  assert.equal(screen.getByRole('menuitemradio', { name: /Codex/ }).getAttribute('aria-checked'), 'true');
  assert.equal(screen.getByRole('menuitemradio', { name: /Claude/ }).getAttribute('aria-checked'), 'false');
});

test('disabled locks both segments, and providerDisabled closes an already open menu', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Harness disabled />);

  const action = /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Start session' }));
  const trigger = /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: /Choose agent provider/ }));
  assert.equal(action.disabled, true);
  assert.equal(trigger.disabled, true);
  assert.equal(trigger.getAttribute('title'), 'Provider selection is unavailable');
  await user.click(trigger);
  assert.equal(screen.queryByRole('menu'), null);

  rerender(<Harness />);
  assert.equal(trigger.disabled, false);
  await user.click(trigger);
  assert.ok(screen.getByRole('menu'));

  rerender(<Harness providerDisabled providerDisabledTitle="Provider is locked while the session starts" />);
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(action.disabled, false, 'providerDisabled leaves the action segment usable');
  assert.equal(trigger.disabled, true);
  assert.equal(trigger.getAttribute('title'), 'Provider is locked while the session starts');
});

test('arrow keys open the menu on the selected provider, move between options, and Escape returns focus', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const trigger = screen.getByRole('button', { name: /Choose agent provider/ });

  trigger.focus();
  await user.keyboard('{ArrowDown}');
  const claude = screen.getByRole('menuitemradio', { name: /Claude/ });
  const codex = screen.getByRole('menuitemradio', { name: /Codex/ });
  await waitFor(() => assertFocused(claude, 'the selected option takes focus on the next frame'));

  await user.keyboard('{ArrowDown}');
  assertFocused(codex);
  await user.keyboard('{ArrowDown}');
  assertFocused(claude, 'focus wraps around');
  await user.keyboard('{End}');
  assertFocused(codex);
  await user.keyboard('{Home}');
  assertFocused(claude);

  await user.keyboard('{Escape}');
  assert.equal(screen.queryByRole('menu'), null);
  assertFocused(trigger, 'Escape returns focus to the trigger');
  assert.equal(screen.getByTestId('context-provider').textContent, 'claude', 'moving focus does not select');
});
