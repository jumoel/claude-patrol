import styles from './AppShell.module.css';

/**
 * Top-level layout shell. Provides page structure, header, and content area.
 * @param {{ title: string, syncStatus: string, onSync: () => void, children: React.ReactNode }} props
 */
export function AppShell({ title, syncStatus, onSync, children }) {
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerInner}>
          <h1 className={styles.title}>{title}</h1>
          <div className={styles.syncArea}>
            <span className={styles.syncStatus}>{syncStatus}</span>
            <button className={styles.syncButton} onClick={onSync}>
              Sync now
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
