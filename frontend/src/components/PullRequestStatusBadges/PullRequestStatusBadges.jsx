import styles from './PullRequestStatusBadges.module.css';

/** Display labels for CI, review, mergeability and PR state values. @type {Record<string, string>} */
export const PULL_REQUEST_STATUS_LABELS = {
  pass: 'Pass',
  fail: 'Fail',
  pending: 'Pending',
  approved: 'Approved',
  changes_requested: 'Changes',
  MERGEABLE: 'Clean',
  CONFLICTING: 'Conflict',
  UNKNOWN: 'Unknown',
  open: 'Open',
  draft: 'Draft',
  MERGED: 'Merged',
  CLOSED: 'Closed',
  unknown: 'Unknown',
};

/** @param {string} status */
function statusTone(status) {
  if (['pass', 'approved', 'MERGEABLE', 'open'].includes(status)) return 'pass';
  if (['fail', 'changes_requested', 'CONFLICTING'].includes(status)) return 'fail';
  if (status === 'pending') return 'pending';
  if (status === 'MERGED') return 'merged';
  if (status === 'CLOSED') return 'closed';
  return 'neutral';
}

/**
 * The CI / review / mergeability pills for a pull request. `compact` is the
 * dashboard variant: only the CI pill keeps its label, and the PR-state pill
 * appears only for drafts. Merged and closed PRs show their final state
 * instead of CI, review and mergeability pills in every variant.
 * @param {{
 *   pullRequest: Pick<import('../../types').WorkItemPullRequest, 'tracked' | 'ci_status' | 'review_status' | 'mergeable' | 'draft' | 'github_state'> | Pick<import('../../types').PullRequest, 'ci_status' | 'review_status' | 'mergeable' | 'draft' | 'github_state'> | Pick<import('../../types').DashboardPullRequestSummary, 'tracked' | 'ci_status' | 'review_status' | 'mergeable' | 'draft' | 'github_state'>,
 *   includePrState?: boolean,
 *   compact?: boolean,
 * }} props
 */
export function PullRequestStatusBadges({ pullRequest, includePrState = true, compact = false }) {
  if ('tracked' in pullRequest && !pullRequest.tracked) {
    return <span className={`${styles.badge} ${styles.neutral}`}>Waiting for sync</span>;
  }
  let statuses = /** @type {Array<[string, string, boolean]>} */ ([
    ['CI', pullRequest.ci_status ?? 'unknown', true],
    ['Review', pullRequest.review_status ?? 'unknown', !compact],
    ['Merge', pullRequest.mergeable ?? 'UNKNOWN', !compact],
  ]);
  if (includePrState && (!compact || pullRequest.draft))
    statuses.push(['PR', pullRequest.draft ? 'draft' : 'open', !compact]);
  if (pullRequest.github_state === 'MERGED' || pullRequest.github_state === 'CLOSED')
    statuses = [['PR', pullRequest.github_state, !compact]];
  return (
    <span className={styles.badges}>
      {statuses.map(([label, status, showLabel]) => (
        <span
          key={label}
          className={`${styles.badge} ${styles[statusTone(status)]}`}
          aria-label={`${label} ${PULL_REQUEST_STATUS_LABELS[status] || status}`}
        >
          {showLabel && <span>{label}</span>}
          {showLabel ? ' ' : ''}
          {PULL_REQUEST_STATUS_LABELS[status] || status}
        </span>
      ))}
    </span>
  );
}
