import { useMemo, useState } from 'react';
import { useWaitingAcknowledgements } from '../../hooks/useWaitingAcknowledgements.js';
import { getRelativeTime } from '../../lib/time.js';
import {
  buildWaitingSessions,
  dashboardFiltersMatch,
  filterDashboardRows,
  MERGE_READY_FILTERS,
  REVIEW_READY_FILTERS,
  serializeDashboardRowsMarkdown,
  sortDashboardRows,
} from '../../lib/work-dashboard.js';
import { WORKING_LABEL, WorkingBadge } from '../ui/WorkingBadge/WorkingBadge.jsx';
import styles from './WorkDashboard.module.css';

/** @type {Record<string, string>} */
const SOURCE_LABELS = {
  pull_requests: 'Pull requests',
  work_items: 'Work items',
  workspaces: 'Workspaces',
  sessions: 'Sessions',
};
const COLUMN_STORAGE_KEY = 'claude-patrol-work-columns-v1';
const COLUMNS = [
  { id: 'work', label: 'Work' },
  { id: 'work_ref', label: 'Work ref' },
  { id: 'llm', label: 'LLM' },
  { id: 'repository', label: 'Repository' },
  { id: 'pull_requests', label: 'Pull requests' },
  { id: 'local', label: 'Local' },
  { id: 'updated', label: 'Updated' },
];
const DEFAULT_COLUMNS = COLUMNS.map((column) => column.id);
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

/** @param {string} value */
function labelize(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readColumns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) || 'null');
    if (!Array.isArray(parsed)) return new Set(DEFAULT_COLUMNS);
    const valid = parsed.filter((column) => DEFAULT_COLUMNS.includes(column));
    return new Set(['work', ...valid]);
  } catch {
    return new Set(DEFAULT_COLUMNS);
  }
}

/** @param {{pr: import('../../types').DashboardPullRequestSummary}} props */
function PullRequestBadges({ pr }) {
  if (!pr.tracked) return <span className={`${styles.badge} ${styles.neutral}`}>Waiting for sync</span>;
  return (
    <span className={styles.badges}>
      <span className={`${styles.badge} ${styles[pr.ci_status || 'neutral']}`}>CI {labelize(pr.ci_status || '')}</span>
      <span
        className={`${styles.badge} ${
          pr.review_status === 'approved'
            ? styles.pass
            : pr.review_status === 'changes_requested'
              ? styles.fail
              : styles.neutral
        }`}
      >
        {pr.review_status === 'changes_requested' ? 'Changes' : labelize(pr.review_status || '')}
      </span>
      <span
        className={`${styles.badge} ${
          pr.mergeable === 'MERGEABLE' ? styles.pass : pr.mergeable === 'CONFLICTING' ? styles.fail : styles.neutral
        }`}
      >
        {pr.mergeable === 'MERGEABLE' ? 'Clean' : pr.mergeable === 'CONFLICTING' ? 'Conflict' : 'Unknown'}
      </span>
      {pr.draft && <span className={`${styles.badge} ${styles.neutral}`}>Draft</span>}
    </span>
  );
}

/**
 * @param {{
 *   sessions: import('../../types').DashboardSessionSummary[],
 *   acknowledgedIdle: Map<string, string>,
 * }} props
 */
