import styles from './AppShell.module.css';
import logoSvg from '../../assets/logo.svg';

/**
 * Top-level layout shell. Provides page structure, header, and content area.
 * @param {{ title: string, syncTime: string, nextSync: string, syncing: boolean, onSync: () => void, children: React.ReactNode }} props
 */
export function AppShell({ title, syncTime, nextSync, syncing, onSync, children }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <div className={styles.brand}>
            <img src={logoSvg} alt="" className={styles.logo} />
            <h1 className={styles.title}>{title}</h1>
          </div>
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
          </div>
        </div>
      </header>
      <main className={styles.content}>
        {children}
      </main>
    </div>
  );
}
