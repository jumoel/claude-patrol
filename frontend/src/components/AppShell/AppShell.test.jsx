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
  assert.ok(screen.getByRole('button', { name: 'Settings' }));

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