function SessionSummary({ sessions, acknowledgedIdle }) {
  if (sessions.length === 0) return <span className={styles.empty}>No session</span>;
  const working = sessions.filter((session) => session.activity_state === 'working').length;
  const waiting = sessions.filter(
    (session) =>
      session.activity_state === 'idle' &&
      !!session.activity_changed_at &&
      acknowledgedIdle.get(session.id) !== session.activity_changed_at,
  ).length;
  const idle = sessions.length - working - waiting;
  const providers = [...new Set(sessions.map((session) => labelize(session.provider)))].join(', ');
  const stateLabel =
    sessions.length === 1
      ? working > 0
        ? WORKING_LABEL
        : waiting > 0
          ? 'Waiting'
          : 'Idle'
      : [
          working > 0 ? `${working} working` : null,
          waiting > 0 ? `${waiting} waiting` : null,
          idle > 0 ? `${idle} idle` : null,
        ]
          .filter(Boolean)
          .join(', ');
  return (
    <span className={styles.sessionSummary}>
      {working > 0 ? (
        <WorkingBadge
          presentation="inline"
          label={sessions.length === 1 ? undefined : stateLabel}
          spinnerSize="xxs"
          className={styles.runtimeState}
        />
      ) : (
        <span className={`${styles.runtimeState} ${waiting > 0 ? styles.runtimeWaiting : styles.runtimeIdle}`}>
          <span className={styles.sessionDot} data-state-marker={waiting > 0 ? 'waiting' : 'idle'} aria-hidden="true" />
          {stateLabel}
        </span>
      )}
      <small>{providers}</small>
    </span>
  );
}

/** @param {{row: import('../../types').DashboardWorkRow}} props */
function LocalSummary({ row }) {
  if (row.workspace_count === 0) return <span className={styles.empty}>No workspace</span>;
  const scratch = row.kind === 'scratch';
  const label = scratch
    ? 'Scratch'
    : row.kind === 'pull_request' || row.pull_requests.length > 0
      ? 'PR workspace'
      : 'Workspace';
  const note = scratch ? 'Active' : row.workspace_count === 1 ? 'Ready' : `${row.workspace_count} ready`;
  return (
    <span className={styles.localSummary}>
      <span className={`${styles.kind} ${styles.localBadge} ${scratch ? styles.scratch : styles.pull_request}`}>
        {label}
      </span>
      <small>{note}</small>
    </span>
  );
}

/** @param {import('../../types').DashboardWorkRow} row */
function rowHref(row) {
  if (row.kind === 'work_item') return `#/work-item/${encodeURIComponent(row.id)}`;
  if (row.kind === 'pull_request') return `#/pr/${encodeURIComponent(row.id)}`;
  return `#/workspace/${encodeURIComponent(row.id)}`;
}

/** @param {import('../../types').DashboardWorkRow} row @param {string} prId */
function pullRequestHref(row, prId) {
  if (row.kind === 'work_item') {
    return `#/work-item/${encodeURIComponent(row.id)}?pr=${encodeURIComponent(prId)}`;
  }
  return `#/pr/${encodeURIComponent(prId)}`;
}

/** @param {import('../../types').DashboardSessionSummary} session */
function waitingHref(session) {
  if (session.target.type === 'work_item') return `#/work-item/${encodeURIComponent(session.target.id)}`;
  if (session.target.type === 'workspace') return `#/workspace/${encodeURIComponent(session.target.id)}`;
  return null;
}

/**
 * @param {{label: string, options: Array<{value: string, label: string}>, selected: string[], onChange: (values: string[]) => void}} props
 */
function MultiSelect({ label, options, selected, onChange }) {
  const display = selected.length === 0 ? label : selected.length === 1 ? selected[0] : `${selected.length} selected`;
  return (
    <details className={styles.filterMenu}>
      <summary className={selected.length > 0 ? styles.filterActive : undefined}>{display}</summary>
      <div className={styles.filterPopover}>
        {options.map((option) => (
          <label key={option.value}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={() =>
                onChange(
                  selected.includes(option.value)
                    ? selected.filter((value) => value !== option.value)
                    : [...selected, option.value],
                )
              }
            />
            {option.label}
          </label>
        ))}
      </div>
    </details>
  );
}

