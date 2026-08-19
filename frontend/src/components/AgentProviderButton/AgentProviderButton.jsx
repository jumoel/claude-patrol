import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { Button } from '../ui/Button/Button.jsx';
import styles from './AgentProviderButton.module.css';

const SIZE_CLASSES = {
  xs: styles.xs,
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const VARIANT_CLASSES = {
  default: styles.default,
  primary: styles.primary,
};

/**
 * A split action button. The main segment performs the action and the chevron
 * opens the native provider picker without making the provider label compete
 * with the action label.
 *
 * @param {{
 *   children: React.ReactNode,
 *   onClick: () => void,
 *   disabled?: boolean,
 *   providerDisabled?: boolean,
 *   value?: import('../../types').AgentProvider,
 *   dark?: boolean,
 *   active?: boolean,
 *   busy?: boolean,
 *   size?: 'xs' | 'sm' | 'md' | 'lg',
 *   variant?: 'default' | 'primary',
 *   className?: string,
 *   actionClassName?: string,
 * }} props
 */
export function AgentProviderButton({
  children,
  onClick,
  disabled = false,
  providerDisabled = disabled,
  value,
  dark = false,
  active = false,
  busy = false,
  size = 'sm',
  variant = 'primary',
  className = '',
  actionClassName = '',
}) {
  const { provider, setProvider } = useAgentProvider();
  const selectedProvider = value ?? provider;
  const providerName = selectedProvider === 'codex' ? 'Codex' : 'Claude';
  const pickerClasses = [
    styles.picker,
    SIZE_CLASSES[size],
    VARIANT_CLASSES[variant],
    dark && styles.dark,
    active && styles.active,
    providerDisabled && styles.disabled,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={`${styles.group} ${className}`}>
      <Button
        size={size}
        variant={variant}
        dark={dark}
        className={`${styles.action} ${actionClassName}`}
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy}
      >
        {children}
      </Button>
      <span className={pickerClasses}>
        <select
          name="agent-provider"
          className={styles.select}
          aria-label={`Choose agent provider, currently ${providerName}`}
          title={providerDisabled ? 'Kill the current session before changing its provider' : 'Choose agent provider'}
          value={selectedProvider}
          onChange={(event) => setProvider(/** @type {import('../../types').AgentProvider} */ (event.target.value))}
          disabled={providerDisabled}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        <svg
          className={styles.chevron}
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="3.5,5 7,8.5 10.5,5" />
        </svg>
      </span>
    </span>
  );
}
