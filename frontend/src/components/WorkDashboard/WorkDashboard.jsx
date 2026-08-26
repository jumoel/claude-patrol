import { getRelativeTime } from '../../lib/time.js';
import styles from './WorkDashboard.module.css';

/** @type {Record<string, string>} */
const SOURCE_LABELS = {
  pull_requests: 'Pull requests',
  work_items: 'Work items',
  workspaces: 'Workspaces',
  sessions: 'Sessions',
};

/** @param {string} value */
function labelize(value) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** @param {{pr: import('../../types').DashboardPullRequestSummary}} props */
function PullRequestBadges({ pr }) {
  if (!pr.tracked) return <span className={`${styles.badge} ${styles.neutral}`}>Status unavailable</span>;
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
        {labelize(pr.review_status || '')}
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

/** @param {{sessions: import('../../types').DashboardSessionSummary[]}} props */
function SessionSummary({ sessions }) {
  if (sessions.length === 0) return <span className={styles.empty}>No session</span>;
  const idle = sessions.filter((session) => session.activity_state === 'idle').length;
  const working = sessions.filter((session) => session.activity_state === 'working').length;
  const providers = [...new Set(sessions.map((session) => labelize(session.provider)))].join(', ');
  return (
    <span className={styles.sessionSummary}>
      <span>
        {working > 0 ? `${working} working` : `${idle} waiting`}
        {working > 0 && idle > 0 ? `, ${idle} waiting` : ''}
      </span>
      <small>{providers}</small>
    </span>
  );
}

/** @param {import('../../types').DashboardWorkRow} row */
function rowHref(row) {
  if (row.kind === 'work_item') return `#/work-item/${encodeURIComponent(row.id)}`;
  if (row.kind === 'pull_request') return `#/pr/${encodeURIComponent(row.id)}`;
  return `#/workspace/${encodeURIComponent(row.id)}`;
}

/** @param {import('../../types').DashboardSessionSummary} session */
function waitingHref(session) {
  if (session.target.type === 'work_item') return `#/work-item/${encodeURIComponent(session.target.id)}`;
  if (session.target.type === 'workspace') return `#/workspace/${encodeURIComponent(session.target.id)}`;
  return null;
}

/**
 * @param {{
 *   dashboard: {
 *     rows: import('../../types').DashboardWorkRow[],
 *     waiting: import('../../types').DashboardSessionSummary[],
 *     counts: import('../../types').DashboardCounts,
 *     sources: Record<string, import('../../types').DashboardSourceState>,
 *   },
 *   onOpenGlobalTerminal: (sessionId?: string) => void,
 * }} props
 */
export function WorkDashboard({ dashboard, onOpenGlobalTerminal }) {
  const unavailableSources = Object.entries(dashboard.sources).filter(([, source]) => source.status === 'unavailable');
  const staleSources = Object.entries(dashboard.sources).filter(([, source]) => source.status === 'stale');

  const activateRow = (/** @type {import('../../types').DashboardWorkRow} */ row) => {
    window.location.hash = rowHref(row).slice(1);
  };

  const labelForWaiting = (/** @type {import('../../types').DashboardSessionSummary} */ session) => {
    if (session.target.type === 'global') return session.name || 'Global session';
    const owner = dashboard.rows.find(
      (row) =>
        (session.target.type === 'work_item' && row.kind === 'work_item' && row.id === session.target.id) ||
        (session.target.type === 'workspace' && row.workspace_id === session.target.id),
    );
    return owner?.title || session.name || 'LLM session';
  };

  return (
    <div className={styles.dashboard}>
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

      {(unavailableSources.length > 0 || staleSources.length > 0) && (
        <div className={styles.sourceNotice} role="status">
          {unavailableSources.length > 0 && (
            <span>Unavailable: {unavailableSources.map(([name]) => SOURCE_LABELS[name]).join(', ')}</span>
          )}
          {staleSources.length > 0 && (
            <span>Showing retained data for: {staleSources.map(([name]) => SOURCE_LABELS[name]).join(', ')}</span>
          )}
        </div>
      )}

      <section className={styles.waiting} aria-labelledby="waiting-heading">
        <div className={styles.sectionHeader}>
          <h2 id="waiting-heading">
            Waiting for you <span>{dashboard.waiting.length}</span>
          </h2>
        </div>
        {dashboard.sources.sessions.status === 'loading' && dashboard.waiting.length === 0 ? (
          <p className={styles.emptyState}>Loading sessions...</p>
        ) : dashboard.sources.sessions.status === 'unavailable' ? (
          <p className={styles.emptyState}>Sessions are unavailable.</p>
        ) : dashboard.waiting.length === 0 ? (
          <p className={styles.emptyState}>No LLM sessions are waiting for you.</p>
        ) : (
          <ul className={styles.waitingList}>
            {dashboard.waiting.map((session) => {
              const href = waitingHref(session);
              const content = (
                <>
                  <span className={`${styles.badge} ${styles.pending}`}>Waiting</span>
                  <span className={styles.waitingTitle}>{labelForWaiting(session)}</span>
                  <span className={styles.waitingMeta}>{labelize(session.provider)}</span>
                  <time dateTime={session.activity_changed_at || session.started_at}>
                    {getRelativeTime(session.activity_changed_at || session.started_at)}
                  </time>
                </>
              );
              return (
                <li key={session.id}>
                  {href ? (
                    <a href={href}>{content}</a>
                  ) : (
                    <button type="button" onClick={() => onOpenGlobalTerminal(session.id)}>
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
            Work <span>{dashboard.rows.length}</span>
          </h2>
        </div>
        <div className={styles.tableScroller}>
          <table>
            <thead>
              <tr>
                <th>Work</th>
                <th>Work ref</th>
                <th>Repository</th>
                <th>Pull requests</th>
                <th>LLM</th>
                <th>Local</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.rows.map((row) => (
                <tr
                  key={`${row.kind}:${row.id}`}
                  tabIndex={0}
                  onClick={() => activateRow(row)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activateRow(row);
                    }
                  }}
                >
                  <td>
                    <span className={styles.workTitle}>{row.title}</span>
                    <span className={`${styles.kind} ${styles[row.kind]}`}>
                      {row.kind === 'work_item'
                        ? 'Work item'
                        : row.kind === 'pull_request'
                          ? 'Pull request'
                          : 'Scratch'}
                    </span>
                  </td>
                  <td>
                    {row.work_reference &&
                      (row.work_reference.url ? (
                        <a
                          className={styles.workReference}
                          href={row.work_reference.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {row.work_reference.display}
                        </a>
                      ) : (
                        <span className={styles.workReference}>{row.work_reference.display}</span>
                      ))}
                  </td>
                  <td>
                    {row.repositories.length > 0 ? (
                      <span className={styles.repositories}>{row.repositories.join(', ')}</span>
                    ) : (
                      <span className={styles.empty}>Unavailable</span>
                    )}
                  </td>
                  <td>
                    {row.pull_requests.length > 0 ? (
                      <span className={styles.pullRequests}>
                        {row.pull_requests.map((pr) => (
                          <span className={styles.pullRequest} key={pr.id}>
                            <a
                              href={pr.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
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
                  <td>
                    <SessionSummary sessions={row.sessions} />
                  </td>
                  <td>
                    {row.workspace_count > 0 ? (
                      <span>
                        {row.workspace_count} {row.workspace_count === 1 ? 'workspace' : 'workspaces'}
                      </span>
                    ) : (
                      <span className={styles.empty}>No workspace</span>
                    )}
                  </td>
                  <td>
                    <time dateTime={row.updated_at}>{getRelativeTime(row.updated_at)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {dashboard.rows.length === 0 &&
            !Object.values(dashboard.sources).some((source) => source.status === 'loading') && (
              <p className={styles.emptyState}>No work is active.</p>
            )}
        </div>
      </section>
    </div>
  );
}
