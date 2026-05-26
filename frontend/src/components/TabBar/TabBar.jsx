import styles from './TabBar.module.css';

/**
 * Top-of-dashboard tab strip distinguishing "PRs I authored" from
 * "PRs I've been asked to review". Each tab gets its own accent colour so
 * the two surfaces don't visually blur even when the body content looks
 * structurally similar.
 *
 * @param {{
 *   activeTab: 'authored' | 'reviews',
 *   onChange: (tab: 'authored' | 'reviews') => void,
 *   authoredCount: number,
 *   reviewCount: number,
 * }} props
 */
export function TabBar({ activeTab, onChange, authoredCount, reviewCount }) {
  return (
    <div className={styles.bar}>
      <div className={styles.inner}>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'authored' ? `${styles.tabActive} ${styles.authoredActive}` : ''}`}
          onClick={() => onChange('authored')}
          aria-pressed={activeTab === 'authored'}
        >
          <svg
            className={styles.icon}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M11 1.5L14.5 5L6 13.5L1.5 14.5L2.5 10L11 1.5Z" />
          </svg>
          My PRs
          <span className={styles.count}>{authoredCount}</span>
        </button>
        <button
          type="button"
          className={`${styles.tab} ${activeTab === 'reviews' ? `${styles.tabActive} ${styles.reviewActive}` : ''}`}
          onClick={() => onChange('reviews')}
          aria-pressed={activeTab === 'reviews'}
        >
          <svg
            className={styles.icon}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="8" cy="6" r="2.5" />
            <path d="M3 14a5 5 0 0 1 10 0" />
          </svg>
          Review requests
          <span className={styles.count}>{reviewCount}</span>
        </button>
      </div>
    </div>
  );
}
