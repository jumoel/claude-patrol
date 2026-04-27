import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { CommandPalette } from './components/CommandPalette/CommandPalette.jsx';
import { DashboardSummary } from './components/DashboardSummary/DashboardSummary.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { PRDetail } from './components/PRDetail/PRDetail.jsx';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { ScratchWorkspaces } from './components/ScratchWorkspaces/ScratchWorkspaces.jsx';
import { SetupMode } from './components/SetupMode/SetupMode.jsx';
import { WorkspaceDetail } from './components/WorkspaceDetail/WorkspaceDetail.jsx';
import { useIdleNotification } from './hooks/useIdleNotification.js';
import { usePRs } from './hooks/usePRs.js';
import { fetchConfig, fetchScratchWorkspaces } from './lib/api.js';

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
  return prs.filter((pr) => {
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

/**
 * Sort PRs so stacked branches appear together in dependency order.
 * Stack roots appear first (sorted by updated_at), followed by their children
 * in depth order. Non-stacked PRs keep their original position.
 */
function sortByStacks(prs) {
  // Separate stacked and non-stacked
  const stacked = prs.filter((p) => p.is_stacked);
  const nonStacked = prs.filter((p) => !p.is_stacked);

  if (stacked.length === 0) return prs;

  // Group by stack_root
  const groups = new Map();
  for (const pr of stacked) {
    const root = pr.stack_root;
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(pr);
  }

  // Sort each group by stack_depth (base first, top last)
  for (const [, group] of groups) {
    group.sort((a, b) => a.stack_depth - b.stack_depth);
  }

  // Sort groups by the most recent updated_at in the group
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const aMax = Math.max(...a[1].map((p) => new Date(p.updated_at).getTime()));
    const bMax = Math.max(...b[1].map((p) => new Date(p.updated_at).getTime()));
    return bMax - aMax;
  });

  // Interleave: stacked groups first, then non-stacked
  const result = [];
  for (const [, group] of sortedGroups) {
    result.push(...group);
  }
  result.push(...nonStacked);
  return result;
}

const NO_FILTERS = {};

const FILTER_KEYS = ['org', 'repo', 'ci', 'review', 'mergeable', 'draft'];

/** Parse filters and sorting from hash query string. */
function parseHashParams() {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return { filters: {}, sorting: [], stackView: true };
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const filters = {};
  for (const key of FILTER_KEYS) {
    const val = params.get(key);
    if (val) filters[key] = val.split(',');
  }
  if (params.get('needsWork') === '1') filters.needsWork = true;
  const sorting = [];
  const sortId = params.get('sort');
  if (sortId) {
    sorting.push({ id: sortId, desc: params.get('dir') === 'desc' });
  }
  const stackView = params.get('stacks') !== '0';
  return { filters, sorting, stackView };
}

/** Write filters, sorting, and stack view into the hash query string, preserving the path. */
function writeHashParams(filters, sorting, stackView) {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    if (filters[key]?.length) params.set(key, filters[key].join(','));
  }
  if (filters.needsWork) params.set('needsWork', '1');
  if (sorting.length > 0) {
    params.set('sort', sorting[0].id);
    params.set('dir', sorting[0].desc ? 'desc' : 'asc');
  }
  if (!stackView) params.set('stacks', '0');
  const qs = params.toString();
  const newHash = qs ? `${path || '#/'}?${qs}` : path || '';
  // Use replaceState to avoid polluting history with every filter/sort change
  history.replaceState(null, '', qs ? newHash : path || window.location.pathname);
}

