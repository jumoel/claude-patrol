import styles from './StatusBadge.module.css';

const LABELS = {
  pass: 'Pass',
  fail: 'Fail',
  pending: 'Pending',
  approved: 'Approved',
  changes_requested: 'Changes',
  unknown: 'Unknown',
  MERGEABLE: 'Clean',
  CONFLICTING: 'Conflict',
  UNKNOWN: 'Unknown',
  draft: 'Draft',
  open: 'Ready',
};

/**
 * Colored status indicator pill.
 * @param {{ status: string, type?: 'ci' | 'review' }} props
 */
export function StatusBadge({ status, type = 'ci' }) {
  const variant = `${type}-${status}`;
  return <span className={`${styles.badge} ${styles[variant] || styles.neutral}`}>{LABELS[status] || status}</span>;
}
