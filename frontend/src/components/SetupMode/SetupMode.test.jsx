import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { SetupMode } from './SetupMode.jsx';

const api = vi.hoisted(() => ({
  fetchConfig: vi.fn(),
  fetchProviderCapabilities: vi.fn(),
  fetchSetupAccounts: vi.fn(),
  fetchSetupRepos: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock('../../lib/api.js', () => api);

/** @type {import('../../types').SetupAccount[]} */
const ACCOUNTS = [
  { login: 'acme', type: 'org', avatar_url: 'https://avatars.test/acme' },
  { login: 'beta', type: 'user', avatar_url: 'https://avatars.test/beta' },
  { login: 'gamma', type: 'org', avatar_url: 'https://avatars.test/gamma' },
];

/** @type {Record<string, import('../../types').SetupRepo[]>} */
const REPOS = {
  acme: [
    { name: 'api', nameWithOwner: 'acme/api', description: 'HTTP edge' },
    { name: 'widgets', nameWithOwner: 'acme/widgets', description: null },
  ],
  beta: [{ name: 'tool', nameWithOwner: 'beta/tool', description: 'CLI helper' }],
};

/**
 * @param {Partial<import('../../types').PublicConfig['poll']>} [poll]
 * @param {Partial<import('../../types').PublicConfig['work_items']>} [workItems]
 * @returns {import('../../types').PublicConfig}
 */
function config(poll = {}, workItems = {}) {
  return {
    poll: { orgs: [], repos: [], interval_seconds: 30, ...poll },
    default_session_provider: 'claude',
    needs_setup: false,
    poll_configured: false,
    work_items: {
      configured: false,
      resolver: null,
      repositories: [],
      provider_setup: {
        claude: { model_login_command: 'claude auth login', resolver_mcp_commands: ['claude mcp add work-reference'] },
        codex: { model_login_command: 'codex login', resolver_mcp_commands: ['codex mcp add work-reference'] },
      },
      ...workItems,
    },
    manual_work: { configured: false, repositories: [] },
  };
}

/** @param {HTMLElement} element */
function asInput(element) {
  return /** @type {HTMLInputElement} */ (element);
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchSetupAccounts.mockResolvedValue({ accounts: ACCOUNTS });
  api.fetchSetupRepos.mockImplementation(async (account) => ({ repos: REPOS[account] ?? [] }));
  api.fetchConfig.mockResolvedValue(config());
  api.saveConfig.mockResolvedValue({ ok: true });
  api.fetchProviderCapabilities.mockResolvedValue({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  });
});

test('discovery preselects configured accounts, loads picked repos, and round-trips the saved config', async () => {
  const user = userEvent.setup();
  const onConfigured = vi.fn();
  api.fetchConfig.mockResolvedValue(config({ orgs: ['acme'], repos: ['beta/tool'], interval_seconds: 300 }));
  render(<SetupMode onConfigured={onConfigured} isFirstRun={false} />);

  assert.equal(asInput(await screen.findByRole('checkbox', { name: /acme/ })).checked, true);
  assert.equal(asInput(screen.getByRole('checkbox', { name: /beta/ })).checked, true);
  assert.equal(asInput(screen.getByRole('checkbox', { name: /gamma/ })).checked, false);
  assert.deepEqual(api.fetchSetupRepos.mock.calls, [['beta']]);
  assert.ok(screen.getByRole('heading', { name: 'Configure monitoring' }));
  assert.equal(
    screen.getByRole('link', { name: 'Work Items settings' }).getAttribute('href'),
    '#/setup?section=work-items',
  );

  await user.click(screen.getByRole('button', { name: 'Next' }));
  assert.deepEqual(
    screen.getAllByRole('button', { name: 'All repos' }).map((button) => button.getAttribute('aria-pressed')),
    ['true', 'false'],
  );
  assert.deepEqual(
    screen.getAllByRole('button', { name: 'Pick repos' }).map((button) => button.getAttribute('aria-pressed')),
    ['false', 'true'],
  );
  assert.equal(asInput(await screen.findByRole('checkbox', { name: /tool/ })).checked, true);
  assert.ok(screen.getByText('1 selected'));

  await user.click(screen.getByRole('button', { name: 'Next' }));
  assert.equal(screen.getByRole('button', { name: '5m' }).getAttribute('aria-pressed'), 'true');
  assert.equal(asInput(screen.getByRole('spinbutton')).value, '300');

  await user.click(screen.getByRole('button', { name: 'Save and start monitoring' }));
  await waitFor(() => assert.equal(onConfigured.mock.calls.length, 1));
  assert.deepEqual(api.saveConfig.mock.calls, [
    [{ poll: { orgs: ['acme'], repos: ['beta/tool'], interval_seconds: 300 } }],
  ]);
});

test('picking repos loads them on demand, filters by search, and a failed save keeps the wizard on settings', async () => {
  const user = userEvent.setup();
  const onConfigured = vi.fn();
  api.saveConfig.mockRejectedValueOnce(new Error('config.json is read-only')).mockResolvedValueOnce({ ok: true });
  render(<SetupMode onConfigured={onConfigured} isFirstRun={true} />);

  const next = /** @type {HTMLButtonElement} */ (await screen.findByRole('button', { name: 'Next' }));
  assert.ok(screen.getByRole('heading', { name: 'Set up monitoring' }));
  assert.equal(next.disabled, true);
  await user.click(screen.getByRole('checkbox', { name: /acme/ }));
  assert.equal(next.disabled, false);
  await user.click(next);
  assert.equal(api.fetchSetupRepos.mock.calls.length, 0, 'an "all repos" account never lists repositories');

  await user.click(screen.getByRole('button', { name: 'Pick repos' }));
  assert.deepEqual(api.fetchSetupRepos.mock.calls, [['acme']]);
  await user.click(await screen.findByRole('checkbox', { name: /widgets/ }));
  assert.ok(screen.getByText('1 selected'));
  await user.type(screen.getByRole('searchbox', { name: 'Search acme repositories' }), 'wid');
  assert.equal(screen.queryByRole('checkbox', { name: /api/ }), null);
  assert.equal(asInput(screen.getByRole('checkbox', { name: /widgets/ })).checked, true);

  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: '1m' }));
  await user.click(screen.getByRole('button', { name: 'Save and start monitoring' }));
  assert.ok(await screen.findByText('config.json is read-only'));
  assert.equal(onConfigured.mock.calls.length, 0);

  await user.click(screen.getByRole('button', { name: 'Save and start monitoring' }));
  await waitFor(() => assert.equal(onConfigured.mock.calls.length, 1));
  const expected = { poll: { orgs: [], repos: ['acme/widgets'], interval_seconds: 60 } };
  assert.deepEqual(api.saveConfig.mock.calls, [[expected], [expected]]);
});

