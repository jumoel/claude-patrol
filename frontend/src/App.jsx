import { usePRs } from './hooks/usePRs.js';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { DashboardSummary } from './components/DashboardSummary/DashboardSummary.jsx';
import { PRDetail } from './components/PRDetail/PRDetail.jsx';
import { WorkspaceDetail } from './components/WorkspaceDetail/WorkspaceDetail.jsx';
import { ScratchWorkspaces } from './components/ScratchWorkspaces/ScratchWorkspaces.jsx';
import { CommandPalette } from './components/CommandPalette/CommandPalette.jsx';
import { SetupMode } from './components/SetupMode/SetupMode.jsx';
import { fetchScratchWorkspaces, fetchConfig } from './lib/api.js';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Apply client-side filters. Each filter key maps to an array of allowed values.
 * Empty array = no filter (show all).
 */
function applyFilters(prs, filters) {
  return prs.filter(pr => {
    // "Needs work" is a meta-filter: show only PRs that need attention
    // (failing CI, conflicts, or drafts)
    if (filters.needsWork) {
      const isGood = pr.ci_status === 'pass' && pr.mergeable === 'MERGEABLE' && !pr.draft;
      if (isGood) return false;
    }
    if (filters.org?.length && !filters.org.includes(pr.org)) return false;
    if (filters.repo?.length && !filters.repo.includes(pr.repo)) return false;
    if (filters.ci?.length && !filters.ci.includes(pr.ci_status)) return false;
    if (filters.review?.length && !filters.review.includes(pr.review_status)) return false;
    if (filters.mergeable?.length && !filters.mergeable.includes(pr.mergeable)) return false;
    if (filters.draft?.length) {
      const isDraft = pr.draft ? 'true' : 'false';
      if (!filters.draft.includes(isDraft)) return false;
    }
    return true;
  });
}

const NO_FILTERS = {};

export default function App() {
  const [needsSetup, setNeedsSetup] = useState(null); // null = loading, true/false
  const [showSetup, setShowSetup] = useState(false);
  const [filters, setFilters] = useState({});
  const [selectedPR, setSelectedPR] = useState(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimeout = useRef(null);
  const toggleTerminal = useCallback(() => setTerminalOpen(prev => !prev), []);
  const { prs: allPRs, syncedAt, loading, error, syncing, countdown, triggerSync } = usePRs(NO_FILTERS);
  const [scratchWorkspaces, setScratchWorkspaces] = useState([]);

  // Check if setup is needed on mount
  useEffect(() => {
    fetchConfig()
      .then(cfg => {
        setNeedsSetup(cfg.needs_setup);
        if (cfg.needs_setup) setShowSetup(true);
      })
      .catch(() => setNeedsSetup(false));
  }, []);

  // Fetch scratch workspaces (refresh when PRs sync)
  useEffect(() => {
    fetchScratchWorkspaces()
      .then(setScratchWorkspaces)
      .catch(() => {});
  }, [syncedAt]);

  const filteredPRs = useMemo(() => applyFilters(allPRs, filters), [allPRs, filters]);

  const copyFilteredAsMarkdown = useCallback(() => {
    const md = filteredPRs
      .map(pr => `- [#${pr.number}](${pr.url}) - ${pr.title}`)
      .join('\n');
    navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [filteredPRs]);

  // Simple hash-based routing
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash;
      if (hash === '#/setup') {
        setShowSetup(true);
        setSelectedPR(null);
        setSelectedWorkspace(null);
      } else if (hash.startsWith('#/pr/')) {
        setShowSetup(false);
        setSelectedPR(decodeURIComponent(hash.slice(5)));
        setSelectedWorkspace(null);
      } else if (hash.startsWith('#/workspace/')) {
        setShowSetup(false);
        setSelectedWorkspace(hash.slice(12));
        setSelectedPR(null);
      } else {
        setShowSetup(needsSetup === true);
        setSelectedPR(null);
        setSelectedWorkspace(null);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [needsSetup]);

  const syncTime = syncedAt
    ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}`
    : 'Not synced';
  const nextSync = countdown > 0 ? formatCountdown(countdown) : '';

  const navigateToPR = (prId) => {
    window.location.hash = `/pr/${encodeURIComponent(prId)}`;
  };

  const navigateToWorkspace = (wsId) => {
    window.location.hash = `/workspace/${wsId}`;
  };

  const navigateBack = () => {
    window.location.hash = '';
  };

  const handleConfigured = useCallback(() => {
    setNeedsSetup(false);
    setShowSetup(false);
    window.location.hash = '';
  }, []);

  if (needsSetup === null) return null; // still loading config

  return (
    <AppShell title="Claude Patrol" syncTime={syncTime} nextSync={nextSync} syncing={syncing} onSync={triggerSync} terminalOpen={terminalOpen} onToggleTerminal={toggleTerminal} onSetup={() => { window.location.hash = '/setup'; }}>
      {showSetup ? (
        <SetupMode onConfigured={handleConfigured} isFirstRun={needsSetup === true} />
      ) : selectedPR ? (
        <PRDetail prId={selectedPR} onBack={navigateBack} />
      ) : selectedWorkspace ? (
        <WorkspaceDetail workspaceId={selectedWorkspace} onBack={navigateBack} />
      ) : (
        <>
          <DashboardSummary prCount={filteredPRs.length} syncedAt={syncedAt} />
          <FilterBar prs={allPRs} filters={filters} onFilterChange={setFilters} onCopyMarkdown={copyFilteredAsMarkdown} copied={copied} />
          {error && <p>{error}</p>}
          {loading && allPRs.length === 0 && <p>Loading...</p>}
          <PRTable prs={filteredPRs} onRowClick={navigateToPR} />
          <ScratchWorkspaces prs={allPRs} syncedAt={syncedAt} />
        </>
      )}
      <GlobalTerminal open={terminalOpen} onToggle={toggleTerminal} />
      <CommandPalette prs={allPRs} scratchWorkspaces={scratchWorkspaces} onNavigate={navigateToPR} onNavigateWorkspace={navigateToWorkspace} />
    </AppShell>
  );
}
