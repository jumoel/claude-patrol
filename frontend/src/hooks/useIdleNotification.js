import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { subscribeAppEvent } from '../lib/event-stream.js';
import { sessionTargetKey } from '../lib/session-target.js';

/**
 * Tracks session activity state per workspace or work item via SSE.
 *
 * targetStates always reflects the true backend state.
 * dismissedIdle tracks targets whose idle state the user has already seen,
 * so the UI can downgrade "Waiting" to "Idle" after acknowledgment.
 *
 * @returns {{
 *   targetStates: Map<string, 'working' | 'idle'>,
 *   dismissedIdle: Set<string>,
 *   dismissTarget: (target: import('../types').SessionTarget) => void,
 *   setActiveTarget: (target: import('../types').SessionTarget | null) => void,
 *   localChangeCount: number,
 * }}
 */

// Module-level state shared across all hook instances.
/** @type {Map<string, 'working' | 'idle'>} */
let targetStates = new Map();
/** @type {Set<string>} target keys whose idle state was acknowledged */
let dismissedIdle = new Set();
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

let statesSnapshot = targetStates;
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
    if (targetStates.size > 0 || dismissedIdle.size > 0) {
      targetStates = new Map();
      dismissedIdle = new Set();
      statesSnapshot = targetStates;
      dismissedSnapshot = dismissedIdle;
      notify();
    }
  });

  const onLocalChange = subscribeAppEvent('local-change', () => {
    localChangeCount++;
    notify();
  });

  const onSessionState = subscribeAppEvent('session-state', (event) => {
    /** @type {{sessionId: string, target: import('../types').SessionTarget, state: 'working' | 'idle' | 'exited'}} */
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    const { target, state } = payload;
    if (!['working', 'idle', 'exited'].includes(state)) return;
    const targetKey = sessionTargetKey(target);

    if (state === 'exited') {
      let changed = false;
      if (targetKey && targetStates.has(targetKey)) {
        targetStates = new Map(targetStates);
        targetStates.delete(targetKey);
        statesSnapshot = targetStates;
        changed = true;
      }
      if (targetKey && dismissedIdle.has(targetKey)) {
        dismissedIdle = new Set(dismissedIdle);
        dismissedIdle.delete(targetKey);
        dismissedSnapshot = dismissedIdle;
        changed = true;
      }
      if (changed) notify();
      return;
    }

    if (!targetKey) return;

    let changed = false;

    if (targetStates.get(targetKey) !== state) {
      targetStates = new Map(targetStates);
      targetStates.set(targetKey, state);
      statesSnapshot = targetStates;
      changed = true;
    }

    // When a target goes back to working, clear its dismissal
    // so the next idle shows "Waiting" fresh.
    if (state === 'working' && dismissedIdle.has(targetKey)) {
      dismissedIdle = new Set(dismissedIdle);
      dismissedIdle.delete(targetKey);
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

export function useIdleNotification(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    refCount++;
    startSSE();
    return () => {
      refCount--;
      if (refCount === 0) stopSSE();
    };
  }, [enabled]);

  const states = useSyncExternalStore(subscribe, getStatesSnapshot);
  const dismissed = useSyncExternalStore(subscribe, getDismissedSnapshot);
  const localChanges = useSyncExternalStore(subscribe, getLocalChangeSnapshot);

  const dismissTarget = useCallback(
    /** @param {import('../types').SessionTarget} target */ (target) => {
      const targetKey = sessionTargetKey(target);
      if (targetKey && targetStates.get(targetKey) === 'idle' && !dismissedIdle.has(targetKey)) {
        dismissedIdle = new Set(dismissedIdle);
        dismissedIdle.add(targetKey);
        dismissedSnapshot = dismissedIdle;
        notify();
      }
    },
    [],
  );

  const setActiveTarget = useCallback(
    /** @param {import('../types').SessionTarget | null} target */
    (target) => {
      if (target) dismissTarget(target);
    },
    [dismissTarget],
  );

  return {
    targetStates: states,
    dismissedIdle: dismissed,
    dismissTarget,
    setActiveTarget,
    localChangeCount: localChanges,
  };
}
