import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWorkspaces } from '../lib/api.js';
import { buildDashboardRows, dashboardSourceState } from '../lib/work-dashboard.js';
import { useGlobalSessions } from './useGlobalSessions.js';
import { usePRs } from './usePRs.js';
import { useWorkItems } from './useWorkItems.js';

const DASHBOARD_FILTERS = Object.freeze({});

/** @param {boolean} enabled @param {number} changeToken */
function useDashboardWorkspaces(enabled, changeToken) {
  const [workspaces, setWorkspaces] = useState(/** @type {import('../types').Workspace[]} */ ([]));
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(/** @type {unknown} */ (null));
  const request = useRef(/** @type {AbortController | null} */ (null));

  const reload = useCallback(() => {
    if (!enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    fetchWorkspaces()
      .then((nextWorkspaces) => {
        if (controller.signal.aborted) return;
        setWorkspaces(nextWorkspaces);
        setLoaded(true);
      })
      .catch((nextError) => {
        if (!(nextError instanceof DOMException && nextError.name === 'AbortError')) setError(nextError);
      })
      .finally(() => {
        if (request.current === controller) setLoading(false);
      });
  }, [enabled]);

  useEffect(() => {
    void changeToken;
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    reload();
    return () => request.current?.abort();
  }, [changeToken, enabled, reload]);

  return { workspaces, loading, loaded, error, reload };
}

/**
 * Owns all data needed by the dashboard. Detail routes can keep using their
 * focused hooks without causing a second dashboard request graph.
 *
 * @param {{enabled: boolean, pollConfigured: boolean, workItemsConfigured: boolean, changeToken: number}} input
 */
export function useWorkDashboard({ enabled, pollConfigured, workItemsConfigured, changeToken }) {
  const prSource = usePRs(DASHBOARD_FILTERS, enabled && pollConfigured);
  const workItemSource = useWorkItems(enabled);
  const sessionSource = useGlobalSessions(enabled, changeToken);
  const workspaceSource = useDashboardWorkspaces(enabled, changeToken);

  const rows = useMemo(
    () =>
      buildDashboardRows({
        pullRequests: prSource.prs,
        workItems: workItemSource.workItems,
        workspaces: workspaceSource.workspaces,
        sessions: sessionSource.allSessions,
      }),
    [prSource.prs, sessionSource.allSessions, workItemSource.workItems, workspaceSource.workspaces],
  );
  const sources = {
    pull_requests: dashboardSourceState(prSource.error, prSource.loading, prSource.loaded, pollConfigured),
    work_items: dashboardSourceState(workItemSource.error, workItemSource.loading, workItemSource.loaded),
    workspaces: dashboardSourceState(workspaceSource.error, workspaceSource.loading, workspaceSource.loaded),
    sessions: dashboardSourceState(sessionSource.error, sessionSource.loading, sessionSource.loaded),
  };

  return {
    configured: { pull_requests: pollConfigured, work_items: workItemsConfigured },
    rows,
    sources,
    counts: {
      open_pull_requests: pollConfigured && prSource.loaded ? prSource.prs.length : null,
      work_items: workItemSource.loaded ? workItemSource.workItems.length : null,
      active_workspaces:
        workspaceSource.loaded && workItemSource.loaded
          ? workspaceSource.workspaces.length +
            workItemSource.workItems.reduce(
              (count, item) =>
                count + item.repository_workspaces.filter((workspace) => workspace.state === 'ready').length,
              0,
            )
          : null,
      live_sessions: sessionSource.loaded
        ? sessionSource.allSessions.filter((session) => ['active', 'detached'].includes(session.status)).length
        : null,
    },
    prSource,
    workItemSource,
    workspaceSource,
    sessionSource,
  };
}
