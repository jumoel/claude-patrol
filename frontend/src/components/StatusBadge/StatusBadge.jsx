import { PULL_REQUEST_STATUS_LABELS as LABELS } from '../PullRequestStatusBadges/PullRequestStatusBadges.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';

/** Maps type-status to a Badge color. */
/** @type {Record<string, 'green' | 'red' | 'yellow' | 'gray'>} */
const COLOR_MAP = {
  'ci-pass': 'green',
  'ci-fail': 'red',
  'ci-pending': 'yellow',
  'review-approved': 'green',
  'review-changes_requested': 'red',
  'review-pending': 'gray',
  'merge-MERGEABLE': 'green',
  'merge-CONFLICTING': 'red',
  'merge-UNKNOWN': 'gray',
  'status-draft': 'gray',
  'status-open': 'green',
};

/**
 * Colored status indicator pill.
 * @param {{ status: string, type?: 'ci' | 'review' | 'merge' | 'status' }} props
 */
export function StatusBadge({ status, type = 'ci' }) {
  const variant = `${type}-${status}`;
  const color = COLOR_MAP[variant] || 'gray';
  return (
    <Badge color={color} border={false}>
      {LABELS[status] || status}
    </Badge>
  );
}
