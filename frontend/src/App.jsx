import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './App.module.css';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { CommandPalette } from './components/CommandPalette/CommandPalette.jsx';
import { DashboardSummary } from './components/DashboardSummary/DashboardSummary.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { PRRouteDetail } from './components/PRRouteDetail/PRRouteDetail.jsx';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { ScratchWorkspaces } from './components/ScratchWorkspaces/ScratchWorkspaces.jsx';
import { SetupMode } from './components/SetupMode/SetupMode.jsx';
import { StartWorkLauncher } from './components/StartWorkLauncher/StartWorkLauncher.jsx';
import { Button } from './components/ui/Button/Button.jsx';
import { LoadingIndicator } from './components/ui/LoadingIndicator/LoadingIndicator.jsx';
import { WorkItemDetail } from './components/WorkItemDetail/WorkItemDetail.jsx';
import { WorkItems } from './components/WorkItems/WorkItems.jsx';
import { WorkspaceDetail } from './components/WorkspaceDetail/WorkspaceDetail.jsx';
import { useAgentProvider } from './context/AgentProviderContext.jsx';
import { useGlobalSessions } from './hooks/useGlobalSessions.js';
import { useIdleNotification } from './hooks/useIdleNotification.js';
import { usePRs } from './hooks/usePRs.js';
import { useWorkItems } from './hooks/useWorkItems.js';
import { fetchConfig, fetchScratchWorkspaces } from './lib/api.js';
import { getErrorMessage } from './lib/errors.js';
import { parseAppRoute } from './lib/routes.js';

/** @typedef {import('./types').PullRequest} PullRequest */
/** @typedef {import('./types').FilterState} FilterState */
/** @typedef {import('./types').FilterListKey} FilterListKey */
/** @typedef {{ id: string, desc: boolean }} SortState */

/** @param {number} seconds */
function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Apply client-side filters. Each filter key maps to an array of allowed values.
 * Empty array = no filter (show all).
 * @param {PullRequest[]} prs
 * @param {FilterState} filters
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
 * @param {PullRequest[]} prs
 * @returns {PullRequest[]}
 */
