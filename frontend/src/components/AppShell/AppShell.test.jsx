import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { AppShell } from './AppShell.jsx';

const baseProps = {
  title: 'Claude Patrol',
  syncTime: 'Last synced now',
  nextSync: '30s',
  syncing: false,
  onSync: vi.fn(),
  onSetup: vi.fn(),
  updateAvailable: false,
  commitsBehind: 0,
  restartNeeded: false,
  startupSha: '',
  currentSha: '',
  ghRateLimit: null,
};

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

test('shows the top-bar sync control only when PR polling is configured', () => {
  const { rerender } = render(
    <AppShell {...baseProps} pollConfigured={false}>
      <p>Work</p>
    </AppShell>,
  );

  assert.equal(screen.queryByRole('button', { name: 'Sync now' }), null);
  assert.equal(screen.queryByRole('button', { name: /Global sessions/u }), null);
  const settings = screen.getByRole('button', { name: 'Settings' });
  assert.equal(settings.querySelector('svg'), null);

  rerender(
    <AppShell {...baseProps} pollConfigured>
      <p>Work</p>
    </AppShell>,
  );
  assert.ok(screen.getByRole('button', { name: 'Sync now' }));
  assert.ok(screen.getByText(/Last synced now/u));
});

test('shows all-work navigation on detail pages', () => {
  const onBackToWork = vi.fn();
  render(
    <AppShell {...baseProps} pollConfigured onBackToWork={onBackToWork}>
      <p>Detail</p>
    </AppShell>,
  );

  screen.getByRole('button', { name: '← All work' }).click();
  assert.equal(onBackToWork.mock.calls.length, 1);
});

test('uses the same content container on dashboard and detail pages', () => {
  const { container, rerender } = render(
    <AppShell {...baseProps} pollConfigured>
      <p>Work</p>
    </AppShell>,
  );
  const dashboardContentClass = container.querySelector('main > div')?.className;

  rerender(
    <AppShell {...baseProps} pollConfigured onBackToWork={vi.fn()}>
      <p>Detail</p>
    </AppShell>,
  );

  assert.equal(container.querySelector('main > div')?.className, dashboardContentClass);
});

test('keeps the bottom bar outside the scrolling page viewport', () => {
  const { container } = render(
    <AppShell {...baseProps} pollConfigured bottomBar={<div data-testid="bottom-bar">Shells</div>}>
      <p>Work</p>
    </AppShell>,
  );
  const main = container.querySelector('main');
  const bottomBar = screen.getByTestId('bottom-bar');

  assert.equal(main?.contains(bottomBar), false);
  assert.equal(bottomBar.parentElement, main?.parentElement);
});

test('shows a spinner instead of a status dot while syncing', () => {
  render(
    <AppShell {...baseProps} pollConfigured syncing>
      <p>Work</p>
    </AppShell>,
  );

  const syncStatus = screen.getByText(/Last synced now/u);
  assert.ok(syncStatus.querySelector('[data-spinner="true"]'));
});

test('places Start work between Sync now and Settings', () => {
  render(
    <AppShell {...baseProps} pollConfigured startWorkLauncher={<button type="button">+ Start work</button>}>
      <p>Work</p>
    </AppShell>,
  );

  const labels = screen.getAllByRole('button').map((button) => button.textContent?.trim());
  assert.ok(labels.indexOf('Sync now') < labels.indexOf('+ Start work'));
  assert.ok(labels.indexOf('+ Start work') < labels.indexOf('Settings'));
});
