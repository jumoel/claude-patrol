import { usePRs } from './hooks/usePRs.js';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { DashboardSummary } from './components/DashboardSummary/DashboardSummary.jsx';
import { PRDetail } from './components/PRDetail/PRDetail.jsx';
import { useState, useEffect } from 'react';

export default function App() {
  const [filters, setFilters] = useState({});
  const [selectedPR, setSelectedPR] = useState(null);
  const { prs, syncedAt, loading, error, triggerSync } = usePRs(filters);

  // Simple hash-based routing
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#/pr/')) {
        setSelectedPR(decodeURIComponent(hash.slice(5)));
      } else {
        setSelectedPR(null);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  const syncStatus = syncedAt
    ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}`
    : 'Not synced';

  const navigateToPR = (prId) => {
    window.location.hash = `/pr/${encodeURIComponent(prId)}`;
  };

  const navigateBack = () => {
    window.location.hash = '';
  };

  return (
    <AppShell title="Claude Patrol" syncStatus={syncStatus} onSync={triggerSync}>
      {selectedPR ? (
        <PRDetail prId={selectedPR} onBack={navigateBack} />
      ) : (
        <>
          <DashboardSummary prCount={prs.length} syncedAt={syncedAt} />
          <FilterBar prs={prs} filters={filters} onFilterChange={setFilters} />
          {error && <p>{error}</p>}
          {loading && prs.length === 0 && <p>Loading...</p>}
          <PRTable prs={prs} onRowClick={navigateToPR} />
        </>
      )}
      <GlobalTerminal />
    </AppShell>
  );
}
