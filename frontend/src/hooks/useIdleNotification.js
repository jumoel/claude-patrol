import { useEffect, useSyncExternalStore } from 'react';
import { subscribeAppEvent } from '../lib/event-stream.js';
import { sessionTargetKey } from '../lib/session-target.js';

/**
 * Tracks session activity state per workspace or work item via SSE.
 *
 * targetStates always reflects the true backend state.
 * @returns {{
 *   targetStates: Map<string, 'working' | 'idle'>,
 *   localChangeCount: number,
 * }}
 */

// Module-level state shared across all hook instances.
/** @type {Map<string, 'working' | 'idle'>} */
let targetStates = new Map();
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
function getStatesSnapshot() {
  return statesSnapshot;
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
    if (targetStates.size > 0) {
      targetStates = new Map();
      statesSnapshot = targetStates;
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
  const localChanges = useSyncExternalStore(subscribe, getLocalChangeSnapshot);

  return {
    targetStates: states,
    localChangeCount: localChanges,
  };
}
