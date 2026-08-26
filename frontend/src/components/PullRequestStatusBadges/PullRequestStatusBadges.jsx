import styles from './PullRequestStatusBadges.module.css';

/** @type {Record<string, string>} */
const STATUS_LABELS = {
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
};

/** @param {string} status */
function statusTone(status) {
  if (['pass', 'approved', 'MERGEABLE', 'open'].includes(status)) return 'pass';
  if (['fail', 'changes_requested', 'CONFLICTING'].includes(status)) return 'fail';
  if (status === 'pending') return 'pending';
  return 'neutral';
}

/**
 * @param {{pullRequest: Pick<import('../../types').WorkItemPullRequest, 'tracked' | 'ci_status' | 'review_status' | 'mergeable' | 'draft'> | Pick<import('../../types').PullRequest, 'ci_status' | 'review_status' | 'mergeable' | 'draft'>}} props
 */
export function PullRequestStatusBadges({ pullRequest }) {
  if ('tracked' in pullRequest && !pullRequest.tracked) {
    return <span className={`${styles.badge} ${styles.neutral}`}>Waiting for sync</span>;
  }
  const statuses = [
    ['CI', pullRequest.ci_status],
    ['Review', pullRequest.review_status],
    ['Merge', pullRequest.mergeable],
    ['PR', pullRequest.draft ? 'draft' : 'open'],
  ];
  return (
    <span className={styles.badges}>
      {statuses.map(([label, status]) => (
        <span
          key={label}
          className={`${styles.badge} ${styles[statusTone(status)]}`}
          aria-label={`${label} ${STATUS_LABELS[status] || status}`}
        >
          <span>{label}</span> {STATUS_LABELS[status] || status}
        </span>
      ))}
    </span>
  );
}
