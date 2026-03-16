import { useMemo, useState } from 'react';
import styles from './CheckLogViewer.module.css';

export function CheckLogViewer({ log, truncated, loading, error }) {
  const [search, setSearch] = useState('');

  const filteredLog = useMemo(() => {
    if (!log || !search.trim()) return log;
    const term = search.toLowerCase();
    return log
      .split('\n')
      .filter((line) => line.toLowerCase().includes(term))
      .join('\n');
  }, [log, search]);

  if (loading) {
    return (
      <div className={styles.container}>
        <p className={styles.loading}>Loading logs...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <p className={styles.error}>{error}</p>
      </div>
    );
  }

  if (!log) return null;

  const lineCount = filteredLog ? filteredLog.split('\n').length : 0;
  const totalLines = log.split('\n').length;

  return (
    <div className={styles.container}>
      {truncated && <p className={styles.truncated}>Log output was truncated (exceeds 20,000 characters)</p>}
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter log lines..."
        />
        {search && (
          <span className={styles.searchCount}>
            {lineCount} / {totalLines} lines
          </span>
        )}
      </div>
      <pre className={styles.log}>{filteredLog}</pre>
    </div>
  );
}