/**
 * @param {{
 *   dashboard: {
 *     rows: import('../../types').DashboardWorkRow[],
 *     counts: import('../../types').DashboardCounts,
 *     sources: Record<'pull_requests' | 'work_items' | 'workspaces' | 'sessions', import('../../types').DashboardSourceState>,
 *     prSource: {reload: () => void},
 *     workItemSource: {reload: () => void},
 *     workspaceSource: {reload: () => void},
 *     sessionSource: {allSessions: import('../../types').Session[], reload: () => void},
 *   },
 *   filters: import('../../types').FilterState,
 *   onFilterChange: (filters: import('../../types').FilterState) => void,
 *   sorting: Array<{id: string, desc: boolean}>,
 *   onSortingChange: (updater: Array<{id: string, desc: boolean}>) => void,
 *   stackView: boolean,
 *   onStackViewChange: (enabled: boolean) => void,
 *   onOpenGlobalTerminal: (sessionId?: string) => void,
 *   startWorkLauncher?: React.ReactNode,
 * }} props
 */
export function WorkDashboard({
  dashboard,
  filters,
  onFilterChange,
  sorting,
  onSortingChange,
  stackView,
  onStackViewChange,
  onOpenGlobalTerminal,
  startWorkLauncher,
}) {
  const [visibleColumns, setVisibleColumns] = useState(readColumns);
  const [copyState, setCopyState] = useState(/** @type {'idle' | 'copied' | 'error'} */ ('idle'));
  const sessionsReconciled = ['ready', 'stale'].includes(dashboard.sources.sessions.status);
  const { acknowledgedIdle, acknowledge } = useWaitingAcknowledgements(
    dashboard.sessionSource.allSessions,
    sessionsReconciled,
  );
  const waiting = useMemo(
    () => buildWaitingSessions(dashboard.sessionSource.allSessions, acknowledgedIdle),
    [acknowledgedIdle, dashboard.sessionSource.allSessions],
  );
  const rows = useMemo(
    () => sortDashboardRows(filterDashboardRows(dashboard.rows, filters), sorting, stackView),
    [dashboard.rows, filters, sorting, stackView],
  );
  const unavailableSources = Object.entries(dashboard.sources).filter(([, source]) => source.status === 'unavailable');
  const staleSources = Object.entries(dashboard.sources).filter(([, source]) => source.status === 'stale');
  const sourceRetries = /** @type {Record<string, () => void>} */ ({
    pull_requests: dashboard.prSource.reload,
    work_items: dashboard.workItemSource.reload,
    workspaces: dashboard.workspaceSource.reload,
    sessions: dashboard.sessionSource.reload,
  });
  const pullRequests = dashboard.rows.flatMap((row) => row.pull_requests);
  const orgOptions = [...new Set(pullRequests.map((pr) => pr.org))].sort().map((value) => ({ value, label: value }));
  const repoOptions = [
    ...new Set([
      ...pullRequests.map((pr) => pr.repo),
      ...dashboard.rows.flatMap((row) =>
        row.repositories.map((repository) => repository.split('/').slice(1).join('/')),
      ),
    ]),
  ]
    .filter(Boolean)
    .sort()
    .map((value) => ({ value, label: value }));
  const hasStacks = dashboard.rows.some((row) => row.kind === 'pull_request' && row.pull_requests[0]?.is_stacked);
  const hasFilters = Object.values(filters).some((value) => value === true || (Array.isArray(value) && value.length));

  const ownerForWaiting = (/** @type {import('../../types').DashboardSessionSummary} */ session) =>
    dashboard.rows.find(
      (row) =>
        (session.target.type === 'work_item' && row.kind === 'work_item' && row.id === session.target.id) ||
        (session.target.type === 'workspace' && row.workspace_id === session.target.id),
    );

  const labelForWaiting = (/** @type {import('../../types').DashboardSessionSummary} */ session) => {
    if (session.target.type === 'global') return session.name || 'Global session';
    const owner = ownerForWaiting(session);
    return owner?.title || session.name || 'LLM session';
  };

  const contextForWaiting = (/** @type {import('../../types').DashboardSessionSummary} */ session) => {
    const owner = ownerForWaiting(session);
    const kind =
      owner?.kind === 'work_item'
        ? 'work item'
        : owner?.kind === 'pull_request'
          ? 'pull request'
          : owner?.kind === 'scratch'
            ? 'scratch workspace'
            : 'global session';
    return [owner?.work_reference?.display, labelize(session.provider), kind].filter(Boolean).join(' · ');
  };

  const toggleColumn = (/** @type {string} */ column) => {
    const next = new Set(visibleColumns);
    if (next.has(column)) next.delete(column);
    else next.add(column);
    next.add('work');
    setVisibleColumns(next);
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify([...next]));
  };

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(serializeDashboardRowsMarkdown(rows));
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('error');
    }
  };

  const delegateRowClick = (/** @type {React.MouseEvent<HTMLTableRowElement>} */ event) => {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest('a, button, input, select, textarea, summary, details'))
    ) {
      return;
    }
    if (window.getSelection()?.toString()) return;
    /** @type {HTMLAnchorElement | null} */ (event.currentTarget.querySelector('[data-primary-link]'))?.click();
  };

  const setSort = (/** @type {string} */ id) => {
    const current = sorting[0];
    onSortingChange([{ id, desc: current?.id === id ? !current.desc : false }]);
  };

  const sortHeader = (/** @type {string} */ label, /** @type {string} */ id) => {
    const current = sorting[0]?.id === id ? sorting[0] : null;
    return (
      <button type="button" onClick={() => setSort(id)}>
        {label} {current ? (current.desc ? '↓' : '↑') : ''}
      </button>
    );
  };

  return (
    <div className={styles.dashboard}>
      <div className={styles.summaryRow}>
        <nav className={styles.summary} aria-label="Dashboard summary">
          {dashboard.sources.pull_requests.status !== 'disabled' && (
            <span>
              <b>{dashboard.counts.open_pull_requests ?? 'Unavailable'}</b> open PRs
            </span>
          )}
          <span>
            <b>{dashboard.counts.work_items ?? 'Unavailable'}</b> work items
          </span>
          <span>
            <b>{dashboard.counts.active_workspaces ?? 'Unavailable'}</b> active workspaces
          </span>
          <span>
            <b>{dashboard.counts.live_sessions ?? 'Unavailable'}</b> live sessions
          </span>
        </nav>
        {startWorkLauncher}
      </div>

      {(unavailableSources.length > 0 || staleSources.length > 0) && (
        <div className={styles.sourceNotice}>
          <div role="status">
            {unavailableSources.length > 0 && (
              <span>Unavailable: {unavailableSources.map(([name]) => SOURCE_LABELS[name]).join(', ')}</span>
            )}
            {staleSources.length > 0 && (
              <span>Showing retained data for: {staleSources.map(([name]) => SOURCE_LABELS[name]).join(', ')}</span>
            )}
          </div>
          <div className={styles.sourceRetries}>
            {[...unavailableSources, ...staleSources].map(([name]) => (
              <button key={name} type="button" onClick={sourceRetries[name]}>
                Retry {SOURCE_LABELS[name].toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      <section className={styles.waiting} aria-labelledby="waiting-heading">
        <div className={styles.sectionHeader}>
          <h2 id="waiting-heading">
            Waiting for you <span>{waiting.length}</span>
          </h2>
        </div>
        {dashboard.sources.sessions.status === 'loading' && waiting.length === 0 ? (
          <p className={styles.emptyState}>Loading sessions...</p>
        ) : dashboard.sources.sessions.status === 'unavailable' ? (
          <p className={styles.emptyState}>Sessions are unavailable.</p>
        ) : waiting.length === 0 ? (
          <p className={styles.emptyState}>No LLM sessions are waiting for you.</p>
        ) : (
          <ul className={styles.waitingList}>
            {waiting.map((session) => {
              const href = waitingHref(session);
              const content = (
                <>
                  <span className={styles.waitingDot} data-state-marker="waiting" aria-hidden="true" />
                  <span className={styles.waitingCopy}>
                    <span className={styles.waitingTitle}>{labelForWaiting(session)}</span>
                    <span className={styles.waitingMeta}>{contextForWaiting(session)}</span>
                  </span>
                  <time dateTime={session.activity_changed_at || session.started_at}>
                    {getRelativeTime(session.activity_changed_at || session.started_at)}
                  </time>
                  <span className={styles.waitingAction}>Resume</span>
                </>
              );
              return (
                <li key={session.id}>
                  {href ? (
                    <a href={href} onClick={() => acknowledge(session.id)}>
                      {content}
                    </a>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        acknowledge(session.id);
                        onOpenGlobalTerminal(session.id);
                      }}
                    >
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles.work} aria-labelledby="work-heading">
        <div className={styles.sectionHeader}>
          <h2 id="work-heading">
            Work <span>{rows.length}</span>
          </h2>
          <div className={styles.sectionUtilities}>
            <button type="button" onClick={copyMarkdown} disabled={rows.length === 0}>
              {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy as Markdown'}
            </button>
            <details className={styles.columnsMenu}>
              <summary>Columns</summary>
              <div className={styles.columnsPopover}>
                {COLUMNS.map((column) => (
                  <label key={column.id}>
                    <input
                      type="checkbox"
                      checked={visibleColumns.has(column.id)}
                      disabled={column.id === 'work'}
                      onChange={() => toggleColumn(column.id)}
                    />
                    {column.label}
                  </label>
                ))}
              </div>
            </details>
          </div>
        </div>

        <div className={styles.filters} aria-label="Work filters">
          <div className={styles.quickFilters}>
            <button
              type="button"
              aria-pressed={dashboardFiltersMatch(filters, MERGE_READY_FILTERS)}
              onClick={() =>
                onFilterChange(dashboardFiltersMatch(filters, MERGE_READY_FILTERS) ? {} : MERGE_READY_FILTERS)
              }
            >
              Merge Ready
            </button>
            <button
              type="button"
              aria-pressed={filters.needsWork === true && Object.keys(filters).length === 1}
              onClick={() =>
                onFilterChange(
                  filters.needsWork === true && Object.keys(filters).length === 1 ? {} : { needsWork: true },
                )
              }
            >
              Needs Work
            </button>
            <button
              type="button"
              aria-pressed={dashboardFiltersMatch(filters, REVIEW_READY_FILTERS)}
              onClick={() =>
                onFilterChange(dashboardFiltersMatch(filters, REVIEW_READY_FILTERS) ? {} : REVIEW_READY_FILTERS)
              }
            >
              Review Ready
            </button>
            {hasStacks && (
              <button type="button" aria-pressed={stackView} onClick={() => onStackViewChange(!stackView)}>
                Stacks
              </button>
            )}
          </div>
          <div className={styles.advancedFilters}>
            <MultiSelect
              label="All orgs"
              options={orgOptions}
              selected={filters.org || []}
              onChange={(org) => onFilterChange({ ...filters, org })}
            />
            <MultiSelect
              label="All repos"
              options={repoOptions}
              selected={filters.repo || []}
              onChange={(repo) => onFilterChange({ ...filters, repo })}
            />
            <MultiSelect
              label="All CI"
              options={CI_OPTIONS}
              selected={filters.ci || []}
              onChange={(ci) => onFilterChange({ ...filters, ci })}
            />
            <MultiSelect
              label="All reviews"
              options={REVIEW_OPTIONS}
              selected={filters.review || []}
              onChange={(review) => onFilterChange({ ...filters, review })}
            />
            <MultiSelect
              label="All merge"
              options={MERGE_OPTIONS}
              selected={filters.mergeable || []}
              onChange={(mergeable) => onFilterChange({ ...filters, mergeable })}
            />
            <MultiSelect
              label="All PRs"
              options={DRAFT_OPTIONS}
              selected={filters.draft || []}
              onChange={(draft) => onFilterChange({ ...filters, draft })}
            />
            <button
              className={styles.clearFilters}
              type="button"
              disabled={!hasFilters}
              onClick={() => onFilterChange({})}
            >
              Clear
            </button>
          </div>
        </div>

        <div className={styles.tableScroller}>
          <table>
            <thead>
              <tr>
                {visibleColumns.has('work') && <th className={styles.workColumn}>{sortHeader('Work', 'title')}</th>}
                {visibleColumns.has('work_ref') && <th className={styles.refColumn}>Work ref</th>}
                {visibleColumns.has('llm') && <th className={styles.llmColumn}>LLM</th>}
                {visibleColumns.has('repository') && (
                  <th className={styles.repoColumn}>{sortHeader('Repository', 'repo')}</th>
                )}
                {visibleColumns.has('pull_requests') && <th className={styles.prColumn}>Pull requests</th>}
                {visibleColumns.has('local') && <th className={styles.localColumn}>Local</th>}
                {visibleColumns.has('updated') && (
                  <th className={styles.updatedColumn}>{sortHeader('Updated', 'updated_at')}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.kind}:${row.id}`} onClick={delegateRowClick}>
                  {visibleColumns.has('work') && (
                    <td data-label="Work">
                      <a data-primary-link className={styles.workTitle} href={rowHref(row)}>
                        {row.title}
                      </a>
                      <span className={`${styles.kind} ${styles[row.kind]}`}>
                        {row.kind === 'work_item'
                          ? 'Work item'
                          : row.kind === 'pull_request'
                            ? 'Pull request'
                            : 'Scratch'}
                      </span>
                    </td>
                  )}
                  {visibleColumns.has('work_ref') && (
                    <td data-label="Work ref">
                      {row.work_reference &&
                        (row.work_reference.url ? (
                          <a
                            className={styles.workReference}
                            href={row.work_reference.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {row.work_reference.display}
                          </a>
                        ) : (
                          <span className={styles.workReference}>{row.work_reference.display}</span>
                        ))}
                    </td>
                  )}
                  {visibleColumns.has('llm') && (
                    <td data-label="LLM">
                      <SessionSummary sessions={row.sessions} acknowledgedIdle={acknowledgedIdle} />
                    </td>
                  )}
                  {visibleColumns.has('repository') && (
                    <td data-label="Repository">
                      {row.repositories.length > 0 ? (
                        <span className={styles.repositories}>{row.repositories.join(', ')}</span>
                      ) : (
                        <span className={styles.empty}>Unavailable</span>
                      )}
                    </td>
                  )}
                  {visibleColumns.has('pull_requests') && (
                    <td data-label="Pull requests">
                      {row.pull_requests.length > 0 ? (
                        <span className={styles.pullRequests}>
                          {row.pull_requests.map((pr) => (
                            <span className={styles.pullRequest} key={pr.id}>
                              <a
                                href={pullRequestHref(row, pr.id)}
                                aria-label={`Open pull request #${pr.number}: ${pr.title}`}
                              >
                                #{pr.number} {pr.title}
                              </a>
                              <PullRequestBadges pr={pr} />
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className={styles.empty}>No PR attached</span>
                      )}
                    </td>
                  )}
                  {visibleColumns.has('local') && (
                    <td data-label="Local">
                      <LocalSummary row={row} />
                    </td>
                  )}
                  {visibleColumns.has('updated') && (
                    <td data-label="Updated">
                      <time dateTime={row.updated_at}>{getRelativeTime(row.updated_at)}</time>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !Object.values(dashboard.sources).some((source) => source.status === 'loading') && (
            <p className={styles.emptyState}>No work matches these filters.</p>
          )}
        </div>
      </section>
    </div>
  );
}
