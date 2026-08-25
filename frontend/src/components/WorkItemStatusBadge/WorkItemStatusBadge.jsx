import { Badge } from '../ui/Badge/Badge.jsx';
import { Spinner } from '../ui/Spinner/Spinner.jsx';
import { WORKING_LABEL, WorkingBadge } from '../ui/WorkingBadge/WorkingBadge.jsx';

export const WORK_ITEM_STATE_LABELS = {
  resolving: 'Resolving',
  preparing: 'Preparing',
  ready: 'Ready',
  error: 'Failed',
  destroying: 'Destroying',
  destroyed: 'Destroyed',
};

const ACTIVE_STATUSES = new Set(['Resolving', 'Preparing', 'Destroying']);

/** @param {{status: string, border?: boolean}} props */
export function WorkItemStatusBadge({ status, border = true }) {
  if (status === WORKING_LABEL) return <WorkingBadge border={border} />;

  const color =
    status === 'Waiting'
      ? 'amber'
      : status === 'Ready'
        ? 'green'
        : status === 'Failed'
          ? 'red'
          : status === 'Stopped' || status === 'Idle' || status === 'Destroyed'
            ? 'gray'
            : ACTIVE_STATUSES.has(status)
              ? 'blue'
              : 'green';
  return (
    <Badge color={color} border={border} pulse={status === 'Waiting'}>
      {ACTIVE_STATUSES.has(status) && <Spinner size="xs" />}
      {status}
    </Badge>
  );
}
