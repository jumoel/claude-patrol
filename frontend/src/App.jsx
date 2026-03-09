import { usePRs } from './hooks/usePRs.js';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { useState } from 'react';

export default function App() {
  const [filters, setFilters] = useState({});
  const { prs, syncedAt, loading, error, triggerSync } = usePRs(filters);

  const syncStatus = syncedAt
    ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}`
    : 'Not synced';

  return (
    <AppShell title="Claude Patrol" syncStatus={syncStatus} onSync={triggerSync}>
      <FilterBar prs={prs} filters={filters} onFilterChange={setFilters} />
      {error && <p>{error}</p>}
      {loading && prs.length === 0 && <p>Loading...</p>}
      <PRTable prs={prs} />
      <GlobalTerminal />
    </AppShell>
  );
}
