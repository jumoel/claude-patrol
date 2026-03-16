import { useCallback, useEffect, useState } from 'react';
import { fetchConfig, fetchSetupAccounts, fetchSetupRepos, saveConfig } from '../../lib/api.js';
import styles from './SetupMode.module.css';

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
 * @param {{ onConfigured: () => void, isFirstRun: boolean }} props
 */
export function SetupMode({ onConfigured, isFirstRun }) {
  const [step, setStep] = useState('accounts');
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [accountModes, setAccountModes] = useState({});
  const [repoLists, setRepoLists] = useState({});
  const [repoLoading, setRepoLoading] = useState({});
  const [selectedRepos, setSelectedRepos] = useState({});
  const [interval, setInterval_] = useState(30);
  const [_existingConfig, setExistingConfig] = useState(null);

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

        const modes = {};
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
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleAccount = useCallback((login) => {
    setAccountModes((prev) => {
      const next = { ...prev };
      if (next[login]) {
        delete next[login];
      } else {
        next[login] = 'all';
      }
      return next;
    });
  }, []);

  const setMode = useCallback(
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

  const toggleRepo = useCallback((account, repoName) => {
    setSelectedRepos((prev) => {
      const set = new Set(prev[account] || []);
      if (set.has(repoName)) {
        set.delete(repoName);
      } else {
        set.add(repoName);
      }
      return { ...prev, [account]: set };
    });
  }, []);

  const selectedCount = Object.keys(accountModes).filter((k) => accountModes[k]).length;

  const handleSave = useCallback(async () => {
    setStep('saving');
    const orgs = [];
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
      setError(err.message);
      setStep('settings');
    }
  }, [accountModes, selectedRepos, interval, onConfigured]);

  if (loading) {
    return (
      <div className={styles.container}>
        <p className={styles.loadingText}>Discovering GitHub accounts...</p>
      </div>
    );
  }

  if (error && accounts.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.errorCard}>
          <p className={styles.errorText}>{error}</p>
          <button className={styles.retryBtn} onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  const stepLabels = { accounts: 'Accounts', repos: 'Repos', settings: 'Settings' };
  const stepKeys = ['accounts', 'repos', 'settings'];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{isFirstRun ? 'Set up monitoring' : 'Configure monitoring'}</h2>
          <p className={styles.subtitle}>
            {step === 'accounts' && 'Select which GitHub accounts to monitor for open PRs.'}
            {step === 'repos' && 'Choose all repos or pick specific ones per account.'}
            {step === 'settings' && 'Configure how often to check for updates.'}
          </p>
        </div>
        {!isFirstRun && step === 'accounts' && (
          <button
            className={styles.backBtn}
            onClick={() => {
              window.location.hash = '';
            }}
          >
            Back to dashboard
          </button>
        )}
      </div>

      <div className={styles.steps}>
        {stepKeys.map((key, i) => (
          <div
            key={key}
            className={`${styles.step} ${step === key ? styles.stepActive : ''} ${stepKeys.indexOf(step) > i ? styles.stepDone : ''}`}
          >
            <span className={styles.stepNumber}>{i + 1}</span>
            <span className={styles.stepLabel}>{stepLabels[key]}</span>
          </div>
        ))}
      </div>

      {error && <p className={styles.inlineError}>{error}</p>}

      {step === 'accounts' && (
        <>
          <div className={styles.list}>
            {accounts.map((acc) => (
              <label key={acc.login} className={styles.accountRow}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={!!accountModes[acc.login]}
                  onChange={() => toggleAccount(acc.login)}
                />
                <img src={acc.avatar_url} alt="" className={styles.avatar} />
                <span className={styles.accountName}>{acc.login}</span>
                <span className={styles.badge}>{acc.type === 'user' ? 'personal' : 'org'}</span>
              </label>
            ))}
          </div>
          <div className={styles.actions}>
            <button className={styles.primaryBtn} disabled={selectedCount === 0} onClick={() => setStep('repos')}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 'repos' && (
        <>
          <div className={styles.list}>
            {accounts
              .filter((acc) => accountModes[acc.login])
              .map((acc) => {
                const { login } = acc;
                const mode = accountModes[login];
                const repos = repoLists[login] || [];
                const isLoadingRepos = repoLoading[login];
                const picked = selectedRepos[login] || new Set();

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
                      <div className={styles.repoList}>
                        {isLoadingRepos && <p className={styles.loadingText}>Loading repos...</p>}
                        {!isLoadingRepos && repos.length === 0 && <p className={styles.emptyText}>No repos found</p>}
                        {repos.map((repo) => (
                          <label key={repo.nameWithOwner} className={styles.repoRow}>
                            <input
                              type="checkbox"
                              className={styles.checkbox}
                              checked={picked.has(repo.nameWithOwner)}
                              onChange={() => toggleRepo(login, repo.nameWithOwner)}
                            />
                            <span className={styles.repoName}>{repo.name}</span>
                            {repo.description && <span className={styles.repoDesc}>{repo.description}</span>}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
          <div className={styles.actions}>
            <button className={styles.secondaryBtn} onClick={() => setStep('accounts')}>
              Back
            </button>
            <button className={styles.primaryBtn} onClick={() => setStep('settings')}>
              Next
            </button>
          </div>
        </>
      )}

      {step === 'settings' && (
        <>
          <div className={styles.settingsCard}>
            <label className={styles.settingsLabel}>Poll interval</label>
            <p className={styles.settingsHint}>How often claude-patrol checks GitHub for updates.</p>
            <div className={styles.presets}>
              {INTERVAL_PRESETS.map((p) => (
                <button
                  key={p.value}
                  className={`${styles.presetBtn} ${interval === p.value ? styles.presetBtnActive : ''}`}
                  onClick={() => setInterval_(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className={styles.customInterval}>
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
            </div>
          </div>
          <div className={styles.actions}>
            <button className={styles.secondaryBtn} onClick={() => setStep('repos')}>
              Back
            </button>
            <button className={styles.primaryBtn} onClick={handleSave}>
              Save and start monitoring
            </button>
          </div>
        </>
      )}

      {step === 'saving' && <p className={styles.loadingText}>Saving configuration...</p>}
    </div>
  );
}
