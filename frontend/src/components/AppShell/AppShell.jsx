import { useCallback, useEffect, useRef, useState } from 'react';
import logoSvg from '../../assets/logo.svg';
import { triggerRestart, triggerUpdate } from '../../lib/api.js';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './AppShell.module.css';

/**
 * Top-level layout shell. Provides page structure, header, and content area.
 */

function formatResetCountdown(resetAt) {
  if (!resetAt) return null;
  const ms = new Date(resetAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${h}h ${mm}m`;
  }
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

export function AppShell({
  title,
  syncTime,
  nextSync,
  syncing,
  onSync,
  terminalOpen,
  onToggleTerminal,
  onSetup,
  updateAvailable,
  commitsBehind,
  restartNeeded,
  startupSha,
  currentSha,
  ghRateLimit,
  children,
}) {
  const [dismissed, setDismissed] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullResult, setPullResult] = useState(null);
  const [restarting, setRestarting] = useState(false);
  const [restartPhase, setRestartPhase] = useState(null);
  const [, setNow] = useState(0);
  const headerRef = useRef(null);
  const showBanner = (updateAvailable || pullResult || restartNeeded) && !dismissed;
  const showRateLimit = !!ghRateLimit?.limited;

  // Tick once per second while rate-limited so the reset countdown updates.
  useEffect(() => {
    if (!showRateLimit || !ghRateLimit?.resetAt) return;
    const id = setInterval(() => setNow((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [showRateLimit, ghRateLimit?.resetAt]);

  const resetCountdown = showRateLimit ? formatResetCountdown(ghRateLimit?.resetAt) : null;

  // Publish header height as a CSS variable so maximized terminals can leave it visible.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty('--app-header-height', `${el.offsetHeight}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--app-header-height');
    };
  }, []);

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
    setRestartPhase('starting');
    try {
      await triggerRestart();
    } catch {
      // Server is already shutting down, request may fail - that's expected
    }
    // Poll restart status for phased progress, then detect server down/up for reload.
    let sawDown = false;
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/restart/status');
        if (res.ok) {
          const data = await res.json();
          if (data.phase) setRestartPhase(data.phase);
        } else {
          sawDown = true;
          setRestartPhase('restarting');
        }
      } catch {
        sawDown = true;
        setRestartPhase('restarting');
      }
      // Also check if server is back up after going down
      if (sawDown) {
        try {
          const configRes = await fetch('/api/config');
          if (configRes.ok) {
            clearInterval(poll);
            window.location.reload();
          }
        } catch {
          /* still down */
        }
      }
    }, 500);
    // Safety timeout - reload after 15s regardless
    setTimeout(() => {
      clearInterval(poll);
      window.location.reload();
    }, 15_000);
  }, []);

  return (
    <div className={styles.shell}>
      <header ref={headerRef} className={styles.header}>
        <div className={styles.headerInner}>
          <a href="#/" className={styles.brand}>
            <img src={logoSvg} alt="" className={styles.logo} />
            <h1 className={styles.title}>{title}</h1>
          </a>
          <Stack gap={3}>
            <span className={styles.syncStatus}>
              {syncTime}
              {nextSync && (
                <>
                  {' \u00b7 Next in '}
                  <span className={styles.countdown}>{nextSync}</span>
                </>
              )}
            </span>
            <button className={styles.syncButton} onClick={onSync} disabled={syncing}>
              {syncing ? (
                <span className={styles.spinner} />
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                  <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                </svg>
              )}
              {syncing ? 'Syncing...' : 'Sync now'}
            </button>
            <button
              className={`${styles.terminalButton} ${terminalOpen ? styles.terminalButtonActive : ''}`}
              onClick={onToggleTerminal}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="1" y="2" width="14" height="12" rx="2" />
                <polyline points="5,6 7.5,8.5 5,11" />
                <line x1="9" y1="11" x2="12" y2="11" />
              </svg>
              Global Claude
            </button>
            {onSetup && (
              <button className={styles.settingsButton} onClick={onSetup}>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
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
          </Stack>
        </div>
      </header>
      {showRateLimit && (
        <div className={styles.rateLimitBanner} role="alert">
          <div className={styles.rateLimitInner}>
            <Stack gap={2} as="span">
              <strong>GitHub rate limit hit.</strong>
              <span>
                {ghRateLimit?.message || 'gh API rate limit exceeded.'}
                {resetCountdown && (
                  <>
                    {' '}
                    Resets in <span className={styles.rateLimitCountdown}>{resetCountdown}</span>.
                  </>
                )}
              </span>
            </Stack>
          </div>
        </div>
      )}
      {showBanner && (
        <div className={`${styles.updateBanner} ${pullResult?.ok || restartNeeded ? styles.updateBannerSuccess : ''}`}>
          <div className={styles.updateBannerInner}>
            <Stack gap={2} as="span">
              {restarting ? (
                <>
                  {restartPhase === 'building'
                    ? 'Building frontend...'
                    : restartPhase === 'spawning'
                      ? 'Starting new server...'
                      : restartPhase === 'shutting_down'
                        ? 'Shutting down old server...'
                        : restartPhase === 'restarting'
                          ? 'Waiting for new server...'
                          : 'Restarting server...'}{' '}
                  <span className={styles.spinner} />
                </>
              ) : restartNeeded || pullResult?.ok ? (
                <>
                  New version ready ({startupSha} → {currentSha}). Terminal sessions will be preserved.
                  <Button variant="success" size="xs" onClick={handleRestart}>
                    Restart now
                  </Button>
                </>
              ) : pullResult?.ok === false ? (
                <>Pull failed: {pullResult.error}</>
              ) : (
                <>
                  Update available - {commitsBehind} new commit{commitsBehind !== 1 ? 's' : ''} on origin/main.
                  {!pulling && (
                    <Button variant="warning" size="xs" onClick={handlePull}>
                      Update now
                    </Button>
                  )}
                  {pulling && <span>Pulling...</span>}
                </>
              )}
            </Stack>
            {!restarting && (
              <button className={styles.updateDismiss} onClick={() => setDismissed(true)} title="Dismiss">
                ×
              </button>
            )}
          </div>
        </div>
      )}
      <main className={styles.content}>{children}</main>
    </div>
  );
}
