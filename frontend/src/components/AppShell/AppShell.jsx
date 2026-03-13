import { useState, useCallback } from 'react';
import { triggerUpdate, triggerRestart } from '../../lib/api.js';
import styles from './AppShell.module.css';
import logoSvg from '../../assets/logo.svg';

/**
 * Top-level layout shell. Provides page structure, header, and content area.
 */
export function AppShell({ title, syncTime, nextSync, syncing, onSync, terminalOpen, onToggleTerminal, onSetup, updateAvailable, commitsBehind, restartNeeded, startupSha, currentSha, children }) {
  const [dismissed, setDismissed] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const showBanner = (updateAvailable || pullResult || restartNeeded) && !dismissed;

  const handlePull = async () => {
    setPulling(true);
    setPullResult(null);
    try {
      const result = await triggerUpdate();
      setPullResult({ ok: true, output: result.output });
    } catch (err) {
      setPullResult({ ok: false, error: err.message });
    } finally {
      setPulling(false);
    }
  };

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await triggerRestart();
    } catch {
      // Server is already shutting down, request may fail - that's expected
    }
    // Poll until the new server is up, then reload to pick up the new frontend bundle.
    // We wait for the server to go down first, then come back up.
    let sawDown = false;
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/config');
        if (res.ok) {
          if (sawDown) {
            // Server is back up after going down - restart complete
            clearInterval(poll);
            window.location.reload();
          }
        } else {
          sawDown = true;
        }
      } catch {
        sawDown = true;
      }
    }, 500);
    // Safety timeout - reload after 15s regardless
    setTimeout(() => { clearInterval(poll); window.location.reload(); }, 15_000);
  }, []);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <a href="#/" className={styles.brand}>
            <img src={logoSvg} alt="" className={styles.logo} />
            <h1 className={styles.title}>{title}</h1>
          </a>
          <div className={styles.syncArea}>
            <span className={styles.syncStatus}>
              {syncTime}
              {nextSync && (
                <>
                  {' \u00b7 Next in '}
                  <span className={styles.countdown}>{nextSync}</span>
                </>
              )}
            </span>
            <button
              className={styles.syncButton}
              onClick={onSync}
              disabled={syncing}
            >
              {syncing ? (
                <span className={styles.spinner} />
              ) : (
                'Sync now'
              )}
            </button>
            <button
              className={`${styles.terminalButton} ${terminalOpen ? styles.terminalButtonActive : ''}`}
              onClick={onToggleTerminal}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="1" y="2" width="14" height="12" rx="2" />
                <polyline points="5,6 7.5,8.5 5,11" />
                <line x1="9" y1="11" x2="12" y2="11" />
              </svg>
              Global Claude
            </button>
            {onSetup && (
              <button className={styles.settingsButton} onClick={onSetup}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="21" x2="4" y2="17" />
                  <line x1="4" y1="9" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="15" />
                  <line x1="12" y1="7" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="19" />
                  <line x1="20" y1="11" x2="20" y2="3" />
                  <circle cx="4" cy="13" r="3" />
                  <circle cx="12" cy="11" r="3" />
                  <circle cx="20" cy="15" r="3" />
                </svg>
                Settings
              </button>
            )}
          </div>
        </div>
      </header>
      {showBanner && (
        <div className={`${styles.updateBanner} ${(pullResult?.ok || restartNeeded) ? styles.updateBannerSuccess : ''}`}>
          <div className={styles.updateBannerInner}>
            <span className={styles.updateText}>
              {restarting ? (
                <>Restarting server... <span className={styles.spinner} /></>
              ) : (restartNeeded || pullResult?.ok) ? (
                <>
                  New version ready ({startupSha} → {currentSha}). Terminal sessions will be preserved.
                  <button className={styles.updateRestartBtn} onClick={handleRestart}>
                    Restart now
                  </button>
                </>
              ) : pullResult?.ok === false ? (
                <>Pull failed: {pullResult.error}</>
              ) : (
                <>
                  Update available - {commitsBehind} new commit{commitsBehind !== 1 ? 's' : ''} on origin/main.
                  {!pulling && (
                    <button className={styles.updatePullBtn} onClick={handlePull}>
                      Update now
                    </button>
                  )}
                  {pulling && <span>Pulling...</span>}
                </>
              )}
            </span>
            {!restarting && (
              <button className={styles.updateDismiss} onClick={() => setDismissed(true)} title="Dismiss">
                ×
              </button>
            )}
          </div>
        </div>
      )}
      <main className={styles.content}>
        {children}
      </main>
    </div>
  );
}
