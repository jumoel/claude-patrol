import { Badge } from '../Badge/Badge.jsx';
import { WorkingBadge } from '../WorkingBadge/WorkingBadge.jsx';

/**
 * @param {{
 *   state?: 'working' | 'idle',
 *   attentionState?: 'working' | 'waiting' | 'idle',
 *   dismissed?: boolean,
 *   border?: boolean,
 *   className?: string,
 * }} props
 */
export function SessionStateBadge({ state, attentionState, dismissed = false, border = true, className }) {
  const resolvedState =
    attentionState ?? (state === 'working' ? 'working' : state === 'idle' && !dismissed ? 'waiting' : state);
  if (resolvedState === 'working') return <WorkingBadge border={border} className={className} />;
  if (resolvedState === 'waiting') {
    return (
      <Badge
        color="amber"
        border={border}
        pulse
        title="Session waiting for input - needs attention"
        className={className}
      >
        Waiting
      </Badge>
    );
  }
  if (resolvedState === 'idle') {
    return (
      <Badge color="gray" border={border} title="Session idle (already seen)" className={className}>
        Idle
      </Badge>
    );
  }
  return null;
}
