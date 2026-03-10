import { useState, useRef, useEffect } from 'react';
import styles from './FilterBar.module.css';

const CI_OPTIONS = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'pending', label: 'Pending' },
];
const REVIEW_OPTIONS = [
  { value: 'approved', label: 'Approved' },
  { value: 'changes_requested', label: 'Changes' },
  { value: 'pending', label: 'Pending' },
];
const MERGE_OPTIONS = [
  { value: 'MERGEABLE', label: 'Clean' },
  { value: 'CONFLICTING', label: 'Conflict' },
  { value: 'UNKNOWN', label: 'Unknown' },
];
const DRAFT_OPTIONS = [
  { value: 'true', label: 'Drafts' },
  { value: 'false', label: 'Non-drafts' },
];

/**
 * Multi-select dropdown component.
 */
function MultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggle = (value) => {
    const next = selected.includes(value)
      ? selected.filter(v => v !== value)
      : [...selected, value];
    onChange(next);
  };

  const displayLabel = selected.length === 0
    ? label
    : selected.length === 1
      ? options.find(o => o.value === selected[0])?.label || selected[0]
      : `${selected.length} selected`;

  return (
    <div className={styles.multiSelect} ref={ref}>
      <button
        className={`${styles.trigger} ${selected.length > 0 ? styles.triggerActive : ''}`}
        onClick={() => setOpen(prev => !prev)}
        type="button"
      >
        {displayLabel}
      </button>
      {open && (
        <div className={styles.dropdown}>
          {options.map(opt => (
            <label key={opt.value} className={styles.option}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
              />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Filter controls for the PR table.
 * @param {{ prs: object[], filters: Record<string, string[]>, onFilterChange: (filters: Record<string, string[]>) => void }} props
 */
export function FilterBar({ prs, filters, onFilterChange, onCopyMarkdown, copied }) {
  const orgs = [...new Set(prs.map(p => p.org))].sort();
  const repos = [...new Set(prs.map(p => p.repo))].sort();

  const orgOptions = orgs.map(o => ({ value: o, label: o }));
  const repoOptions = repos.map(r => ({ value: r, label: r }));

  const update = (key, value) => {
    onFilterChange({ ...filters, [key]: value });
  };

  const REVIEW_READY_FILTERS = { ci: ['pass'], review: ['changes_requested', 'pending'], mergeable: ['MERGEABLE'], draft: ['false'] };
  const MERGE_READY_FILTERS = { ...REVIEW_READY_FILTERS, review: ['approved'] };

  const filtersMatch = (target) => Object.entries(target).every(
    ([key, values]) => filters[key]?.length === values.length && values.every(v => filters[key].includes(v))
  );

  const isReviewReadyActive = filtersMatch(REVIEW_READY_FILTERS);
  const isMergeReadyActive = filtersMatch(MERGE_READY_FILTERS);
  const isNeedsWorkActive = !!filters.needsWork;
  const hasAnyFilter = Object.values(filters).some(v => v === true || (Array.isArray(v) && v.length > 0));

  const toggleQuickFilter = (target, isActive) => {
    if (isActive) {
      onFilterChange({});
    } else {
      onFilterChange(target);
    }
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.quickFilters}>
        <button
          className={`${styles.quickFilter} ${styles.quickFilterGreen} ${isMergeReadyActive ? styles.quickFilterActive : ''}`}
          onClick={() => toggleQuickFilter(MERGE_READY_FILTERS, isMergeReadyActive)}
          type="button"
        >
          Merge Ready
        </button>
        <button
          className={`${styles.quickFilter} ${styles.quickFilterOrange} ${isNeedsWorkActive ? styles.quickFilterActive : ''}`}
          onClick={() => toggleQuickFilter({ needsWork: true }, isNeedsWorkActive)}
          type="button"
        >
          Needs Work
        </button>
        <button
          className={`${styles.quickFilter} ${styles.quickFilterBlue} ${isReviewReadyActive ? styles.quickFilterActive : ''}`}
          onClick={() => toggleQuickFilter(REVIEW_READY_FILTERS, isReviewReadyActive)}
          type="button"
        >
          Review Ready
        </button>
        <button className={styles.clearButton} onClick={() => onFilterChange({})} type="button" disabled={!hasAnyFilter}>
          Clear
        </button>
        {onCopyMarkdown && (
          <button className={styles.copyButton} onClick={onCopyMarkdown} type="button">
            {copied ? 'Copied!' : 'Copy as Markdown'}
          </button>
        )}
      </div>
      <div className={styles.bar}>
        <MultiSelect label="All orgs" options={orgOptions} selected={filters.org || []} onChange={(v) => update('org', v)} />
        <MultiSelect label="All repos" options={repoOptions} selected={filters.repo || []} onChange={(v) => update('repo', v)} />
        <MultiSelect label="All CI" options={CI_OPTIONS} selected={filters.ci || []} onChange={(v) => update('ci', v)} />
        <MultiSelect label="All reviews" options={REVIEW_OPTIONS} selected={filters.review || []} onChange={(v) => update('review', v)} />
        <MultiSelect label="All merge" options={MERGE_OPTIONS} selected={filters.mergeable || []} onChange={(v) => update('mergeable', v)} />
        <MultiSelect label="All PRs" options={DRAFT_OPTIONS} selected={filters.draft || []} onChange={(v) => update('draft', v)} />
      </div>
    </div>
  );
}
