import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSessions } from '../lib/api.js';
import { subscribeAppEvent } from '../lib/event-stream.js';

/** @param {unknown} error */
function isAbort(error) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** @param {import('../types').Session[]} allSessions */
function globalSessionsFrom(allSessions) {
  return allSessions
    .filter((session) => session.target.type === 'global')
    .sort((a, b) => a.started_at.localeCompare(b.started_at) || a.id.localeCompare(b.id));
}

/**
 * Fetching all sessions here lets the dashboard and global tabs share one
 * request on each local-change event.
 * @param {boolean} enabled
 * @param {number} changeToken
 */
export function useGlobalSessions(enabled, changeToken) {
  const [sessionState, setSessionState] = useState(
    /** @type {{allSessions: import('../types').Session[], activeSessionId: string | null}} */ ({
      allSessions: [],
      activeSessionId: null,
    }),
  );
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(/** @type {unknown} */ (null));
  const request = useRef(
    /** @type {{controller: AbortController, activityUpdates: Map<string, Pick<import('../types').Session, 'activity_state' | 'activity_changed_at' | 'activity_message'>>} | null} */ (
      null
    ),
  );

  const reload = useCallback(() => {
    if (!enabled) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    const pending = { controller, activityUpdates: new Map() };
    request.current = pending;
    setLoading(true);
    setError(null);
    fetchSessions(undefined, controller.signal)
      .then((allSessions) => {
        if (controller.signal.aborted) return;
        const reconciledSessions = allSessions.map((session) => {
          const activityUpdate = pending.activityUpdates.get(session.id);
          return activityUpdate ? { ...session, ...activityUpdate } : session;
        });
        setLoaded(true);
        const globalSessions = globalSessionsFrom(reconciledSessions);
        setSessionState((current) => ({
          allSessions: reconciledSessions,
          activeSessionId:
            current.activeSessionId && globalSessions.some((session) => session.id === current.activeSessionId)
              ? current.activeSessionId
              : (globalSessions[0]?.id ?? null),
        }));
      })
      .catch((nextError) => {
        if (request.current === pending && !controller.signal.aborted && !isAbort(nextError)) setError(nextError);
      })
      .finally(() => {
        if (request.current === pending) {
          request.current = null;
          setLoading(false);
        }
      });
  }, [enabled]);

  useEffect(() => {
    void changeToken;
    if (!enabled) {
      setSessionState({ allSessions: [], activeSessionId: null });
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    reload();
    return () => request.current?.controller.abort();
  }, [enabled, changeToken, reload]);

  useEffect(() => {
    if (!enabled) return undefined;
    return subscribeAppEvent('session-state', (event) => {
      /** @type {{sessionId?: unknown, state?: unknown, activity_changed_at?: unknown, activity_message?: unknown}} */
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof payload.sessionId !== 'string' || (payload.state !== 'working' && payload.state !== 'idle')) {
        return;
      }

      const activityState = payload.state;
      const activityChangedAt = typeof payload.activity_changed_at === 'string' ? payload.activity_changed_at : null;
      const activityMessage = typeof payload.activity_message === 'string' ? payload.activity_message : null;
      /** @type {Pick<import('../types').Session, 'activity_state' | 'activity_changed_at' | 'activity_message'>} */
      const activityUpdate = {
        activity_state: activityState,
        activity_changed_at: activityChangedAt,
        activity_message: activityMessage,
      };
      request.current?.activityUpdates.set(payload.sessionId, activityUpdate);
      setSessionState((current) => {
        const index = current.allSessions.findIndex((session) => session.id === payload.sessionId);
        if (index === -1) return current;
        const session = current.allSessions[index];
        if (
          session.activity_state === activityState &&
          session.activity_changed_at === activityChangedAt &&
          session.activity_message === activityMessage
        ) {
          return current;
        }
        const allSessions = [...current.allSessions];
        allSessions[index] = {
          ...session,
          ...activityUpdate,
        };
        return { ...current, allSessions };
      });
    });
  }, [enabled]);

  const selectSession = useCallback(
    /** @param {string} sessionId */ (sessionId) =>
      setSessionState((current) => ({ ...current, activeSessionId: sessionId })),
    [],
  );

  const upsertSession = useCallback(
    /** @param {import('../types').Session} session @param {boolean} [select] */ (session, select = false) => {
      setSessionState((current) => {
        const allSessions = current.allSessions.some((entry) => entry.id === session.id)
          ? current.allSessions.map((entry) => (entry.id === session.id ? session : entry))
          : [...current.allSessions, session];
        return {
          allSessions,
          activeSessionId: select ? session.id : current.activeSessionId,
        };
      });
    },
    [],
  );

  const removeSession = useCallback(
    /** @param {string} sessionId */
    (sessionId) => {
      setSessionState((current) => {
        const globalSessions = globalSessionsFrom(current.allSessions);
        const index = globalSessions.findIndex((session) => session.id === sessionId);
        if (index === -1) return current;
        const remainingGlobalSessions = globalSessions.filter((session) => session.id !== sessionId);
        return {
          allSessions: current.allSessions.filter((session) => session.id !== sessionId),
          activeSessionId:
            current.activeSessionId === sessionId
              ? (remainingGlobalSessions[index]?.id ?? remainingGlobalSessions[index - 1]?.id ?? null)
              : current.activeSessionId,
        };
      });
    },
    [],
  );

  const sessions = useMemo(() => globalSessionsFrom(sessionState.allSessions), [sessionState.allSessions]);
  const activeSession = sessions.find((session) => session.id === sessionState.activeSessionId) ?? null;

  return {
    allSessions: sessionState.allSessions,
    sessions,
    activeSession,
    activeSessionId: sessionState.activeSessionId,
    loading,
    loaded,
    error,
    reload,
    selectSession,
    upsertSession,
    removeSession,
  };
}
