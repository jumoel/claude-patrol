import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { CommandPalette } from './components/CommandPalette/CommandPalette.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { PRRouteDetail } from './components/PRRouteDetail/PRRouteDetail.jsx';
import { SetupMode } from './components/SetupMode/SetupMode.jsx';
import { StartWorkLauncher } from './components/StartWorkLauncher/StartWorkLauncher.jsx';
import { Button } from './components/ui/Button/Button.jsx';
import { WorkDashboard } from './components/WorkDashboard/WorkDashboard.jsx';
import { WorkItemDetail } from './components/WorkItemDetail/WorkItemDetail.jsx';
import { WorkspaceDetail } from './components/WorkspaceDetail/WorkspaceDetail.jsx';
import { useAgentProvider } from './context/AgentProviderContext.jsx';
import { useIdleNotification } from './hooks/useIdleNotification.js';
import { useWorkDashboard } from './hooks/useWorkDashboard.js';
import { fetchConfig } from './lib/api.js';
import { getErrorMessage } from './lib/errors.js';
import { parseAppRoute, pullRequestPath, workItemPath } from './lib/routes.js';

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

/** @type {FilterListKey[]} */
const FILTER_KEYS = ['org', 'repo', 'ci', 'review', 'mergeable', 'draft'];

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
  const pollConfigured = publicConfig?.poll_configured ?? false;
  const workItemsConfigured = publicConfig?.work_items.configured ?? false;
  const { targetStates, dismissedIdle, setActiveTarget, localChangeCount } =
    useIdleNotification(applicationDataEnabled);
  const dashboard = useWorkDashboard({
    enabled: applicationDataEnabled,
    pollConfigured,
    workItemsConfigured,
    changeToken: localChangeCount,
  });
  const { prSource, workItemSource, sessionSource: globalSessionState } = dashboard;
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
  const scratchWorkspaces = dashboard.workspaceSource.workspaces.filter((workspace) => !workspace.pr_id);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [commitsBehind, setCommitsBehind] = useState(0);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [startupSha, setStartupSha] = useState('');
  const [currentSha, setCurrentSha] = useState('');

  const { syncedAt, syncing, countdown, triggerSync, ghRateLimit } = prSource;
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

  const syncTime = syncedAt ? `Last synced ${new Date(syncedAt).toLocaleTimeString()}` : 'Not synced';
  const nextSync = countdown > 0 ? formatCountdown(countdown) : '';

  const navigateToPR = useCallback(
    /** @param {string} prId */ (prId) => {
      const pr = allPRs.find((item) => item.id === prId);
      window.location.hash = pr ? pullRequestPath(pr) : `/pr/${encodeURIComponent(prId)}`;
    },
    [allPRs],
  );

  /** @param {string} wsId */
  const navigateToWorkspace = (wsId) => {
    window.location.hash = `/workspace/${wsId}`;
  };

  /** @param {string} workItemId */
  const navigateToWorkItem = (workItemId) => {
    window.location.hash = workItemPath(workItemId);
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
      onBackToWork={['pr', 'workspace', 'work_item'].includes(route.type) ? navigateBack : undefined}
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
        <WorkItemDetail
          key={route.id}
          workItemId={route.id}
          selectedPrId={route.selectedPrId}
          targetStates={targetStates}
        />
      ) : route.type === 'not_found' ? (
        <div role="alert">
          <p>Page not found</p>
          <Button as="a" href="#/">
            Back to dashboard
          </Button>
        </div>
      ) : (
        <WorkDashboard
          dashboard={dashboard}
          filters={filters}
          onFilterChange={handleFilterChange}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          stackView={stackView}
          onStackViewChange={handleStackViewChange}
          onOpenGlobalTerminal={openGlobalTerminal}
          startWorkLauncher={<StartWorkLauncher workItemsConfigured={workItemsConfigured} />}
        />
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
