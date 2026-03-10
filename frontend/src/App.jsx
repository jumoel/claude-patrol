import { usePRs } from './hooks/usePRs.js';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { DashboardSummary } from './components/DashboardSummary/DashboardSummary.jsx';
import { PRDetail } from './components/PRDetail/PRDetail.jsx';
import { useState, useEffect } from 'react';

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

export default function App() {
  const [filters, setFilters] = useState({});
  const [selectedPR, setSelectedPR] = useState(null);
  const { prs, syncedAt, loading, error, syncing, countdown, triggerSync } = usePRs(filters);

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

  const syncTime = syncedAt
    ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}`
    : 'Not synced';
  const nextSync = countdown > 0 ? formatCountdown(countdown) : '';

  const navigateToPR = (prId) => {
    window.location.hash = `/pr/${encodeURIComponent(prId)}`;
  };

  const navigateBack = () => {
    window.location.hash = '';
  };

  return (
    <AppShell title="Claude Patrol" syncTime={syncTime} nextSync={nextSync} syncing={syncing} onSync={triggerSync}>
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
