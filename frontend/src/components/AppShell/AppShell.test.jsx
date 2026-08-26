import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { AppShell } from './AppShell.jsx';

vi.mock('../AgentProviderButton/AgentProviderButton.jsx', () => ({
  /** @param {{children: React.ReactNode}} props */
  AgentProviderButton: ({ children }) => <button type="button">{children}</button>,
}));

const baseProps = {
  title: 'Claude Patrol',
  syncTime: 'Last synced: now',
  nextSync: '30s',
  syncing: false,
  onSync: vi.fn(),
  terminalOpen: false,
  globalSessions: [],
  onToggleTerminal: vi.fn(),
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
  assert.ok(screen.getByRole('button', { name: 'Global sessions' }));
  assert.ok(screen.getByRole('button', { name: 'Settings' }));

  rerender(
    <AppShell {...baseProps} pollConfigured>
      <p>Work</p>
    </AppShell>,
  );
  assert.ok(screen.getByRole('button', { name: 'Sync now' }));
  assert.ok(screen.getByText(/Last synced: now/u));
});
