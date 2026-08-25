import { Spinner } from '../Spinner/Spinner.jsx';
import styles from './LoadingIndicator.module.css';

/**
 * @param {{as?: 'div' | 'p' | 'span', className?: string, children: React.ReactNode}} props
 */
export function LoadingIndicator({ as: Tag = 'div', className = '', children }) {
  return (
    <Tag className={[styles.indicator, className].filter(Boolean).join(' ')} role="status">
      <Spinner />
      {children}
    </Tag>
  );
}
