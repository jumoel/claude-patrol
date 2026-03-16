import { useEffect, useCallback, useSyncExternalStore } from 'react';

/**
 * Tracks which sessions/workspaces are idle or actively working via SSE events.
 * Fires browser notifications when the tab is hidden.
 *
 * @returns {{
 *   idleSessions: Set<string>,
 *   idleWorkspaces: Set<string>,
 *   workingWorkspaces: Set<string>,
 *   dismissIdle: (sessionId: string) => void,
 *   dismissWorkspace: (workspaceId: string) => void,
 * }}
 */

// Module-level state shared across all hook instances
let idleSessions = new Set();
let idleWorkspaces = new Set();
let workingWorkspaces = new Set();
/** @type {Map<string, string | null>} sessionId -> workspaceId */
const sessionWorkspaceMap = new Map();

const listeners = new Set();
function notify() { for (const cb of listeners) cb(); }
function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }

// Snapshot objects for useSyncExternalStore (must be referentially stable when unchanged)
let sessionsSnapshot = idleSessions;
let idleWsSnapshot = idleWorkspaces;
let workingWsSnapshot = workingWorkspaces;
function getSessionsSnapshot() { return sessionsSnapshot; }
function getIdleWsSnapshot() { return idleWsSnapshot; }
function getWorkingWsSnapshot() { return workingWsSnapshot; }

/** Workspace ID the user is currently viewing (set by the hook consumer). */
let activeWorkspaceId = null;

/** @type {EventSource | null} */
let source = null;
let refCount = 0;

function startSSE() {
  if (source) return;
  source = new EventSource('/api/events');

  // Clear stale state on reconnect - events from before the disconnect
  // may no longer be valid (sessions could have exited while down).
  source.addEventListener('open', () => {
    if (idleSessions.size > 0 || idleWorkspaces.size > 0 || workingWorkspaces.size > 0) {
      idleSessions = new Set();
      idleWorkspaces = new Set();
      workingWorkspaces = new Set();
      sessionWorkspaceMap.clear();
      sessionsSnapshot = idleSessions;
      idleWsSnapshot = idleWorkspaces;
      workingWsSnapshot = workingWorkspaces;
      notify();
    }
  });

  source.addEventListener('session-idle', (event) => {
    const { sessionId, workspaceId } = JSON.parse(event.data);
    sessionWorkspaceMap.set(sessionId, workspaceId);

    // If the user is currently viewing this workspace and the tab is visible, skip
    if (workspaceId && workspaceId === activeWorkspaceId && !document.hidden) return;

    let changed = false;
    if (!idleSessions.has(sessionId)) {
      idleSessions = new Set(idleSessions);
      idleSessions.add(sessionId);
      sessionsSnapshot = idleSessions;
      changed = true;
    }
    if (workspaceId && !idleWorkspaces.has(workspaceId)) {
      idleWorkspaces = new Set(idleWorkspaces);
      idleWorkspaces.add(workspaceId);
      idleWsSnapshot = idleWorkspaces;
      changed = true;
    }
    // Remove from working when going idle
    if (workspaceId && workingWorkspaces.has(workspaceId)) {
      workingWorkspaces = new Set(workingWorkspaces);
      workingWorkspaces.delete(workspaceId);
      workingWsSnapshot = workingWorkspaces;
      changed = true;
    }
    if (changed) notify();

    if (Notification.permission === 'granted' && document.hidden) {
      new Notification('Claude is waiting', {
        body: 'A terminal session needs your attention.',
        tag: `patrol-idle-${sessionId}`,
      });
    }
  });

  source.addEventListener('session-active', (event) => {
    const { sessionId, workspaceId: eventWsId, exited } = JSON.parse(event.data);
    const workspaceId = eventWsId || sessionWorkspaceMap.get(sessionId) || null;

    if (exited) {
      sessionWorkspaceMap.delete(sessionId);
    } else {
      sessionWorkspaceMap.set(sessionId, workspaceId);
    }

    let changed = false;
    if (idleSessions.has(sessionId)) {
      idleSessions = new Set(idleSessions);
      idleSessions.delete(sessionId);
      sessionsSnapshot = idleSessions;
      changed = true;
    }
    if (workspaceId && idleWorkspaces.has(workspaceId)) {
      idleWorkspaces = new Set(idleWorkspaces);
      idleWorkspaces.delete(workspaceId);
      idleWsSnapshot = idleWorkspaces;
      changed = true;
    }
    if (exited) {
      // Session ended - remove from working
      if (workspaceId && workingWorkspaces.has(workspaceId)) {
        workingWorkspaces = new Set(workingWorkspaces);
        workingWorkspaces.delete(workspaceId);
        workingWsSnapshot = workingWorkspaces;
        changed = true;
      }
    } else {
      // Session actively producing output - mark as working
      if (workspaceId && !workingWorkspaces.has(workspaceId)) {
        workingWorkspaces = new Set(workingWorkspaces);
        workingWorkspaces.add(workspaceId);
        workingWsSnapshot = workingWorkspaces;
        changed = true;
      }
    }
    if (changed) notify();
  });
}

function stopSSE() {
  if (source) {
    source.close();
    source = null;
  }
}

export function useIdleNotification() {
  useEffect(() => {
    refCount++;
    startSSE();
    return () => {
      refCount--;
      if (refCount === 0) stopSSE();
    };
  }, []);

  const sessions = useSyncExternalStore(subscribe, getSessionsSnapshot);
  const idleWs = useSyncExternalStore(subscribe, getIdleWsSnapshot);
  const workingWs = useSyncExternalStore(subscribe, getWorkingWsSnapshot);

  const dismissIdle = useCallback((sessionId) => {
    const workspaceId = sessionWorkspaceMap.get(sessionId);
    let changed = false;
    if (idleSessions.has(sessionId)) {
      idleSessions = new Set(idleSessions);
      idleSessions.delete(sessionId);
      sessionsSnapshot = idleSessions;
      changed = true;
    }
    if (workspaceId && idleWorkspaces.has(workspaceId)) {
      idleWorkspaces = new Set(idleWorkspaces);
      idleWorkspaces.delete(workspaceId);
      idleWsSnapshot = idleWorkspaces;
      changed = true;
    }
    if (changed) notify();
  }, []);

  const dismissWorkspace = useCallback((workspaceId) => {
    let changed = false;
    if (idleWorkspaces.has(workspaceId)) {
      idleWorkspaces = new Set(idleWorkspaces);
      idleWorkspaces.delete(workspaceId);
      idleWsSnapshot = idleWorkspaces;
      changed = true;
    }
    // Also dismiss any sessions belonging to this workspace
    for (const [sid, wsId] of sessionWorkspaceMap) {
      if (wsId === workspaceId && idleSessions.has(sid)) {
        idleSessions = new Set(idleSessions);
        idleSessions.delete(sid);
        sessionsSnapshot = idleSessions;
        changed = true;
      }
    }
    if (changed) notify();
  }, []);

  const setActiveWorkspace = useCallback((wsId) => {
    activeWorkspaceId = wsId;
    // Auto-dismiss if the workspace was idle
    if (wsId) dismissWorkspace(wsId);
  }, [dismissWorkspace]);

  return {
    idleSessions: sessions,
    idleWorkspaces: idleWs,
    workingWorkspaces: workingWs,
    dismissIdle,
    dismissWorkspace,
    setActiveWorkspace,
  };
}
