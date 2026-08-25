import { getErrorMessage } from '../../lib/errors.js';
import { getRelativeTime } from '../../lib/time.js';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { WORKING_LABEL } from '../ui/WorkingBadge/WorkingBadge.jsx';
import { WORK_ITEM_STATE_LABELS, WorkItemStatusBadge } from '../WorkItemStatusBadge/WorkItemStatusBadge.jsx';
import styles from './WorkItems.module.css';

/**
 * @param {import('../../types').WorkItemListItem} item
 * @param {Map<string, 'working' | 'idle'>} [targetStates]
 * @param {Set<string>} [dismissedIdle]
 */
export function workItemStatus(item, targetStates, dismissedIdle) {
  if (item.state !== 'ready') return WORK_ITEM_STATE_LABELS[item.state] ?? item.state;
  if (!item.session) return item.has_session_history ? 'Stopped' : 'Ready';
  const key = `work-item:${item.id}`;
  const activity = targetStates?.get(key) ?? item.session.activity_state;
  if (activity === 'working') return WORKING_LABEL;
  if (activity === 'idle') return dismissedIdle?.has(key) ? 'Idle' : 'Waiting';
  return 'Running';
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
        <LoadingIndicator className={styles.placeholder}>Loading work items...</LoadingIndicator>
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
                      <WorkItemStatusBadge status={status} border={false} />
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
