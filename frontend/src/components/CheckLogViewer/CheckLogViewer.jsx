import styles from './CheckLogViewer.module.css';

export function CheckLogViewer({ log, truncated, loading, error }) {
  if (loading) {
    return <div className={styles.container}><p className={styles.loading}>Loading logs...</p></div>;
  }

  if (error) {
    return <div className={styles.container}><p className={styles.error}>{error}</p></div>;
  }

  if (!log) return null;

  return (
    <div className={styles.container}>
      {truncated && (
        <p className={styles.truncated}>Log output was truncated (exceeds 20,000 characters)</p>
      )}
      <pre className={styles.log}>{log}</pre>
    </div>
  );
}
