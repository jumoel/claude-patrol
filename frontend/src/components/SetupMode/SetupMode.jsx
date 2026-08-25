import { useCallback, useEffect, useState } from 'react';
import {
  fetchConfig,
  fetchProviderCapabilities,
  fetchSetupAccounts,
  fetchSetupRepos,
  saveConfig,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './SetupMode.module.css';

/** @typedef {'accounts' | 'repos' | 'settings' | 'saving'} SetupStep */
/** @typedef {'all' | 'pick'} AccountMode */
/** @typedef {'accounts' | 'repos' | 'settings'} ConfigStep */

const INTERVAL_PRESETS = [
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '2m', value: 120 },
  { label: '5m', value: 300 },
  { label: '10m', value: 600 },
  { label: '30m', value: 1800 },
];

/**
 * Setup wizard for configuring poll targets.
 * Steps: accounts -> repos -> settings -> save.
 * @param {{ onConfigured: () => void, isFirstRun: boolean, section?: 'poll' | 'work_items' }} props
 */
export function SetupMode({ onConfigured, isFirstRun, section = 'poll' }) {
  if (section === 'work_items') return <WorkItemsSettings />;
  return <PollSetupMode onConfigured={onConfigured} isFirstRun={isFirstRun} />;
}

/** @param {{ onConfigured: () => void, isFirstRun: boolean }} props */
function PollSetupMode({ onConfigured, isFirstRun }) {
  const [step, setStep] = useState(/** @type {SetupStep} */ ('accounts'));
  const [accounts, setAccounts] = useState(/** @type {import('../../types').SetupAccount[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string | null} */ (null));

  const [accountModes, setAccountModes] = useState(/** @type {Record<string, AccountMode>} */ ({}));
  const [repoLists, setRepoLists] = useState(/** @type {Record<string, import('../../types').SetupRepo[]>} */ ({}));
  const [repoLoading, setRepoLoading] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [selectedRepos, setSelectedRepos] = useState(/** @type {Record<string, Set<string>>} */ ({}));
  const [repoQueries, setRepoQueries] = useState(/** @type {Record<string, string>} */ ({}));
  const [interval, setInterval_] = useState(30);
  const [_existingConfig, setExistingConfig] = useState(
    /** @type {import('../../types').PublicConfig['poll'] | null} */ (null),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError(null);
        const [accountsData, configData] = await Promise.all([fetchSetupAccounts(), fetchConfig()]);
        if (cancelled) return;
        setAccounts(accountsData.accounts);
        setExistingConfig(configData.poll);

        /** @type {Record<string, AccountMode>} */
        const modes = {};
        /** @type {Record<string, Set<string>>} */
        const repos = {};
        for (const acc of accountsData.accounts) {
          if (configData.poll.orgs.includes(acc.login)) {
            modes[acc.login] = 'all';
          }
        }
        for (const repo of configData.poll.repos) {
          const owner = repo.split('/')[0];
          if (!modes[owner]) modes[owner] = 'pick';
          if (!repos[owner]) repos[owner] = new Set();
          repos[owner].add(repo);
        }
        if (configData.poll.interval_seconds) {
          setInterval_(configData.poll.interval_seconds);
        }
        setAccountModes(modes);
        /** @type {Record<string, Set<string>>} */
        const repoMap = {};
        for (const [k, v] of Object.entries(repos)) {
          repoMap[k] = v;
        }
        setSelectedRepos(repoMap);

        const pickAccounts = Object.entries(modes)
          .filter(([, m]) => m === 'pick')
          .map(([k]) => k);
        if (pickAccounts.length > 0) {
          setRepoLoading((prev) => {
            const next = { ...prev };
            for (const a of pickAccounts) next[a] = true;
            return next;
          });
        }
        for (const account of pickAccounts) {
          fetchSetupRepos(account)
            .then((data) => {
              if (!cancelled) setRepoLists((prev) => ({ ...prev, [account]: data.repos }));
            })
            .catch(() => {})
            .finally(() => {
              if (!cancelled) setRepoLoading((prev) => ({ ...prev, [account]: false }));
            });
        }
      } catch (err) {
        if (!cancelled) setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleAccount = useCallback(
    /** @param {string} login */ (login) => {
      setAccountModes((prev) => {
        const next = { ...prev };
        if (next[login]) {
          delete next[login];
        } else {
          next[login] = 'all';
        }
        return next;
      });
    },
    [],
  );

  const setMode = useCallback(
    /** @param {string} login @param {AccountMode} mode */
    (login, mode) => {
      setAccountModes((prev) => ({ ...prev, [login]: mode }));
      if (mode === 'pick' && !repoLists[login]) {
        setRepoLoading((prev) => ({ ...prev, [login]: true }));
        fetchSetupRepos(login)
          .then((data) => {
            setRepoLists((prev) => ({ ...prev, [login]: data.repos }));
          })
          .catch(() => {})
          .finally(() => {
            setRepoLoading((prev) => ({ ...prev, [login]: false }));
          });
      }
    },
    [repoLists],
  );

  const toggleRepo = useCallback(
    /** @param {string} account @param {string} repoName */ (account, repoName) => {
      setSelectedRepos((prev) => {
        const set = new Set(prev[account] || []);
        if (set.has(repoName)) {
          set.delete(repoName);
        } else {
          set.add(repoName);
        }
        return { ...prev, [account]: set };
      });
    },
    [],
  );

  const selectedCount = Object.keys(accountModes).filter((k) => accountModes[k]).length;

  const handleSave = useCallback(async () => {
    setStep('saving');
    /** @type {string[]} */
    const orgs = [];
    /** @type {string[]} */
    const repos = [];
    for (const [login, mode] of Object.entries(accountModes)) {
      if (!mode) continue;
      if (mode === 'all') {
        orgs.push(login);
      } else if (mode === 'pick') {
        const picked = selectedRepos[login];
        if (picked) {
          for (const r of picked) repos.push(r);
        }
      }
    }
    try {
      await saveConfig({
        poll: {
          orgs,
          repos,
          interval_seconds: interval,
        },
      });
      onConfigured();
    } catch (err) {
      setError(getErrorMessage(err));
      setStep('settings');
    }
  }, [accountModes, selectedRepos, interval, onConfigured]);

  if (loading) {
    return (
      <Stack direction="col" gap={4}>
        <LoadingIndicator className={styles.loadingText}>Discovering GitHub accounts...</LoadingIndicator>
      </Stack>
    );
  }

  if (error && accounts.length === 0) {
    return (
      <Stack direction="col" gap={4}>
        <Box p={6} border borderColor="red-200" rounded="lg" bg="white" className={styles.errorCard}>
          <p className={styles.errorText}>{error}</p>
          <Button variant="primary" size="sm" filled onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Box>
      </Stack>
    );
  }

  /** @type {Record<ConfigStep, string>} */
  const stepLabels = { accounts: 'Accounts', repos: 'Repos', settings: 'Settings' };
  /** @type {ConfigStep[]} */
  const stepKeys = ['accounts', 'repos', 'settings'];

  return (
    <Stack direction="col" gap={4} className={styles.setupShell}>
      <Stack gap={4} align="baseline" justify="between" wrap className={styles.setupHeader}>
        <div>
          <h2 className={styles.title}>{isFirstRun ? 'Set up monitoring' : 'Configure monitoring'}</h2>
          <p className={styles.subtitle}>
            {step === 'accounts' && 'Select which GitHub accounts to monitor for open PRs.'}
            {step === 'repos' && 'Choose all repos or pick specific ones per account.'}
            {step === 'settings' && 'Configure how often to check for updates.'}
          </p>
        </div>
        {!isFirstRun && step === 'accounts' && (
          <Stack gap={2} wrap>
            <Button as="a" href="#/setup?section=work-items" size="sm">
              Work Items settings
            </Button>
            <Button
              size="sm"
              onClick={() => {
                window.location.hash = '';
              }}
            >
              Back to dashboard
            </Button>
          </Stack>
        )}
      </Stack>

      <div className={styles.stepper}>
        {stepKeys.map((key, i) => (
          <Stack
            gap={2}
            key={key}
            className={`${styles.step} ${step === key ? styles.stepActive : ''} ${stepKeys.indexOf(step === 'saving' ? 'settings' : step) > i ? styles.stepDone : ''}`}
          >
            <span className={styles.stepNumber}>{i + 1}</span>
            <span className={styles.stepLabel}>{stepLabels[key]}</span>
          </Stack>
        ))}
      </div>

      {error && <p className={styles.inlineError}>{error}</p>}

      {step === 'accounts' && (
        <div className={styles.wizardPanel}>
          <div className={styles.list}>
            {accounts.map((acc) => (
              <Stack
                gap={3}
                as="label"
                key={acc.login}
                className={`${styles.accountRow} ${accountModes[acc.login] ? styles.accountRowSelected : ''}`}
              >
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={!!accountModes[acc.login]}
                  onChange={() => toggleAccount(acc.login)}
                />
                <img src={acc.avatar_url} alt="" className={styles.avatar} />
                <span className={styles.accountName}>{acc.login}</span>
                <span className={styles.badge}>{acc.type === 'user' ? 'personal' : 'org'}</span>
              </Stack>
            ))}
          </div>
          <div className={styles.wizardFooter}>
            <Button variant="primary" size="sm" filled disabled={selectedCount === 0} onClick={() => setStep('repos')}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 'repos' && (
        <div className={styles.wizardPanel}>
          <div className={styles.list}>
            {accounts
              .filter((acc) => accountModes[acc.login])
              .map((acc) => {
                const { login } = acc;
                const mode = accountModes[login];
                const repos = repoLists[login] || [];
                const isLoadingRepos = repoLoading[login];
                const picked = selectedRepos[login] || new Set();
                const query = repoQueries[login]?.trim().toLowerCase() || '';
                const visibleRepos = query
                  ? repos.filter(
                      (repo) =>
                        repo.name.toLowerCase().includes(query) ||
                        repo.nameWithOwner.toLowerCase().includes(query) ||
                        repo.description?.toLowerCase().includes(query),
                    )
                  : repos;

                return (
                  <div key={login} className={styles.repoSection}>
                    <div className={styles.repoSectionHeader}>
                      <img src={acc?.avatar_url} alt="" className={styles.avatarSmall} />
                      <span className={styles.accountName}>{login}</span>
                      <div className={styles.modeToggle}>
                        <button
                          className={`${styles.modeBtn} ${mode === 'all' ? styles.modeBtnActive : ''}`}
                          onClick={() => setMode(login, 'all')}
                        >
                          All repos
                        </button>
                        <button
                          className={`${styles.modeBtn} ${mode === 'pick' ? styles.modeBtnActive : ''}`}
                          onClick={() => setMode(login, 'pick')}
                        >
                          Pick repos
                        </button>
                      </div>
                    </div>
                    {mode === 'pick' && (
                      <>
                        <div className={styles.repoTools}>
                          <label className={styles.searchField}>
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              aria-hidden="true"
                            >
                              <circle cx="7" cy="7" r="4.5" />
                              <path d="m10.5 10.5 3 3" />
                            </svg>
                            <span className={styles.srOnly}>Search {login} repositories</span>
                            <input
                              className={styles.searchInput}
                              type="search"
                              value={repoQueries[login] || ''}
                              placeholder="Search repositories"
                              onChange={(event) => setRepoQueries((prev) => ({ ...prev, [login]: event.target.value }))}
                            />
                          </label>
                          <span className={styles.selectionCount}>{picked.size} selected</span>
                        </div>
                        <div className={styles.repoList}>
                          {isLoadingRepos && (
                            <LoadingIndicator className={styles.loadingText}>Loading repos...</LoadingIndicator>
                          )}
                          {!isLoadingRepos && repos.length === 0 && <p className={styles.emptyText}>No repos found</p>}
                          {!isLoadingRepos && repos.length > 0 && visibleRepos.length === 0 && (
                            <p className={styles.emptyText}>No repositories match "{repoQueries[login]}"</p>
                          )}
                          {visibleRepos.map((repo) => (
                            <Stack
                              gap={3}
                              as="label"
                              key={repo.nameWithOwner}
                              className={`${styles.repoRow} ${picked.has(repo.nameWithOwner) ? styles.repoRowSelected : ''}`}
                            >
                              <input
                                type="checkbox"
                                className={styles.checkbox}
                                checked={picked.has(repo.nameWithOwner)}
                                onChange={() => toggleRepo(login, repo.nameWithOwner)}
                              />
                              <span className={styles.repoName}>{repo.name}</span>
                              {repo.description && <span className={styles.repoDesc}>{repo.description}</span>}
                            </Stack>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
          </div>
          <div className={styles.wizardFooter}>
            <Button size="sm" onClick={() => setStep('accounts')}>
              Back
            </Button>
            <Button variant="primary" size="sm" filled onClick={() => setStep('settings')}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 'settings' && (
        <div className={`${styles.wizardPanel} ${styles.settingsPanel}`}>
          <div className={styles.settingsContent}>
            <div className={styles.settingsHeader}>
              <label className={styles.settingsLabel}>Poll interval</label>
              <p className={styles.settingsHint}>How often claude-patrol checks GitHub for updates.</p>
            </div>
            <Stack gap={2} wrap className={styles.presets}>
              {INTERVAL_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`${styles.presetBtn} ${interval === p.value ? styles.presetBtnActive : ''}`}
                  onClick={() => setInterval_(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </Stack>
            <Stack gap={2}>
              <span className={styles.customLabel}>or custom:</span>
              <input
                type="number"
                min="5"
                max="3600"
                value={interval}
                onChange={(e) => setInterval_(Math.max(5, Number(e.target.value) || 30))}
                className={styles.numberInput}
              />
              <span className={styles.intervalUnit}>seconds</span>
            </Stack>
          </div>
          <div className={styles.wizardFooter}>
            <Button size="sm" onClick={() => setStep('repos')}>
              Back
            </Button>
            <Button variant="primary" size="sm" filled onClick={handleSave}>
              Save and start monitoring
            </Button>
          </div>
        </div>
      )}

      {step === 'saving' && <LoadingIndicator className={styles.loadingText}>Saving configuration...</LoadingIndicator>}
    </Stack>
  );
}

function WorkItemsSettings() {
  const [config, setConfig] = useState(/** @type {import('../../types').PublicConfig | null} */ (null));
  const [capabilities, setCapabilities] = useState(
    /** @type {Record<import('../../types').AgentProvider, import('../../types').ProviderCapability> | null} */ (null),
  );
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');

  const load = useCallback(() => {
    setError('');
    Promise.all([fetchConfig(), fetchProviderCapabilities()])
      .then(([nextConfig, nextCapabilities]) => {
        setConfig(nextConfig);
        setCapabilities(nextCapabilities);
      })
      .catch((nextError) => setError(getErrorMessage(nextError, 'Failed to load Work Items settings')));
  }, []);

  useEffect(load, [load]);

  /** @param {string} command */
  const copy = (command) => {
    navigator.clipboard.writeText(command).then(() => {
      setCopied(command);
      setTimeout(() => setCopied(''), 1500);
    });
  };

  return (
    <Stack direction="col" gap={4} className={styles.setupShell}>
      <Stack justify="between" gap={3} wrap className={styles.setupHeader}>
        <div>
          <h2 className={styles.title}>Work Items settings</h2>
          <p className={styles.subtitle}>Reference resolution is managed by the instance configuration.</p>
        </div>
        <Stack gap={2} wrap>
          <Button as="a" href="#/setup" size="sm">
            GitHub monitoring
          </Button>
          <Button as="a" href="#/" size="sm">
            Back to dashboard
          </Button>
        </Stack>
      </Stack>
      {error && (
        <Box p={5} border borderColor="red-200" rounded="lg" bg="white">
          <p className={styles.inlineError}>{error}</p>
          <Button size="sm" onClick={load}>
            Retry
          </Button>
        </Box>
      )}
      {!error && (!config || !capabilities) && (
        <LoadingIndicator className={styles.loadingText}>Loading Work Items settings...</LoadingIndicator>
      )}
      {config && capabilities && (
        <Stack direction="col" gap={4}>
          <Box p={5} border rounded="lg" bg="white">
            <dl className={styles.workItemFacts}>
              <div>
                <dt>Status</dt>
                <dd>{config.work_items.configured ? 'Configured' : 'Not configured'}</dd>
              </div>
              <div>
                <dt>Resolver mode</dt>
                <dd>
                  {!config.work_items.configured
                    ? 'Not configured'
                    : config.work_items.resolver?.provider_mode === 'fixed'
                      ? 'Fixed provider'
                      : 'Requested work provider'}
                </dd>
              </div>
              <div>
                <dt>Resolver provider</dt>
                <dd>
                  {!config.work_items.configured
                    ? 'Not configured'
                    : config.work_items.resolver?.provider || 'Selected per work item'}
                </dd>
              </div>
              <div>
                <dt>MCP server</dt>
                <dd>{config.work_items.resolver?.server_name || 'Not configured'}</dd>
              </div>
            </dl>
          </Box>
          <Box p={5} border rounded="lg" bg="white">
            <h3 className={styles.panelTitle}>Candidate repositories</h3>
            {config.work_items.repositories.length > 0 ? (
              <ul className={styles.candidateList}>
                {config.work_items.repositories.map((repository) => (
                  <li key={repository}>{repository}</li>
                ))}
              </ul>
            ) : (
              <p className={styles.emptyText}>No candidate repositories configured</p>
            )}
          </Box>
          {['claude', 'codex'].map((provider) => {
            const typedProvider = /** @type {import('../../types').AgentProvider} */ (provider);
            const capability = capabilities[typedProvider];
            const setup = config.work_items.provider_setup[typedProvider];
            const commands = [setup.model_login_command, ...setup.resolver_mcp_commands];
            return (
              <Box key={provider} p={5} border rounded="lg" bg="white">
                <Stack direction="col" gap={3}>
                  <Stack justify="between" gap={3} wrap>
                    <h3 className={styles.panelTitle}>{provider === 'codex' ? 'Codex' : 'Claude'}</h3>
                    <span className={capability.available ? styles.capabilityAvailable : styles.capabilityUnavailable}>
                      {capability.checking ? 'Checking' : capability.available ? 'Available' : 'Unavailable'}
                    </span>
                  </Stack>
                  {capability.version && <p className={styles.capabilityDetail}>{capability.version}</p>}
                  {capability.reason && <p className={styles.capabilityDetail}>{capability.reason}</p>}
                  <p className={styles.capabilityDetail}>
                    Capability checks do not prove MCP authentication. A resolver call does.
                  </p>
                  <div className={styles.commandList}>
                    {commands.map((command) => (
                      <div key={command} className={styles.commandRow}>
                        <code>{command}</code>
                        <Button size="xs" onClick={() => copy(command)}>
                          {copied === command ? 'Copied' : 'Copy'}
                        </Button>
                      </div>
                    ))}
                  </div>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
