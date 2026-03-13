import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchAllRepos } from '../../../lib/api.js';
import styles from './RepoCombobox.module.css';

/**
 * Filterable repo selector. Fetches all repos from configured orgs on first open.
 * @param {{ value: string, onChange: (repo: string) => void, disabled?: boolean, variant?: 'light' | 'dark' }} props
 */
export function RepoCombobox({ value, onChange, disabled = false, variant = 'light' }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Fetch repos on first open
  useEffect(() => {
    if (!open || loaded) return;
    setLoading(true);
    fetchAllRepos()
      .then(({ repos }) => {
        setRepos(repos);
        setLoaded(true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, loaded]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = repos.filter(r =>
    r.toLowerCase().includes(query.toLowerCase())
  );

  // Keep highlighted index in bounds
  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[highlighted];
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  const select = useCallback((repo) => {
    onChange(repo);
    setOpen(false);
    setQuery('');
  }, [onChange]);

  const handleKeyDown = useCallback((e) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlighted(h => Math.min(h + 1, filtered.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlighted(h => Math.max(h - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filtered[highlighted]) select(filtered[highlighted]);
        break;
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        setQuery('');
        break;
    }
  }, [open, filtered, highlighted, select]);

  const isDark = variant === 'dark';

  return (
    <div className={styles.container} ref={containerRef}>
      <div
        className={`${styles.trigger} ${isDark ? styles.triggerDark : styles.triggerLight} ${disabled ? styles.disabled : ''}`}
        onClick={() => { if (!disabled) { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); } }}
      >
        {value || <span className={styles.placeholder}>Select repo...</span>}
        <svg className={styles.chevron} width="10" height="6" viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1 1L5 5L9 1" />
        </svg>
      </div>
      {open && (
        <div className={`${styles.dropdown} ${isDark ? styles.dropdownDark : styles.dropdownLight}`}>
          <input
            ref={inputRef}
            className={`${styles.searchInput} ${isDark ? styles.searchInputDark : styles.searchInputLight}`}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Filter repos..."
            autoFocus
          />
          <div className={styles.list} ref={listRef}>
            {loading && <div className={styles.status}>Loading repos...</div>}
            {!loading && filtered.length === 0 && <div className={styles.status}>No matches</div>}
            {filtered.map((repo, i) => (
              <div
                key={repo}
                className={`${styles.item} ${i === highlighted ? styles.itemHighlighted : ''} ${repo === value ? styles.itemSelected : ''}`}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => select(repo)}
              >
                {repo}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