test('a failed repository listing shows the error instead of an empty list', async () => {
  const user = userEvent.setup();
  api.fetchSetupRepos.mockRejectedValue(new Error('GitHub token lacks the repo scope'));
  render(<SetupMode onConfigured={vi.fn()} isFirstRun={true} />);

  await user.click(await screen.findByRole('checkbox', { name: /acme/ }));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Pick repos' }));

  const alert = await screen.findByRole('alert');
  assert.equal(alert.textContent, 'GitHub token lacks the repo scope');
  assert.equal(screen.queryByText('No repos found'), null);
  assert.equal(screen.queryByRole('status'), null, 'the loading indicator is gone');
});

test('Retry remounts the wizard and repeats discovery after a failure', async () => {
  const user = userEvent.setup();
  api.fetchSetupAccounts
    .mockRejectedValueOnce(new Error('gh auth status failed'))
    .mockResolvedValueOnce({ accounts: ACCOUNTS });
  render(<SetupMode onConfigured={vi.fn()} isFirstRun={true} />);

  assert.ok(await screen.findByText('gh auth status failed'));
  assert.equal(screen.queryByRole('checkbox'), null);
  await user.click(screen.getByRole('button', { name: 'Retry' }));

  assert.ok(await screen.findByRole('checkbox', { name: /acme/ }));
  assert.equal(api.fetchSetupAccounts.mock.calls.length, 2);
  assert.equal(api.fetchConfig.mock.calls.length, 2);
  assert.equal(screen.queryByText('gh auth status failed'), null);
});

test('the work_items section lists resolver facts, candidate repositories, and provider setup commands', async () => {
  const user = userEvent.setup();
  const written = /** @type {string[]} */ ([]);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (/** @type {string} */ text) => {
        written.push(text);
      },
    },
  });
  api.fetchConfig.mockResolvedValue(
    config(
      {},
      {
        configured: true,
        resolver: { provider_mode: 'fixed', provider: 'codex', server_name: 'work-reference' },
        repositories: ['acme/api', 'acme/widgets'],
      },
    ),
  );
  api.fetchProviderCapabilities.mockResolvedValue({
    claude: { available: true, checking: false, reason: null, version: 'claude 2.1.0', checkedAt: null },
    codex: {
      available: false,
      checking: false,
      reason: 'codex binary not found on PATH',
      version: null,
      checkedAt: null,
    },
  });
  render(<SetupMode onConfigured={vi.fn()} isFirstRun={false} section="work_items" />);

  assert.ok(await screen.findByRole('heading', { name: 'Work Items settings' }));
  assert.equal(api.fetchSetupAccounts.mock.calls.length, 0);
  assert.ok(await screen.findByText('Fixed provider'));
  assert.ok(screen.getByText('Configured'));
  assert.ok(screen.getByText('codex'));
  assert.ok(screen.getByText('work-reference'));
  assert.deepEqual(
    screen.getAllByRole('listitem').map((item) => item.textContent),
    ['acme/api', 'acme/widgets'],
  );
  assert.ok(screen.getByText('Available'));
  assert.ok(screen.getByText('Unavailable'));
  assert.ok(screen.getByText('claude 2.1.0'));
  assert.ok(screen.getByText('codex binary not found on PATH'));
  assert.ok(screen.getByText('codex mcp add work-reference'));
  const copyButtons = screen.getAllByRole('button', { name: 'Copy' });
  assert.equal(copyButtons.length, 4);

  await user.click(copyButtons[0]);
  assert.deepEqual(written, ['claude auth login']);
  assert.ok(await screen.findByRole('button', { name: 'Copied' }));
});