function sortByStacks(prs) {
  // Separate stacked and non-stacked
  const stacked = prs.filter((p) => p.is_stacked);
  const nonStacked = prs.filter((p) => !p.is_stacked);

  if (stacked.length === 0) return prs;

  // Group by stack_root
  /** @type {Map<string, PullRequest[]>} */
  const groups = new Map();
  for (const pr of stacked) {
    const root = pr.stack_root;
    const group = groups.get(root);
    if (group) group.push(pr);
    else groups.set(root, [pr]);
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
  /** @type {PullRequest[]} */
  const result = [];
  for (const [, group] of sortedGroups) {
    result.push(...group);
  }
  result.push(...nonStacked);
  return result;
}

/** @type {FilterListKey[]} */
const FILTER_KEYS = ['org', 'repo', 'ci', 'review', 'mergeable', 'draft'];

// Stable filter object so usePRs doesn't see a new ref each render.
const DASHBOARD_FILTERS = Object.freeze({});

/** @returns {{ filters: FilterState, sorting: SortState[], stackView: boolean }} */
function parseHashParams() {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return { filters: {}, sorting: [], stackView: true };
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  /** @type {FilterState} */
  const filters = {};
  for (const key of FILTER_KEYS) {
    const val = params.get(key);
    if (val) filters[key] = val.split(',');
  }
  if (params.get('needsWork') === '1') filters.needsWork = true;
  /** @type {SortState[]} */
  const sorting = [];
  const sortId = params.get('sort');
  if (sortId) {
    sorting.push({ id: sortId, desc: params.get('dir') === 'desc' });
  }
  const stackView = params.get('stacks') !== '0';
  return { filters, sorting, stackView };
}

/**
 * Write filters, sorting, and stack view into the dashboard hash query string.
 * @param {FilterState} filters
 * @param {SortState[]} sorting
 * @param {boolean} stackView
 */
function writeHashParams(filters, sorting, stackView) {
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
  // Use replaceState to avoid polluting history with every filter/sort change
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}${qs ? `#/?${qs}` : ''}`);
}

export default function App() {
  const { applyInstanceDefault } = useAgentProvider();
  const [needsSetup, setNeedsSetup] = useState(/** @type {boolean | null} */ (null));
  const [publicConfig, setPublicConfig] = useState(/** @type {import('./types').PublicConfig | null} */ (null));
  const [configError, setConfigError] = useState('');
  const [route, setRoute] = useState(() => parseAppRoute(window.location.hash));
  const applicationDataEnabled = route.type !== 'setup';
  const initial = useMemo(() => parseHashParams(), []);
  const [filters, setFilters] = useState(initial.filters);
  const [sorting, setSorting] = useState(initial.sorting);
  const [stackView, setStackView] = useState(initial.stackView);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimeout = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const sortedRowsRef = useRef(/** @type {PullRequest[] | null} */ (null));
  const pollConfigured = publicConfig?.poll_configured ?? false;
  const workItemsConfigured = publicConfig?.work_items.configured ?? false;
  const prSource = usePRs(DASHBOARD_FILTERS, applicationDataEnabled && pollConfigured);
  const workItemSource = useWorkItems(applicationDataEnabled);
  const { targetStates, dismissedIdle, setActiveTarget, localChangeCount } =
    useIdleNotification(applicationDataEnabled);
  const globalSessionState = useGlobalSessions(applicationDataEnabled, localChangeCount);
  const toggleTerminal = useCallback(() => setTerminalOpen((prev) => !prev), []);
  const openGlobalTerminal = useCallback(
    /** @param {string} [sessionId] */
    (sessionId) => {
      if (sessionId) globalSessionState.selectSession(sessionId);
      setTerminalOpen(true);
    },
    [globalSessionState.selectSession],
  );
  const closeGlobalTerminal = useCallback(() => setTerminalOpen(false), []);
  const [scratchWorkspaces, setScratchWorkspaces] = useState(/** @type {import('./types').Workspace[]} */ ([]));
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [commitsBehind, setCommitsBehind] = useState(0);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [startupSha, setStartupSha] = useState('');
  const [currentSha, setCurrentSha] = useState('');

  const { syncedAt, loading, error, syncing, countdown, triggerSync, ghRateLimit } = prSource;
  const allPRs = prSource.prs;

  // Check whether either application mode is configured and load update status.
  const loadPublicConfig = useCallback(() => {
    setConfigError('');
    fetchConfig()
      .then((cfg) => {
        applyInstanceDefault(cfg.default_session_provider);
        setPublicConfig(cfg);
        setNeedsSetup(cfg.needs_setup);
        if (cfg.needs_setup && parseAppRoute(window.location.hash).type === 'dashboard') {
          window.location.hash = '/setup';
        }
        setUpdateAvailable(cfg.update_available || false);
        setCommitsBehind(cfg.commits_behind || 0);
        setRestartNeeded(cfg.restart_needed || false);
        if (cfg.startup_sha) setStartupSha(cfg.startup_sha);
        if (cfg.current_sha) setCurrentSha(cfg.current_sha);
      })
      .catch((nextError) => {
        setConfigError(getErrorMessage(nextError, 'Failed to load application configuration'));
        setNeedsSetup(false);
      });
  }, [applyInstanceDefault]);

  useEffect(loadPublicConfig, [loadPublicConfig]);

  // Fetch scratch workspaces (refresh on local changes like workspace creation/deletion)
  useEffect(() => {
    if (!applicationDataEnabled) return;
    void localChangeCount;
    fetchScratchWorkspaces()
      .then(setScratchWorkspaces)
      .catch(() => {});
  }, [applicationDataEnabled, localChangeCount]);

  // Sync filters + sorting to URL hash
  /** @type {(newFilters: FilterState) => void} */
  const handleFilterChange = useCallback(
    (newFilters) => {
      setFilters(newFilters);
      writeHashParams(newFilters, sorting, stackView);
    },
    [sorting, stackView],
  );

  /** @type {import('@tanstack/react-table').OnChangeFn<import('@tanstack/react-table').SortingState>} */
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

  /** @type {(value: boolean) => void} */
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
    /** @param {PullRequest} pr @param {string} [indent] */
    const formatPR = (pr, indent = '') => `${indent}- [#${pr.number}](${pr.url}) - ${pr.title}`;
    let md;
    if (stackView) {
      md = prs
        .map((pr) => {
          const indent = pr.is_stacked ? '    '.repeat(pr.stack_depth) : '';
          return formatPR(pr, indent);
        })
        .join('\n');
    } else {
      md = prs.map((pr) => formatPR(pr)).join('\n');
    }
    navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      if (copiedTimeout.current !== null) clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [filteredPRs, stackView]);

  // Hash-based routing with one discriminated route value.
  useEffect(() => {
    const handleHash = () => {
      const nextRoute = parseAppRoute(window.location.hash);
      setRoute(nextRoute);
      if (nextRoute.type === 'dashboard') {
        const { filters: f, sorting: s, stackView: sv } = parseHashParams();
        setFilters(f);
        setSorting(s);
        setStackView(sv);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  // Opening a detail acknowledges idle state only for that target.
  useEffect(() => {
    if (route.type === 'workspace') setActiveTarget({ type: 'workspace', id: route.id });
    else if (route.type === 'work_item') setActiveTarget({ type: 'work_item', id: route.id });
    else if (route.type === 'pr') {
      const pr = allPRs.find((item) => item.id === route.id);
      setActiveTarget(
        pr?.work_item_id
          ? { type: 'work_item', id: pr.work_item_id }
          : pr?.workspace_id
            ? { type: 'workspace', id: pr.workspace_id }
            : null,
      );
    } else setActiveTarget(null);
  }, [route, allPRs, setActiveTarget]);

  const syncTime = syncedAt ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}` : 'Not synced';
  const nextSync = countdown > 0 ? formatCountdown(countdown) : '';

  const navigateToPR = useCallback(
    /** @param {string} prId */ (prId) => {
      window.location.hash = `/pr/${encodeURIComponent(prId)}`;
    },
    [],
  );

  /** @param {string} wsId */
  const navigateToWorkspace = (wsId) => {
    window.location.hash = `/workspace/${wsId}`;
  };

  /** @param {string} workItemId */
  const navigateToWorkItem = (workItemId) => {
    window.location.hash = `/work-item/${workItemId}`;
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
    window.location.hash = '';
    loadPublicConfig();
  }, [loadPublicConfig]);

  if (needsSetup === null) return null; // still loading config
  if (configError && !publicConfig) {
    return (
      <div role="alert">
        <p>{configError}</p>
        <Button onClick={loadPublicConfig}>Retry</Button>
      </div>
    );
  }

  // ?update=1 forces the update banner visible for testing
  const forceUpdate = new URLSearchParams(window.location.search).get('update') === '1';

  return (
    <AppShell
      title="Claude Patrol"
      syncTime={syncTime}
      nextSync={nextSync}
      syncing={syncing}
      onSync={triggerSync}
      pollConfigured={publicConfig?.poll_configured ?? false}
      terminalOpen={terminalOpen}
      globalSessions={globalSessionState.sessions}
      onToggleTerminal={toggleTerminal}
      onSetup={() => {
        window.location.hash = '/setup';
      }}
      updateAvailable={updateAvailable || forceUpdate}
      commitsBehind={commitsBehind || (forceUpdate ? 3 : 0)}
      restartNeeded={restartNeeded}
      startupSha={startupSha}
      currentSha={currentSha}
      ghRateLimit={ghRateLimit}
    >
      {route.type === 'setup' ? (
        <SetupMode onConfigured={handleConfigured} isFirstRun={needsSetup === true} section={route.section} />
      ) : route.type === 'pr' ? (
        <PRRouteDetail prId={route.id} onBack={navigateBack} targetStates={targetStates} />
      ) : route.type === 'workspace' ? (
        <WorkspaceDetail workspaceId={route.id} onBack={navigateBack} workspaceStates={targetStates} />
      ) : route.type === 'work_item' ? (
        <WorkItemDetail key={route.id} workItemId={route.id} onBack={navigateBack} targetStates={targetStates} />
      ) : route.type === 'not_found' ? (
        <div role="alert">
          <p>Page not found</p>
          <Button as="a" href="#/">
            Back to dashboard
          </Button>
        </div>
      ) : (
        <>
          <DashboardSummary
            prCount={filteredPRs.length}
            pollConfigured={pollConfigured}
            workItems={workItemSource.workItems}
            sessions={globalSessionState.allSessions}
            onOpenGlobalTerminal={openGlobalTerminal}
            changeToken={localChangeCount}
          />
          <StartWorkLauncher workItemsConfigured={workItemsConfigured} />
          {(workItemsConfigured || workItemSource.workItems.length > 0) && (
            <WorkItems
              workItems={workItemSource.workItems}
              loading={workItemSource.loading}
              error={workItemSource.error}
              onRetry={workItemSource.reload}
              targetStates={targetStates}
              dismissedIdle={dismissedIdle}
            />
          )}
          {pollConfigured && (
            <section className={styles.prSection} aria-labelledby="open-prs-heading">
              <h2 id="open-prs-heading" className={styles.prTitle}>
                Open PRs ({filteredPRs.length})
              </h2>
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
              {loading && allPRs.length === 0 && <LoadingIndicator>Loading pull requests...</LoadingIndicator>}
              <PRTable
                prs={filteredPRs}
                onRowClick={navigateToPR}
                sorting={sorting}
                onSortingChange={handleSortingChange}
                workspaceStates={targetStates}
                dismissedIdle={dismissedIdle}
                stackView={stackView}
                sortedRowsRef={sortedRowsRef}
              />
            </section>
          )}
          <ScratchWorkspaces
            scratchWorkspaces={scratchWorkspaces}
            workspaceStates={targetStates}
            dismissedIdle={dismissedIdle}
          />
        </>
      )}
      {applicationDataEnabled && (
        <>
          <GlobalTerminal
            open={terminalOpen}
            onToggle={toggleTerminal}
            sessions={globalSessionState.sessions}
            activeSession={globalSessionState.activeSession}
            loading={globalSessionState.loading}
            loadError={globalSessionState.error}
            onReload={globalSessionState.reload}
            onSelectSession={globalSessionState.selectSession}
            onUpsertSession={globalSessionState.upsertSession}
            onRemoveSession={globalSessionState.removeSession}
          />
          <CommandPalette
            prs={allPRs}
            workItems={workItemSource.workItems}
            scratchWorkspaces={scratchWorkspaces}
            workspaceStates={targetStates}
            dismissedIdle={dismissedIdle}
            globalSessions={globalSessionState.sessions}
            onNavigate={navigateToPR}
            onNavigateWorkspace={navigateToWorkspace}
            onNavigateWorkItem={navigateToWorkItem}
            onOpenGlobalTerminal={openGlobalTerminal}
            onCloseGlobalTerminal={closeGlobalTerminal}
          />
        </>
      )}
    </AppShell>
  );
}
