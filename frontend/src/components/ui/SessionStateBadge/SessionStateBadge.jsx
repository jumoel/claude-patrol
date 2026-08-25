import { Badge } from '../Badge/Badge.jsx';
import { WorkingBadge } from '../WorkingBadge/WorkingBadge.jsx';

/**
 * @param {{state?: 'working' | 'idle', dismissed?: boolean, border?: boolean}} props
 */
export function SessionStateBadge({ state, dismissed = false, border = true }) {
  if (state === 'working') return <WorkingBadge border={border} />;
  if (state === 'idle' && !dismissed) {
    return (
      <Badge color="amber" border={border} pulse title="Session waiting for input - needs attention">
        Waiting
      </Badge>
    );
  }
  if (state === 'idle' && dismissed) {
    return (
      <Badge color="gray" border={border} title="Session idle (already seen)">
        Idle
      </Badge>
    );
  }
  return null;
}
