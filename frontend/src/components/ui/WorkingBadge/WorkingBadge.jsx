import { Badge } from '../Badge/Badge.jsx';
import { Spinner } from '../Spinner/Spinner.jsx';
import styles from './WorkingBadge.module.css';

export const WORKING_LABEL = 'Working';

/**
 * The canonical indicator for an agent that is actively working.
 *
 * @param {Omit<import('../Badge/Badge.jsx').BadgeProps, 'children' | 'color'> & {
 *   presentation?: 'badge' | 'inline',
 *   label?: string,
 *   spinnerSize?: 'xxs' | 'xs' | 'sm',
 * }} props
 */
export function WorkingBadge({
  title = 'Agent is actively working',
  presentation = 'badge',
  label = WORKING_LABEL,
  spinnerSize = 'xs',
  className,
  border = true,
  pulse = false,
  ...props
}) {
  const stateIndicator = <Spinner size={spinnerSize} />;
  if (presentation === 'inline') {
    return (
      <span className={[styles.inline, className].filter(Boolean).join(' ')} title={title} {...props}>
        {stateIndicator}
        {label}
      </span>
    );
  }
  return (
    <Badge color="violet" title={title} className={className} border={border} pulse={pulse} {...props}>
      {stateIndicator}
      {label}
    </Badge>
  );
}
