import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchSessions } from '../lib/api.js';

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
  const request = useRef(/** @type {AbortController | null} */ (null));

  const reload = useCallback(() => {
    if (!enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    fetchSessions(undefined, controller.signal)
      .then((allSessions) => {
        setLoaded(true);
        const globalSessions = globalSessionsFrom(allSessions);
        setSessionState((current) => ({
          allSessions,
          activeSessionId:
            current.activeSessionId && globalSessions.some((session) => session.id === current.activeSessionId)
              ? current.activeSessionId
              : (globalSessions[0]?.id ?? null),
        }));
      })
      .catch((nextError) => {
        if (!isAbort(nextError)) setError(nextError);
      })
      .finally(() => {
        if (request.current === controller) setLoading(false);
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
    return () => request.current?.abort();
  }, [enabled, changeToken, reload]);

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
