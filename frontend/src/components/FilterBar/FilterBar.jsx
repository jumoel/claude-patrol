import { useCallback, useId, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { FloatingPanel } from '../ui/FloatingPanel/FloatingPanel.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './FilterBar.module.css';

/** @typedef {import('../../types').FilterState} FilterState */
/** @typedef {import('../../types').FilterListKey} FilterListKey */
/** @typedef {import('../../types').PullRequest} PullRequest */

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
 * @param {{ label: string, options: Array<{value: string, label: string}>, selected: string[], onChange: (values: string[]) => void }} props
 */
function MultiSelect({ label, options, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const dropdownLayerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const triggerRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const dropdownId = useId();

  useClickOutside(
    [ref, dropdownLayerRef],
    useCallback(() => setOpen(false), []),
  );

  /** @param {string} value */
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
    <div
      className={styles.multiSelect}
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        ref={triggerRef}
        className={`${styles.trigger} ${selected.length > 0 ? styles.triggerActive : ''}`}
        onClick={() => setOpen((prev) => !prev)}
        type="button"
        aria-expanded={open}
        aria-controls={dropdownId}
        aria-haspopup="true"
      >
        {displayLabel}
      </button>
      {open && (
        <FloatingPanel
          anchorRef={ref}
          layerRef={dropdownLayerRef}
          matchAnchorWidth
          id={dropdownId}
          className={styles.dropdown}
          role="group"
          aria-label={`${label} options`}
        >
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
        </FloatingPanel>
      )}
    </div>
  );
}

/**
 * Filter controls for the PR table.
 * @param {{
 *   prs: PullRequest[],
 *   filters: FilterState,
 *   onFilterChange: (filters: FilterState) => void,
 *   onCopyMarkdown?: () => void,
 *   copied?: boolean,
 *   stackView?: boolean,
 *   onStackViewChange?: (enabled: boolean) => void,
 * }} props
 */
export function FilterBar({ prs, filters, onFilterChange, onCopyMarkdown, copied, stackView, onStackViewChange }) {
  const hasStacks = prs.some((p) => p.is_stacked);
  const orgs = [...new Set(prs.map((p) => p.org))].sort();
  const repos = [...new Set(prs.map((p) => p.repo))].sort();

  const orgOptions = orgs.map((o) => ({ value: o, label: o }));
  const repoOptions = repos.map((r) => ({ value: r, label: r }));

  /** @param {FilterListKey} key @param {string[]} value */
  const update = (key, value) => {
    onFilterChange({ ...filters, [key]: value });
  };

  /** @type {FilterState} */
  const REVIEW_READY_FILTERS = {
    ci: ['pass'],
    review: ['changes_requested', 'pending'],
    mergeable: ['MERGEABLE'],
    draft: ['false'],
  };
  const MERGE_READY_FILTERS = { ...REVIEW_READY_FILTERS, review: ['approved'] };

  /** @param {FilterState} target */
  const filtersMatch = (target) =>
    /** @type {Array<[FilterListKey, string[]]>} */ (Object.entries(target)).every(([key, values]) => {
      const current = filters[key];
      return current?.length === values.length && values.every((v) => current.includes(v));
    });

  const isReviewReadyActive = filtersMatch(REVIEW_READY_FILTERS);
  const isMergeReadyActive = filtersMatch(MERGE_READY_FILTERS);
  const isNeedsWorkActive = !!filters.needsWork;
  const hasAnyFilter = Object.values(filters).some((v) => v === true || (Array.isArray(v) && v.length > 0));
  const activeFilterCount = Object.values(filters).reduce(
    (count, value) => count + (value === true ? 1 : Array.isArray(value) ? value.length : 0),
    0,
  );

  /** @param {FilterState} target @param {boolean} isActive */
  const toggleQuickFilter = (target, isActive) => {
    if (isActive) {
      onFilterChange({});
    } else {
      onFilterChange(target);
    }
  };

  return (
    <Box px={0} py={0} className={styles.bar}>
      <Stack direction="col" gap={3}>
        <Stack justify="between" gap={3} wrap>
          <Stack gap={2} wrap>
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
                onClick={() => onStackViewChange?.(!stackView)}
                type="button"
              >
                Stacks
              </button>
            )}
          </Stack>
          <Stack gap={2} className={styles.utilities}>
            <button
              className={styles.searchButton}
              type="button"
              onClick={() => document.dispatchEvent(new Event('claude-patrol:open-command-palette'))}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="7" cy="7" r="4.5" />
                <path d="m10.5 10.5 3 3" />
              </svg>
              Search PRs
              <kbd className={styles.shortcut}>⌘K</kbd>
            </button>
            {onCopyMarkdown && (
              <Button size="sm" onClick={onCopyMarkdown} type="button">
                {copied ? 'Copied!' : 'Copy as Markdown'}
              </Button>
            )}
            <Button
              variant="danger"
              size="sm"
              onClick={() => onFilterChange({})}
              type="button"
              disabled={!hasAnyFilter}
            >
              Clear
            </Button>
          </Stack>
        </Stack>
        <Stack gap={2} wrap className={styles.advancedRow}>
          <span className={styles.filterLabel}>Filters</span>
          {activeFilterCount > 0 && <span className={styles.activeCount}>{activeFilterCount} active</span>}
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
