import { useEffect, useCallback, useSyncExternalStore } from 'react';

/**
 * Tracks session activity state (working/idle) per workspace via SSE.
 * Fires browser notifications when a session goes idle and the tab is hidden.
 *
 * @returns {{
 *   workspaceStates: Map<string, 'working' | 'idle'>,
 *   dismissWorkspace: (workspaceId: string) => void,
 *   setActiveWorkspace: (workspaceId: string | null) => void,
 * }}
 */

// Module-level state shared across all hook instances.
// Single map: workspaceId → 'working' | 'idle'. Absent = no known state.
/** @type {Map<string, 'working' | 'idle'>} */
let workspaceStates = new Map();
/** @type {Map<string, string | null>} sessionId → workspaceId */
const sessionWorkspaceMap = new Map();

const listeners = new Set();
function notify() { for (const cb of listeners) cb(); }
function subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); }

let statesSnapshot = workspaceStates;
function getStatesSnapshot() { return statesSnapshot; }

/** Workspace ID the user is currently viewing. */
let activeWorkspaceId = null;

/** @type {EventSource | null} */
let source = null;
let refCount = 0;

function startSSE() {
  if (source) return;
  source = new EventSource('/api/events');

  // Clear stale state on reconnect.
  source.addEventListener('open', () => {
    if (workspaceStates.size > 0) {
      workspaceStates = new Map();
      sessionWorkspaceMap.clear();
      statesSnapshot = workspaceStates;
      notify();
    }
  });

  source.addEventListener('session-state', (event) => {
    const { sessionId, workspaceId, state } = JSON.parse(event.data);

    if (state === 'exited') {
      sessionWorkspaceMap.delete(sessionId);
      if (workspaceId && workspaceStates.has(workspaceId)) {
        workspaceStates = new Map(workspaceStates);
        workspaceStates.delete(workspaceId);
        statesSnapshot = workspaceStates;
        notify();
      }
      return;
    }

    sessionWorkspaceMap.set(sessionId, workspaceId);
    if (!workspaceId) return;

    // Skip idle notification if the user is currently viewing this workspace
    if (state === 'idle' && workspaceId === activeWorkspaceId && !document.hidden) return;

    if (workspaceStates.get(workspaceId) !== state) {
      workspaceStates = new Map(workspaceStates);
      workspaceStates.set(workspaceId, state);
      statesSnapshot = workspaceStates;
      notify();
    }

    if (state === 'idle' && Notification.permission === 'granted' && document.hidden) {
      new Notification('Claude is waiting', {
        body: 'A terminal session needs your attention.',
        tag: `patrol-idle-${workspaceId}`,
      });
    }
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

  const states = useSyncExternalStore(subscribe, getStatesSnapshot);

  const dismissWorkspace = useCallback((workspaceId) => {
    if (workspaceStates.has(workspaceId)) {
      workspaceStates = new Map(workspaceStates);
      workspaceStates.delete(workspaceId);
      statesSnapshot = workspaceStates;
      notify();
    }
  }, []);

  const setActiveWorkspace = useCallback((wsId) => {
    activeWorkspaceId = wsId;
    // Auto-dismiss idle badge when the user views the workspace
    if (wsId && workspaceStates.get(wsId) === 'idle') dismissWorkspace(wsId);
  }, [dismissWorkspace]);

  return { workspaceStates: states, dismissWorkspace, setActiveWorkspace };
}
