import styles from './AppShell.module.css';
import logoSvg from '../../assets/logo.svg';

/**
 * Top-level layout shell. Provides page structure, header, and content area.
 * @param {{ title: string, syncTime: string, nextSync: string, syncing: boolean, onSync: () => void, children: React.ReactNode }} props
 */
export function AppShell({ title, syncTime, nextSync, syncing, onSync, terminalOpen, onToggleTerminal, children }) {
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
          </div>
        </div>
      </header>
      <main className={styles.content}>
        {children}
      </main>
    </div>
  );
}
