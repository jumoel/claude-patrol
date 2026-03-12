import styles from './AppShell.module.css';
import logoSvg from '../../assets/logo.svg';

/**
 * Top-level layout shell. Provides page structure, header, and content area.
 * @param {{ title: string, syncTime: string, nextSync: string, syncing: boolean, onSync: () => void, children: React.ReactNode }} props
 */
export function AppShell({ title, syncTime, nextSync, syncing, onSync, terminalOpen, onToggleTerminal, onSetup, children }) {
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
      <main className={styles.content}>
        {children}
      </main>
    </div>
  );
}
