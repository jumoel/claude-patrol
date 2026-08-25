import { Badge } from '../Badge/Badge.jsx';
import { Spinner } from '../Spinner/Spinner.jsx';

export const WORKING_LABEL = 'Working';

/**
 * The canonical indicator for an agent that is actively working.
 *
 * @param {Omit<import('../Badge/Badge.jsx').BadgeProps, 'children' | 'color'>} props
 */
export function WorkingBadge({ title = 'Agent is actively working', ...props }) {
  return (
    <Badge color="violet" title={title} {...props}>
      <Spinner size="xs" />
      {WORKING_LABEL}
    </Badge>
  );
}
