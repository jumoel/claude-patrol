import { getErrorMessage } from '../../lib/errors.js';
import { pullRequestIdPath } from '../../lib/routes.js';
import { getRelativeTime } from '../../lib/time.js';
import styles from './ReviewRequests.module.css';

/** @param {{ source: ReturnType<typeof import('../../hooks/useReviewRequests.js').useReviewRequests> }} props */
export function ReviewRequests({ source }) {
  const { page, rows, loading, error, busy, toggle, retry, loadMore } = source;
  return (
    <section aria-labelledby="review-requests-heading" className={styles.section}>
      <header className={styles.header}>
        <h2 id="review-requests-heading">Review requested {page && <span>{page.total_count}</span>}</h2>
        <button type="button" onClick={() => void retry()} disabled={loading}>
          Refresh
        </button>
      </header>
      {!!error && <p role="alert">{getErrorMessage(error, 'Could not load review requests')}</p>}
      {!page && !error && <p role="status">Loading review requests...</p>}
      {page && !page.source.identity_verified && <p role="status">Waiting to verify the GitHub account.</p>}
      {page?.source.stale && (
        <p role="status">Review requests are awaiting a successful sync. Cached items may be outdated.</p>
      )}
      {page?.source.incomplete && (
        <p role="status">Review coverage is incomplete. Remaining work will continue within the quota budget.</p>
      )}
      {page?.source.errors.map((failure) => (
        <p key={failure.target} role="status">
          {failure.target}: {failure.message}
        </p>
      ))}
      {page && !rows.length && page.source.synced_at && !page.source.stale && !page.source.incomplete && (
        <p>No review requests match your configured users and teams.</p>
      )}
      {rows.map((row) => (
        <article key={row.id} className={styles.card}>
          <div className={styles.summary}>
            <button
              type="button"
              className={styles.toggle}
              aria-expanded={!row.collapsed}
              aria-controls={`review-${row.id}`}
              disabled={busy.has(row.id)}
              onClick={() => void toggle(row)}
              aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${row.title}`}
            >
              {busy.has(row.id) ? 'Saving...' : row.collapsed ? '▸' : '▾'}
            </button>
            <div>
              <a href={`#${pullRequestIdPath(row.id)}`}>{row.title}</a>
              <div className={styles.metadata}>
                {row.org}/{row.repo} #{row.number} · {row.author}
              </div>
              <div className={styles.targets}>
                {row.targets.map((target) => (
                  <span key={target.id}>
                    {target.label}
                    {target.active ? '' : ' (request removed)'}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {row.verification_pending && <p className={styles.warning}>Revision or request verification is pending.</p>}
          {!row.collapsed && (
            <div id={`review-${row.id}`} className={styles.details}>
              <span>Updated {getRelativeTime(row.updated_at)}</span>
              {row.targets
                .filter((target) => target.requested_at)
                .map((target) => (
                  <span key={target.id}>
                    {target.label} requested {getRelativeTime(target.requested_at ?? '')}
                  </span>
                ))}
              <a href={`#${pullRequestIdPath(row.id)}`}>View PR</a>
            </div>
          )}
        </article>
      ))}
      {page?.next_cursor && (
        <button type="button" onClick={() => void loadMore()} disabled={loading}>
          {loading ? 'Loading...' : 'Load more'}
        </button>
      )}
    </section>
  );
}
