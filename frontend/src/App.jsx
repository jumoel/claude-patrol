import { usePRs } from './hooks/usePRs.js';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { useState } from 'react';

export default function App() {
  const [filters, setFilters] = useState({});
  const { prs, syncedAt, loading, error, triggerSync } = usePRs(filters);

  return (
    <div>
      <header>
        <h1>Claude Patrol</h1>
        <span>
          {syncedAt ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}` : 'Not synced'}
          {' '}
          <button onClick={triggerSync}>Sync now</button>
        </span>
      </header>
      <FilterBar prs={prs} filters={filters} onFilterChange={setFilters} />
      {error && <p>{error}</p>}
      {loading && prs.length === 0 && <p>Loading...</p>}
      <PRTable prs={prs} />
    </div>
  );
}
