import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { subscribeAppEvent } from '../lib/event-stream.js';

/**
 * Tracks session activity state (working/idle) per workspace via SSE.
 * Fires browser notifications when a session goes idle and the tab is hidden.
 *
 * workspaceStates always reflects the true backend state.
 * dismissedIdle tracks workspaces whose idle state the user has already seen,
 * so the UI can downgrade "Waiting" to "Session" after acknowledgment.
 *
 * @returns {{
 *   workspaceStates: Map<string, 'working' | 'idle'>,
 *   dismissedIdle: Set<string>,
 *   dismissWorkspace: (workspaceId: string) => void,
 *   setActiveWorkspace: (workspaceId: string | null) => void,
 *   localChangeCount: number,
 * }}
 */

// Module-level state shared across all hook instances.
/** @type {Map<string, 'working' | 'idle'>} */
let workspaceStates = new Map();
/** @type {Set<string>} workspaceIds whose idle state was acknowledged */
let dismissedIdle = new Set();
/** @type {Map<string, string | null>} sessionId → workspaceId */
const sessionWorkspaceMap = new Map();
/** Monotonic counter incremented on each local-change SSE event. */
let localChangeCount = 0;

/** @type {Set<() => void>} */
const listeners = new Set();
function notify() {
  for (const cb of listeners) cb();
}
/** @param {() => void} cb */
function subscribe(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let statesSnapshot = workspaceStates;
let dismissedSnapshot = dismissedIdle;
function getStatesSnapshot() {
  return statesSnapshot;
}
function getDismissedSnapshot() {
  return dismissedSnapshot;
}
function getLocalChangeSnapshot() {
  return localChangeCount;
}

/** @type {Array<() => void>} */
let sseUnsubscribers = [];
let refCount = 0;

function startSSE() {
  if (sseUnsubscribers.length > 0) return;

  // Clear stale state on reconnect.
  const onOpen = subscribeAppEvent('open', () => {
    if (workspaceStates.size > 0 || dismissedIdle.size > 0) {
      workspaceStates = new Map();
      dismissedIdle = new Set();
      sessionWorkspaceMap.clear();
      statesSnapshot = workspaceStates;
      dismissedSnapshot = dismissedIdle;
      notify();
    }
  });

  const onLocalChange = subscribeAppEvent('local-change', () => {
    localChangeCount++;
    notify();
  });

  const onSessionState = subscribeAppEvent('session-state', (event) => {
    /** @type {{sessionId: string, workspaceId: string | null, state: 'working' | 'idle' | 'exited'}} */
    const { sessionId, workspaceId, state } = JSON.parse(event.data);

    if (state === 'exited') {
      sessionWorkspaceMap.delete(sessionId);
      let changed = false;
      if (workspaceId && workspaceStates.has(workspaceId)) {
        workspaceStates = new Map(workspaceStates);
        workspaceStates.delete(workspaceId);
        statesSnapshot = workspaceStates;
        changed = true;
      }
      if (workspaceId && dismissedIdle.has(workspaceId)) {
        dismissedIdle = new Set(dismissedIdle);
        dismissedIdle.delete(workspaceId);
        dismissedSnapshot = dismissedIdle;
        changed = true;
      }
      if (changed) notify();
      return;
    }

    sessionWorkspaceMap.set(sessionId, workspaceId);
    if (!workspaceId) return;

    let changed = false;

    if (workspaceStates.get(workspaceId) !== state) {
      workspaceStates = new Map(workspaceStates);
      workspaceStates.set(workspaceId, state);
      statesSnapshot = workspaceStates;
      changed = true;
    }

    // When a workspace goes back to working, clear its dismissal
    // so the next idle shows "Waiting" fresh.
    if (state === 'working' && dismissedIdle.has(workspaceId)) {
      dismissedIdle = new Set(dismissedIdle);
      dismissedIdle.delete(workspaceId);
      dismissedSnapshot = dismissedIdle;
      changed = true;
    }

    if (changed) notify();
  });
  sseUnsubscribers = [onOpen, onLocalChange, onSessionState];
}

function stopSSE() {
  for (const unsubscribe of sseUnsubscribers) unsubscribe();
  sseUnsubscribers = [];
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
  const dismissed = useSyncExternalStore(subscribe, getDismissedSnapshot);
  const localChanges = useSyncExternalStore(subscribe, getLocalChangeSnapshot);

  const dismissWorkspace = useCallback(
    /** @param {string} workspaceId */ (workspaceId) => {
      if (workspaceId && workspaceStates.get(workspaceId) === 'idle' && !dismissedIdle.has(workspaceId)) {
        dismissedIdle = new Set(dismissedIdle);
        dismissedIdle.add(workspaceId);
        dismissedSnapshot = dismissedIdle;
        notify();
      }
    },
    [],
  );

  const setActiveWorkspace = useCallback(
    /** @param {string | null} wsId */
    (wsId) => {
      if (wsId) dismissWorkspace(wsId);
    },
    [dismissWorkspace],
  );

  return {
    workspaceStates: states,
    dismissedIdle: dismissed,
    dismissWorkspace,
    setActiveWorkspace,
    localChangeCount: localChanges,
  };
}