export default function App() {
  const [needsSetup, setNeedsSetup] = useState(null); // null = loading, true/false
  const [showSetup, setShowSetup] = useState(false);
  const initial = useMemo(() => parseHashParams(), []);
  const [filters, setFilters] = useState(initial.filters);
  const [sorting, setSorting] = useState(initial.sorting);
  const [stackView, setStackView] = useState(initial.stackView);
  const [selectedPR, setSelectedPR] = useState(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [hasGlobalSession, setHasGlobalSession] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimeout = useRef(null);
  const sortedRowsRef = useRef(null);
  const toggleTerminal = useCallback(() => setTerminalOpen((prev) => !prev), []);
  const openGlobalTerminal = useCallback(() => setTerminalOpen(true), []);
  const closeGlobalTerminal = useCallback(() => setTerminalOpen(false), []);
  const { prs: allPRs, syncedAt, loading, error, syncing, countdown, triggerSync } = usePRs(NO_FILTERS);
  const { workspaceStates, dismissedIdle, setActiveWorkspace, localChangeCount } = useIdleNotification();
  const [scratchWorkspaces, setScratchWorkspaces] = useState([]);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [commitsBehind, setCommitsBehind] = useState(0);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [startupSha, setStartupSha] = useState('');
  const [currentSha, setCurrentSha] = useState('');

  // Check if setup is needed + update status (re-check on each sync)
  useEffect(() => {
    fetchConfig()
      .then((cfg) => {
        setNeedsSetup((prev) => (prev === null ? cfg.needs_setup : prev));
        if (cfg.needs_setup && needsSetup === null) setShowSetup(true);
        setUpdateAvailable(cfg.update_available || false);
        setCommitsBehind(cfg.commits_behind || 0);
        setRestartNeeded(cfg.restart_needed || false);
        if (cfg.startup_sha) setStartupSha(cfg.startup_sha);
        if (cfg.current_sha) setCurrentSha(cfg.current_sha);
      })
      .catch(() => {
        if (needsSetup === null) setNeedsSetup(false);
      });
  }, [needsSetup]);

  // Fetch scratch workspaces (refresh on local changes like workspace creation/deletion)
  useEffect(() => {
    fetchScratchWorkspaces()
      .then(setScratchWorkspaces)
      .catch(() => {});
  }, [localChangeCount]);

  // Sync filters + sorting to URL hash
  const handleFilterChange = useCallback(
    (newFilters) => {
      setFilters(newFilters);
      writeHashParams(newFilters, sorting, stackView);
    },
    [sorting, stackView],
  );

  const handleSortingChange = useCallback(
    (updater) => {
      setSorting((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        writeHashParams(filters, next, stackView);
        return next;
      });
    },
    [filters, stackView],
  );

  const handleStackViewChange = useCallback(
    (value) => {
      setStackView(value);
      writeHashParams(filters, sorting, value);
    },
    [filters, sorting],
  );

  const filteredPRs = useMemo(() => {
    const filtered = applyFilters(allPRs, filters);
    return stackView ? sortByStacks(filtered) : filtered;
  }, [allPRs, filters, stackView]);

  const copyFilteredAsMarkdown = useCallback(() => {
    // Use the exact sorted row order from PRTable so markdown always matches the screen
    const prs = sortedRowsRef.current || filteredPRs;
    const formatPR = (pr, indent = '') => {
      let line = `${indent}- [#${pr.number}](${pr.url}) - ${pr.title}`;
      if (pr.pr_summary) line += ` - ${pr.pr_summary}`;
      return line;
    };
    let md;
    if (stackView) {
      md = prs
        .map((pr) => {
          const indent = pr.is_stacked ? '  '.repeat(pr.stack_depth) : '';
          return formatPR(pr, indent);
        })
        .join('\n');
    } else {
      md = prs.map((pr) => formatPR(pr)).join('\n');
    }
    navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [filteredPRs, stackView]);

  // Simple hash-based routing
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash;
      const path = hash.split('?')[0];
      if (path === '#/setup') {
        setShowSetup(true);
        setSelectedPR(null);
        setSelectedWorkspace(null);
      } else if (path.startsWith('#/pr/')) {
        setShowSetup(false);
        setSelectedPR(decodeURIComponent(path.slice(5)));
        setSelectedWorkspace(null);
      } else if (path.startsWith('#/workspace/')) {
        setShowSetup(false);
        setSelectedWorkspace(path.slice(12));
        setSelectedPR(null);
      } else {
        setShowSetup(needsSetup === true);
        setSelectedPR(null);
        setSelectedWorkspace(null);
        // Restore filters + sorting + stack view from URL when returning to dashboard
        const { filters: f, sorting: s, stackView: sv } = parseHashParams();
        setFilters(f);
        setSorting(s);
        setStackView(sv);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [needsSetup]);

  // Track which workspace the user is viewing for idle suppression
  useEffect(() => {
    if (selectedWorkspace) {
      setActiveWorkspace(selectedWorkspace);
    } else if (selectedPR) {
      const pr = allPRs.find((p) => p.id === selectedPR);
      setActiveWorkspace(pr?.workspace_id || null);
    } else {
      setActiveWorkspace(null);
    }
  }, [selectedWorkspace, selectedPR, allPRs, setActiveWorkspace]);

  const syncTime = syncedAt ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}` : 'Not synced';
  const nextSync = countdown > 0 ? formatCountdown(countdown) : '';

  const navigateToPR = (prId) => {
    window.location.hash = `/pr/${encodeURIComponent(prId)}`;
  };

  const navigateToWorkspace = (wsId) => {
    window.location.hash = `/workspace/${wsId}`;
  };

  const navigateBack = useCallback(() => {
    // Build query string preserving current dashboard state
    const params = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      if (filters[key]?.length) params.set(key, filters[key].join(','));
    }
    if (filters.needsWork) params.set('needsWork', '1');
    if (sorting.length > 0) {
      params.set('sort', sorting[0].id);
      params.set('dir', sorting[0].desc ? 'desc' : 'asc');
    }
    if (!stackView) params.set('stacks', '0');
    const qs = params.toString();
    window.location.hash = qs ? `/?${qs}` : '';
  }, [filters, sorting, stackView]);

  const handleConfigured = useCallback(() => {
    setNeedsSetup(false);
    setShowSetup(false);
    window.location.hash = '';
  }, []);

  if (needsSetup === null) return null; // still loading config

  // ?update=1 forces the update banner visible for testing
  const forceUpdate = new URLSearchParams(window.location.search).get('update') === '1';

  return (
    <AppShell
      title="Claude Patrol"
      syncTime={syncTime}
      nextSync={nextSync}
      syncing={syncing}
      onSync={triggerSync}
      terminalOpen={terminalOpen}
      onToggleTerminal={toggleTerminal}
      onSetup={() => {
        window.location.hash = '/setup';
      }}
      updateAvailable={updateAvailable || forceUpdate}
      commitsBehind={commitsBehind || (forceUpdate ? 3 : 0)}
      restartNeeded={restartNeeded}
      startupSha={startupSha}
      currentSha={currentSha}
    >
      {showSetup ? (
        <SetupMode onConfigured={handleConfigured} isFirstRun={needsSetup === true} />
      ) : selectedPR ? (
        <PRDetail prId={selectedPR} onBack={navigateBack} />
      ) : selectedWorkspace ? (
        <WorkspaceDetail workspaceId={selectedWorkspace} onBack={navigateBack} />
      ) : (
        <>
          <DashboardSummary
            prCount={filteredPRs.length}
            syncedAt={syncedAt}
            onOpenGlobalTerminal={openGlobalTerminal}
          />
          <FilterBar
            prs={allPRs}
            filters={filters}
            onFilterChange={handleFilterChange}
            onCopyMarkdown={copyFilteredAsMarkdown}
            copied={copied}
            stackView={stackView}
            onStackViewChange={handleStackViewChange}
          />
          {error && <p>{error}</p>}
          {loading && allPRs.length === 0 && <p>Loading...</p>}
          <PRTable
            prs={filteredPRs}
            onRowClick={navigateToPR}
            sorting={sorting}
            onSortingChange={handleSortingChange}
            workspaceStates={workspaceStates}
            dismissedIdle={dismissedIdle}
            stackView={stackView}
            sortedRowsRef={sortedRowsRef}
          />
          <ScratchWorkspaces
            workspaceStates={workspaceStates}
            dismissedIdle={dismissedIdle}
            localChangeCount={localChangeCount}
          />
        </>
      )}
      <GlobalTerminal open={terminalOpen} onToggle={toggleTerminal} onSessionChange={setHasGlobalSession} />
      <CommandPalette
        prs={allPRs}
        scratchWorkspaces={scratchWorkspaces}
        workspaceStates={workspaceStates}
        dismissedIdle={dismissedIdle}
        hasGlobalSession={hasGlobalSession}
        onNavigate={navigateToPR}
        onNavigateWorkspace={navigateToWorkspace}
        onOpenGlobalTerminal={openGlobalTerminal}
        onCloseGlobalTerminal={closeGlobalTerminal}
      />
    </AppShell>
  );
}
