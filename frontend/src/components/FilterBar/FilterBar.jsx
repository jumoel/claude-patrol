import styles from './FilterBar.module.css';

/**
 * Filter controls for the PR table.
 * @param {{ prs: object[], filters: Record<string, string>, onFilterChange: (filters: Record<string, string>) => void }} props
 */
export function FilterBar({ prs, filters, onFilterChange }) {
  const orgs = [...new Set(prs.map(p => p.org))].sort();
  const repos = [...new Set(prs.map(p => p.repo))].sort();
  const ciStatuses = ['pass', 'fail', 'pending'];
  const reviewStatuses = ['approved', 'changes_requested', 'pending'];

  const update = (key, value) => {
    onFilterChange({ ...filters, [key]: value });
  };

  return (
    <div className={styles.bar}>
      <select
        className={styles.select}
        value={filters.org || 'all'}
        onChange={(e) => update('org', e.target.value)}
      >
        <option value="all">All orgs</option>
        {orgs.map(o => <option key={o} value={o}>{o}</option>)}
      </select>

      <select
        className={styles.select}
        value={filters.repo || 'all'}
        onChange={(e) => update('repo', e.target.value)}
      >
        <option value="all">All repos</option>
        {repos.map(r => <option key={r} value={r}>{r}</option>)}
      </select>

      <select
        className={styles.select}
        value={filters.ci || 'all'}
        onChange={(e) => update('ci', e.target.value)}
      >
        <option value="all">All CI</option>
        {ciStatuses.map(s => <option key={s} value={s}>{s}</option>)}
      </select>

      <select
        className={styles.select}
        value={filters.review || 'all'}
        onChange={(e) => update('review', e.target.value)}
      >
        <option value="all">All reviews</option>
        {reviewStatuses.map(s => <option key={s} value={s}>{s}</option>)}
      </select>

      <select
        className={styles.select}
        value={filters.draft || 'all'}
        onChange={(e) => update('draft', e.target.value)}
      >
        <option value="all">All PRs</option>
        <option value="true">Drafts only</option>
        <option value="false">No drafts</option>
      </select>
    </div>
  );
}
