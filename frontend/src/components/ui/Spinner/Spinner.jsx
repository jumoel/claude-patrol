import styles from './Spinner.module.css';

/**
 * @param {{size?: 'xxs' | 'xs' | 'sm', className?: string}} props
 */
export function Spinner({ size = 'sm', className = '' }) {
  return (
    <span
      className={[styles.spinner, styles[size], className].filter(Boolean).join(' ')}
      aria-hidden="true"
      data-spinner="true"
    />
  );
}
