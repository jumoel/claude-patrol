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

  const MERGE_READY_FILTERS = { ci: ['pass'], review: ['approved'], mergeable: ['MERGEABLE'], draft: ['false'] };

  const isMergeReadyActive = filters.ci?.length === 1 && filters.ci[0] === 'pass'
    && filters.review?.length === 1 && filters.review[0] === 'approved'
    && filters.mergeable?.length === 1 && filters.mergeable[0] === 'MERGEABLE'
    && filters.draft?.length === 1 && filters.draft[0] === 'false';

  const toggleMergeReady = () => {
    if (isMergeReadyActive) {
      onFilterChange({});
    } else {
      onFilterChange({ ...filters, ...MERGE_READY_FILTERS });
    }
  };

  return (
    <div className={styles.bar}>
      <button
        className={`${styles.quickFilter} ${isMergeReadyActive ? styles.quickFilterActive : ''}`}
        onClick={toggleMergeReady}
        type="button"
      >
        Merge Ready
      </button>
      <div className={styles.separator} />
      <MultiSelect label="All orgs" options={orgOptions} selected={filters.org || []} onChange={(v) => update('org', v)} />
      <MultiSelect label="All repos" options={repoOptions} selected={filters.repo || []} onChange={(v) => update('repo', v)} />
      <MultiSelect label="All CI" options={CI_OPTIONS} selected={filters.ci || []} onChange={(v) => update('ci', v)} />
      <MultiSelect label="All reviews" options={REVIEW_OPTIONS} selected={filters.review || []} onChange={(v) => update('review', v)} />
      <MultiSelect label="All merge" options={MERGE_OPTIONS} selected={filters.mergeable || []} onChange={(v) => update('mergeable', v)} />
      <MultiSelect label="All PRs" options={DRAFT_OPTIONS} selected={filters.draft || []} onChange={(v) => update('draft', v)} />
      {onCopyMarkdown && (
        <>
          <div className={styles.separator} />
          <button className={styles.copyButton} onClick={onCopyMarkdown} type="button">
            {copied ? 'Copied!' : 'Copy as Markdown'}
          </button>
        </>
      )}
    </div>
  );
}
