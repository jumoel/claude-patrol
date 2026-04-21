import { useCallback, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
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

  useClickOutside(
    ref,
    useCallback(() => setOpen(false), []),
  );

  const toggle = (value) => {
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    onChange(next);
  };

  const displayLabel =
    selected.length === 0
      ? label
      : selected.length === 1
        ? options.find((o) => o.value === selected[0])?.label || selected[0]
        : `${selected.length} selected`;

  return (
    <div className={styles.multiSelect} ref={ref}>
      <button
        className={`${styles.trigger} ${selected.length > 0 ? styles.triggerActive : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        {displayLabel}
      </button>
      {open && (
        <div className={styles.dropdown}>
          {options.map((opt) => (
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
export function FilterBar({ prs, filters, onFilterChange, onCopyMarkdown, copied, stackView, onStackViewChange }) {
  const hasStacks = prs.some((p) => p.is_stacked);
  const orgs = [...new Set(prs.map((p) => p.org))].sort();
  const repos = [...new Set(prs.map((p) => p.repo))].sort();

  const orgOptions = orgs.map((o) => ({ value: o, label: o }));
  const repoOptions = repos.map((r) => ({ value: r, label: r }));

  const update = (key, value) => {
    onFilterChange({ ...filters, [key]: value });
  };

  const REVIEW_READY_FILTERS = {
    ci: ['pass'],
    review: ['changes_requested', 'pending'],
    mergeable: ['MERGEABLE'],
    draft: ['false'],
  };
  const MERGE_READY_FILTERS = { ...REVIEW_READY_FILTERS, review: ['approved'] };

  const filtersMatch = (target) =>
    Object.entries(target).every(
      ([key, values]) => filters[key]?.length === values.length && values.every((v) => filters[key].includes(v)),
    );

  const isReviewReadyActive = filtersMatch(REVIEW_READY_FILTERS);
  const isMergeReadyActive = filtersMatch(MERGE_READY_FILTERS);
  const isNeedsWorkActive = !!filters.needsWork;
  const hasAnyFilter = Object.values(filters).some((v) => v === true || (Array.isArray(v) && v.length > 0));

  const toggleQuickFilter = (target, isActive) => {
    if (isActive) {
      onFilterChange({});
    } else {
      onFilterChange(target);
    }
  };

  return (
    <Box px={4} py={3} border rounded="lg" bg="white" className={styles.bar}>
      <Stack direction="col" gap={3}>
        <Stack gap={3} wrap>
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
          {hasStacks && (
            <button
              className={`${styles.quickFilter} ${styles.quickFilterPurple} ${stackView ? styles.quickFilterActive : ''}`}
              onClick={() => onStackViewChange(!stackView)}
              type="button"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="currentColor"
                style={{ verticalAlign: '-2px', marginRight: '4px' }}
              >
                <path d="M5 3.254V3.25v.005a.75.75 0 110-.005v.004zm.45 1.9a2.25 2.25 0 10-1.95.218v5.256a2.25 2.25 0 101.5 0V7.123A5.735 5.735 0 009.25 9h1.378a2.251 2.251 0 100-1.5H9.25a4.25 4.25 0 01-3.8-2.346zM12.75 9a.75.75 0 100-1.5.75.75 0 000 1.5zm-8.5 4.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
              </svg>
              Stacks
            </button>
          )}
          <Button variant="danger" size="md" onClick={() => onFilterChange({})} type="button" disabled={!hasAnyFilter}>
            Clear
          </Button>
          {onCopyMarkdown && (
            <Button size="md" onClick={onCopyMarkdown} type="button">
              {copied ? 'Copied!' : 'Copy as Markdown'}
            </Button>
          )}
        </Stack>
        <Stack gap={3} wrap>
          <MultiSelect
            label="All orgs"
            options={orgOptions}
            selected={filters.org || []}
            onChange={(v) => update('org', v)}
          />
          <MultiSelect
            label="All repos"
            options={repoOptions}
            selected={filters.repo || []}
            onChange={(v) => update('repo', v)}
          />
          <MultiSelect
            label="All CI"
            options={CI_OPTIONS}
            selected={filters.ci || []}
            onChange={(v) => update('ci', v)}
          />
          <MultiSelect
            label="All reviews"
            options={REVIEW_OPTIONS}
            selected={filters.review || []}
            onChange={(v) => update('review', v)}
          />
          <MultiSelect
            label="All merge"
            options={MERGE_OPTIONS}
            selected={filters.mergeable || []}
            onChange={(v) => update('mergeable', v)}
          />
          <MultiSelect
            label="All PRs"
            options={DRAFT_OPTIONS}
            selected={filters.draft || []}
            onChange={(v) => update('draft', v)}
          />
        </Stack>
      </Stack>
    </Box>
  );
}
