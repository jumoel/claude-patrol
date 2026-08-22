import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider, useAgentProvider } from './AgentProviderContext.jsx';

const api = vi.hoisted(() => ({
  fetchProviderCapabilities: vi.fn(async () => ({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  })),
}));

vi.mock('../lib/api.js', () => api);

/** @param {{defaultProvider: import('../types').AgentProvider}} props */
function ProviderProbe({ defaultProvider }) {
  const { provider, setProvider, applyInstanceDefault } = useAgentProvider();
  useEffect(() => applyInstanceDefault(defaultProvider), [applyInstanceDefault, defaultProvider]);
  return (
    <>
      <output>{provider}</output>
      <button type="button" onClick={() => setProvider('codex')}>
        Choose Codex
      </button>
    </>
  );
}

/** @param {import('../types').AgentProvider} [defaultProvider] */
function renderProbe(defaultProvider = 'codex') {
  return render(
    <AgentProviderProvider>
      <ProviderProbe defaultProvider={defaultProvider} />
    </AgentProviderProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

test('uses the instance default when the browser has no saved provider', async () => {
  renderProbe();
  await waitFor(() => assert.equal(screen.getByRole('status').textContent, 'codex'));
  assert.equal(localStorage.getItem('claude-patrol-agent-provider'), null);
});

test('keeps a saved browser provider instead of applying the instance default', async () => {
  localStorage.setItem('claude-patrol-agent-provider', 'claude');
  renderProbe();
  await waitFor(() => assert.equal(screen.getByRole('status').textContent, 'claude'));
});

test('persists an explicit provider selection', async () => {
  const user = userEvent.setup();
  renderProbe('claude');
  await user.click(screen.getByRole('button', { name: 'Choose Codex' }));
  assert.equal(screen.getByRole('status').textContent, 'codex');
  assert.equal(localStorage.getItem('claude-patrol-agent-provider'), 'codex');
});
