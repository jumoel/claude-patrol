import { getErrorMessage } from '../../lib/errors.js';
import { getRelativeTime } from '../../lib/time.js';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import styles from './WorkItems.module.css';

const LIFECYCLE_LABELS = {
  resolving: 'Resolving',
  preparing: 'Preparing',
  error: 'Failed',
  destroying: 'Destroying',
  destroyed: 'Destroyed',
};

/**
 * @param {import('../../types').WorkItemListItem} item
 * @param {Map<string, 'working' | 'idle'>} [targetStates]
 * @param {Set<string>} [dismissedIdle]
 */
export function workItemStatus(item, targetStates, dismissedIdle) {
  if (item.state !== 'ready') return LIFECYCLE_LABELS[item.state] ?? item.state;
  if (!item.session) return item.has_session_history ? 'Stopped' : 'Ready';
  const key = `work-item:${item.id}`;
  const activity = targetStates?.get(key) ?? item.session.activity_state;
  if (activity === 'working') return 'Working';
  if (activity === 'idle') return dismissedIdle?.has(key) ? 'Idle' : 'Waiting';
  return 'Running';
}

/** @param {{status: string}} props */
function StatusBadge({ status }) {
  const color =
    status === 'Working'
      ? 'violet'
      : status === 'Waiting'
        ? 'amber'
        : status === 'Ready'
          ? 'green'
          : status === 'Failed'
            ? 'red'
            : status === 'Stopped' || status === 'Idle'
              ? 'gray'
              : status === 'Resolving' || status === 'Preparing' || status === 'Destroying'
                ? 'blue'
                : 'green';
  return (
    <Badge color={color} pulse={status === 'Waiting'}>
      {status}
    </Badge>
  );
}

/**
 * @param {{
 *   workItems: import('../../types').WorkItemListItem[],
 *   loading: boolean,
 *   error: unknown,
 *   onRetry: () => void,
 *   targetStates?: Map<string, 'working' | 'idle'>,
 *   dismissedIdle?: Set<string>,
 * }} props
 */
export function WorkItems({ workItems, loading, error, onRetry, targetStates, dismissedIdle }) {
  return (
    <section className={styles.container} aria-labelledby="work-items-heading">
      <h2 id="work-items-heading" className={styles.title}>
        Work Items ({workItems.length})
      </h2>
      {loading ? (
        <div className={styles.placeholder} aria-busy="true">
          Loading work items...
        </div>
      ) : error ? (
        <div className={styles.error} role="alert">
          <span>{getErrorMessage(error, 'Failed to load work items')}</span>
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : workItems.length === 0 ? (
        <p className={styles.empty}>No work items</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Work item</th>
                <th>Repositories</th>
                <th>Status</th>
                <th>Agent</th>
                <th className={styles.right}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {workItems.map((item) => {
                const status = workItemStatus(item, targetStates, dismissedIdle);
                const shownRepositories = item.repositories.slice(0, 2);
                return (
                  <tr
                    key={item.id}
                    onClick={() => {
                      window.location.hash = `/work-item/${item.id}`;
                    }}
                  >
                    <td>
                      <a href={`#/work-item/${item.id}`} onClick={(event) => event.stopPropagation()}>
                        <span className={styles.itemTitle}>{item.title || item.reference}</span>
                        <span className={styles.reference}>{item.title ? item.reference : 'Resolving...'}</span>
                      </a>
                    </td>
                    <td>
                      <div className={styles.repositories}>
                        {shownRepositories.map((repository) => (
                          <span key={repository}>{repository}</span>
                        ))}
                        {item.repositories.length > 2 && <span>+{item.repositories.length - 2}</span>}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={status} />
                    </td>
                    <td className={styles.agent}>{item.work_provider === 'codex' ? 'Codex' : 'Claude'}</td>
                    <td className={styles.right}>{getRelativeTime(item.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
