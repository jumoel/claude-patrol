import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useClickOutside } from '../../../hooks/useClickOutside.js';
import { fetchAllRepos } from '../../../lib/api.js';
import { FloatingPanel } from '../FloatingPanel/FloatingPanel.jsx';
import styles from './RepoCombobox.module.css';

/**
 * Filterable repo selector. Fetches all repos from configured orgs on first open.
 * @param {{ value: string, onChange: (repo: string) => void, disabled?: boolean, variant?: 'light' | 'dark', ariaLabel?: string, ariaLabelledBy?: string }} props
 */
export function RepoCombobox({
  value,
  onChange,
  disabled = false,
  variant = 'light',
  ariaLabel = 'Repository',
  ariaLabelledBy,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState(/** @type {string[]} */ ([]));
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const dropdownLayerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const triggerRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const inputRef = useRef(/** @type {HTMLInputElement | null} */ (null));
  const listRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const listboxId = useId();
  const valueId = `${listboxId}-value`;

  const loadRepositories = useCallback(() => {
    setLoading(true);
    setError('');
    fetchAllRepos()
      .then(({ repos }) => {
        setRepos(repos);
        setHighlighted(0);
        setLoaded(true);
      })
      .catch(() => setError('Failed to load repositories'))
      .finally(() => setLoading(false));
  }, []);

  const openPicker = useCallback(() => {
    setOpen(true);
    if (!loaded && !loading) loadRepositories();
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [loadRepositories, loaded, loading]);

  const closePicker = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);
  useClickOutside([containerRef, dropdownLayerRef], closePicker);

  const filtered = repos.filter((r) => r.toLowerCase().includes(query.toLowerCase()));

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.children[highlighted];
    if (item) item.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  const select = useCallback(
    /** @param {string} repo */
    (repo) => {
      onChange(repo);
      setOpen(false);
      setQuery('');
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const handleKeyDown = useCallback(
    /** @param {import('react').KeyboardEvent<HTMLInputElement>} e */
    (e) => {
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
          setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlighted((h) => Math.max(h - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (filtered[highlighted]) select(filtered[highlighted]);
          break;
        case 'Escape':
          e.preventDefault();
          setOpen(false);
          setQuery('');
          triggerRef.current?.focus();
          break;
      }
    },
    [open, filtered, highlighted, select],
  );

  const isDark = variant === 'dark';

  return (
    <div className={styles.container} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${isDark ? styles.triggerDark : styles.triggerLight} ${disabled ? styles.disabled : ''}`}
        disabled={disabled}
        aria-label={ariaLabelledBy ? undefined : `${ariaLabel}${value ? `, ${value}` : ''}`}
        aria-labelledby={ariaLabelledBy ? `${ariaLabelledBy} ${valueId}` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={openPicker}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            openPicker();
          }
        }}
      >
        <span id={valueId} className={value ? undefined : styles.placeholder}>
          {value || 'Select repo...'}
        </span>
        <svg
          className={styles.chevron}
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1 1L5 5L9 1" />
        </svg>
      </button>
      {open && (
        <FloatingPanel
          anchorRef={containerRef}
          layerRef={dropdownLayerRef}
          matchAnchorWidth
          className={`${styles.dropdown} ${isDark ? styles.dropdownDark : styles.dropdownLight}`}
        >
          <input
            ref={inputRef}
            id={`${listboxId}-filter`}
            name="repository-filter"
            className={`${styles.searchInput} ${isDark ? styles.searchInputDark : styles.searchInputLight}`}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlighted(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Filter repos..."
            role="combobox"
            aria-label="Filter repositories"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={filtered[highlighted] ? `${listboxId}-option-${highlighted}` : undefined}
            autoFocus
          />
          <div className={styles.list} ref={listRef} id={listboxId} role="listbox" aria-label="Repositories">
            {loading && <div className={styles.status}>Loading repos...</div>}
            {!loading && error && (
              <div className={styles.status} role="alert">
                <span>{error}</span>
                <button type="button" className={styles.retry} onClick={loadRepositories}>
                  Retry
                </button>
              </div>
            )}
            {!loading && !error && filtered.length === 0 && <div className={styles.status}>No matches</div>}
            {filtered.map((repo, i) => (
              <button
                key={repo}
                id={`${listboxId}-option-${i}`}
                type="button"
                role="option"
                aria-selected={repo === value}
                tabIndex={-1}
                className={`${styles.item} ${i === highlighted ? styles.itemHighlighted : ''} ${repo === value ? styles.itemSelected : ''}`}
                onMouseEnter={() => setHighlighted(i)}
                onClick={() => select(repo)}
              >
                {repo}
              </button>
            ))}
          </div>
        </FloatingPanel>
      )}
    </div>
  );
}
