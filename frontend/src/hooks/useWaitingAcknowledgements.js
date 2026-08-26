import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'claude-patrol-waiting-ack-v1';

function readStoredAcknowledgements() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).filter(
        ([sessionId, timestamp]) => typeof sessionId === 'string' && typeof timestamp === 'string',
      ),
    );
  } catch {
    return new Map();
  }
}

/** @param {Map<string, string>} acknowledgements */
function writeStoredAcknowledgements(acknowledgements) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(acknowledgements)));
}

/** @param {import('../types').Session[]} sessions @param {boolean} reconciled */
export function useWaitingAcknowledgements(sessions, reconciled) {
  const [acknowledgedIdle, setAcknowledgedIdle] = useState(readStoredAcknowledgements);

  useEffect(() => {
    const onStorage = (/** @type {StorageEvent} */ event) => {
      if (event.key === STORAGE_KEY) setAcknowledgedIdle(readStoredAcknowledgements());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (!reconciled) return;
    setAcknowledgedIdle((current) => {
      const next = new Map();
      for (const session of sessions) {
        if (
          ['active', 'detached'].includes(session.status) &&
          session.activity_state === 'idle' &&
          session.activity_changed_at &&
          current.get(session.id) === session.activity_changed_at
        ) {
          next.set(session.id, session.activity_changed_at);
        }
      }
      if (
        next.size === current.size &&
        [...next].every(([sessionId, timestamp]) => current.get(sessionId) === timestamp)
      ) {
        return current;
      }
      writeStoredAcknowledgements(next);
      return next;
    });
  }, [reconciled, sessions]);

  const acknowledge = useCallback(
    /** @param {string} sessionId */ (sessionId) => {
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (session?.activity_state !== 'idle' || !session.activity_changed_at) return;
      setAcknowledgedIdle((current) => {
        const next = new Map(current).set(session.id, session.activity_changed_at);
        writeStoredAcknowledgements(next);
        return next;
      });
    },
    [sessions],
  );

  return useMemo(() => ({ acknowledgedIdle, acknowledge }), [acknowledge, acknowledgedIdle]);
}
