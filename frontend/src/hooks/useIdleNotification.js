import { useEffect, useCallback, useSyncExternalStore } from 'react';

/**
 * Tracks which sessions/workspaces are idle via SSE events. Fires browser
 * notifications when the tab is hidden. Returns idle state and a dismiss function.
 *
 * @returns {{
 *   idleSessions: Set<string>,
 *   idleWorkspaces: Set<string>,
 *   dismissIdle: (sessionId: string) => void,
 *   dismissWorkspace: (workspaceId: string) => void,
 * }}
 */

// Module-level state shared across all hook instances
let idleSessions = new Set();
let idleWorkspaces = new Set();
/** @type {Map<string, string | null>} sessionId -> workspaceId */
const sessionWorkspaceMap = new Map();

const listeners = new Set();
function notify() { for (const cb of listeners) cb(); }
function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }

// Snapshot objects for useSyncExternalStore (must be referentially stable when unchanged)
let sessionsSnapshot = idleSessions;
let workspacesSnapshot = idleWorkspaces;
function getSessionsSnapshot() { return sessionsSnapshot; }
function getWorkspacesSnapshot() { return workspacesSnapshot; }

/** @type {EventSource | null} */
let source = null;
let refCount = 0;

function startSSE() {
  if (source) return;
  source = new EventSource('/api/events');

  source.addEventListener('session-idle', (event) => {
    const { sessionId, workspaceId } = JSON.parse(event.data);
    sessionWorkspaceMap.set(sessionId, workspaceId);

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
      workspacesSnapshot = idleWorkspaces;
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
    const { sessionId } = JSON.parse(event.data);
    const workspaceId = sessionWorkspaceMap.get(sessionId);
    sessionWorkspaceMap.delete(sessionId);

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
      workspacesSnapshot = idleWorkspaces;
      changed = true;
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
  const workspaces = useSyncExternalStore(subscribe, getWorkspacesSnapshot);

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
      workspacesSnapshot = idleWorkspaces;
      changed = true;
    }
    if (changed) notify();
  }, []);

  const dismissWorkspace = useCallback((workspaceId) => {
    let changed = false;
    if (idleWorkspaces.has(workspaceId)) {
      idleWorkspaces = new Set(idleWorkspaces);
      idleWorkspaces.delete(workspaceId);
      workspacesSnapshot = idleWorkspaces;
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

  return { idleSessions: sessions, idleWorkspaces: workspaces, dismissIdle, dismissWorkspace };
}
