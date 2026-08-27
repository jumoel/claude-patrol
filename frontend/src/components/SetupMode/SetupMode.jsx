import { useCallback, useEffect, useState } from 'react';
import {
  fetchConfig,
  fetchProviderCapabilities,
  fetchSetupAccounts,
  fetchSetupRepos,
  saveConfig,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { Badge } from '../ui/Badge/Badge.jsx';
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

/**
 * Settings page header shared by every settings section.
 * @param {{ title: string, subtitle: string, children?: React.ReactNode }} props
 */
function SettingsHeader({ title, subtitle, children }) {
  return (
    <header className={styles.setupHeader}>
      <div className={styles.headerCopy}>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
      {children && <div className={styles.headerActions}>{children}</div>}
    </header>
  );
}

/**
 * Flat section shared by the Work Items settings panels.
 * @param {{ title: string, meta?: React.ReactNode, children: React.ReactNode }} props
 */
function SettingsSection({ title, meta, children }) {
  return (
    <section className={styles.settingsSection}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.panelTitle}>{title}</h3>
        {meta}
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
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
      <Stack direction="col" gap={4} className={styles.setupShell}>
        <LoadingIndicator className={styles.loadingText}>Discovering GitHub accounts...</LoadingIndicator>
      </Stack>
    );
  }

  if (error && accounts.length === 0) {
    return (
      <Stack direction="col" gap={4} className={styles.setupShell}>
        <div className={styles.errorCard}>
          <p className={styles.errorText}>{error}</p>
          <Button variant="primary" size="sm" filled onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </Stack>
    );
  }

  /** @type {Record<ConfigStep, string>} */
  const stepLabels = { accounts: 'Accounts', repos: 'Repos', settings: 'Settings' };
  /** @type {ConfigStep[]} */
  const stepKeys = ['accounts', 'repos', 'settings'];

  const currentStep = step === 'saving' ? 'settings' : step;
  const currentStepIndex = stepKeys.indexOf(currentStep);

  return (
    <div className={styles.setupShell}>
      <section className={styles.settingsFrame}>
        <SettingsHeader
          title={isFirstRun ? 'Set up monitoring' : 'Configure monitoring'}
          subtitle={
            step === 'accounts'
              ? 'Select which GitHub accounts to monitor for open PRs.'
              : step === 'repos'
                ? 'Choose all repos or pick specific ones per account.'
                : 'Configure how often to check for updates.'
          }
        >
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
        </SettingsHeader>

        <ol className={styles.stepper} aria-label="Monitoring setup progress">
          {stepKeys.map((key, i) => (
            <li
              key={key}
              className={`${styles.step} ${currentStep === key ? styles.stepActive : ''} ${currentStepIndex > i ? styles.stepDone : ''}`}
              aria-current={currentStep === key ? 'step' : undefined}
            >
              <span className={styles.stepNumber}>{currentStepIndex > i ? '\u2713' : i + 1}</span>
              <span className={styles.stepLabel}>{stepLabels[key]}</span>
            </li>
          ))}
        </ol>

        {error && <p className={styles.inlineError}>{error}</p>}

        {step === 'accounts' && (
          <div className={styles.wizardBody}>
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
                  <Badge color="gray" border={false} className={styles.accountBadge}>
                    {acc.type === 'user' ? 'personal' : 'org'}
                  </Badge>
                </Stack>
              ))}
            </div>
          </div>
        )}

        {step === 'repos' && (
          <div className={styles.wizardBody}>
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
                          <Button
                            size="xs"
                            className={`${styles.modeBtn} ${mode === 'all' ? styles.modeBtnActive : ''}`}
                            aria-pressed={mode === 'all'}
                            onClick={() => setMode(login, 'all')}
                          >
                            All repos
                          </Button>
                          <Button
                            size="xs"
                            className={`${styles.modeBtn} ${mode === 'pick' ? styles.modeBtnActive : ''}`}
                            aria-pressed={mode === 'pick'}
                            onClick={() => setMode(login, 'pick')}
                          >
                            Pick repos
                          </Button>
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
                                onChange={(event) =>
                                  setRepoQueries((prev) => ({ ...prev, [login]: event.target.value }))
                                }
                              />
                            </label>
                            <Badge color="gray" border={false} className={styles.selectionCount}>
                              {picked.size} selected
                            </Badge>
                          </div>
                          <div className={styles.repoList}>
                            {isLoadingRepos && (
                              <LoadingIndicator className={styles.loadingText}>Loading repos...</LoadingIndicator>
                            )}
                            {!isLoadingRepos && repos.length === 0 && (
                              <p className={styles.emptyText}>No repos found</p>
                            )}
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
          </div>
        )}

        {step === 'settings' && (
          <div className={`${styles.wizardBody} ${styles.settingsPanel}`}>
            <div className={styles.settingsContent}>
              <div className={styles.settingsHeader}>
                <label className={styles.settingsLabel}>Poll interval</label>
                <p className={styles.settingsHint}>How often claude-patrol checks GitHub for updates.</p>
              </div>
              <Stack gap={2} wrap className={styles.presets}>
                {INTERVAL_PRESETS.map((p) => (
                  <Button
                    key={p.value}
                    size="xs"
                    className={`${styles.presetBtn} ${interval === p.value ? styles.presetBtnActive : ''}`}
                    aria-pressed={interval === p.value}
                    onClick={() => setInterval_(p.value)}
                  >
                    {p.label}
                  </Button>
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
          </div>
        )}

        {step === 'saving' && (
          <div className={styles.wizardBody}>
            <LoadingIndicator className={styles.loadingText}>Saving configuration...</LoadingIndicator>
          </div>
        )}

        {step !== 'saving' && (
          <div className={styles.wizardFooter}>
            {step === 'repos' && (
              <Button size="sm" onClick={() => setStep('accounts')}>
                Back
              </Button>
            )}
            {step === 'settings' && (
              <Button size="sm" onClick={() => setStep('repos')}>
                Back
              </Button>
            )}
            {step === 'accounts' && (
              <Button
                variant="primary"
                size="sm"
                filled
                disabled={selectedCount === 0}
                onClick={() => setStep('repos')}
              >
                Next
              </Button>
            )}
            {step === 'repos' && (
              <Button variant="primary" size="sm" filled onClick={() => setStep('settings')}>
                Next
              </Button>
            )}
            {step === 'settings' && (
              <Button variant="primary" size="sm" filled onClick={handleSave}>
                Save and start monitoring
              </Button>
            )}
          </div>
        )}
      </section>
    </div>
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
    <div className={styles.setupShell}>
      <section className={styles.settingsFrame}>
        <SettingsHeader
          title="Work Items settings"
          subtitle="Reference resolution is managed by the instance configuration."
        >
          <Stack gap={2} wrap>
            <Button as="a" href="#/setup" size="sm">
              GitHub monitoring
            </Button>
            <Button as="a" href="#/" size="sm">
              Back to dashboard
            </Button>
          </Stack>
        </SettingsHeader>
        {error && (
          <div className={styles.inlineError}>
            <span>{error}</span>
            <Button size="sm" onClick={load}>
              Retry
            </Button>
          </div>
        )}
        {!error && (!config || !capabilities) && (
          <LoadingIndicator className={styles.loadingText}>Loading Work Items settings...</LoadingIndicator>
        )}
        {config && capabilities && (
          <div className={styles.settingsSections}>
            <SettingsSection title="Configuration">
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
            </SettingsSection>
            <SettingsSection title="Candidate repositories">
              {config.work_items.repositories.length > 0 ? (
                <ul className={styles.candidateList}>
                  {config.work_items.repositories.map((repository) => (
                    <li key={repository}>{repository}</li>
                  ))}
                </ul>
              ) : (
                <p className={styles.emptyText}>No candidate repositories configured</p>
              )}
            </SettingsSection>
            {['claude', 'codex'].map((provider) => {
              const typedProvider = /** @type {import('../../types').AgentProvider} */ (provider);
              const capability = capabilities[typedProvider];
              const setup = config.work_items.provider_setup[typedProvider];
              const commands = [setup.model_login_command, ...setup.resolver_mcp_commands];
              return (
                <SettingsSection
                  key={provider}
                  title={provider === 'codex' ? 'Codex' : 'Claude'}
                  meta={
                    <Badge
                      color={capability.checking ? 'blue' : capability.available ? 'green' : 'red'}
                      border={false}
                      pulse={capability.checking}
                    >
                      {capability.checking ? 'Checking' : capability.available ? 'Available' : 'Unavailable'}
                    </Badge>
                  }
                >
                  <Stack direction="col" gap={3}>
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
                </SettingsSection>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
