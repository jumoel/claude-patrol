import { useCallback, useEffect, useState } from 'react';
import { createSession, fetchSessions, killSession, reattachSession } from '../lib/api.js';
import { getErrorMessage } from '../lib/errors.js';

/**
 * The agent session attached to one target (PR workspace, scratch workspace
 * or work item) with the handlers every detail page hands to TerminalCard.
 *
 * The page decides when and for which target to `load`, because each page
 * discovers its target differently; the hook owns the state transitions and
 * turns every failure into `actionError` instead of an unhandled rejection.
 *
 * @param {{
 *   onAcknowledgeSession?: (sessionId: string) => void,
 *   onChange?: () => void,
 * }} [options] `onChange` runs after a session starts, stops or exits so the
 *   page can refresh the data that depends on it.
 */
export function useTargetSession({ onAcknowledgeSession, onChange } = {}) {
  const [session, setSession] = useState(/** @type {import('../types').Session | null} */ (null));
  const [actionError, setActionError] = useState('');

  /**
   * Load the current session for a target. Resolves with the chosen session
   * (the one matching `preferredId` when present, else the first).
   * @param {import('../types').SessionTarget} target
   * @param {{ preferredId?: string | null, signal?: AbortSignal }} [options]
   */
  const load = useCallback(
    async (
      /** @type {import('../types').SessionTarget} */ target,
      /** @type {{ preferredId?: string | null, signal?: AbortSignal }} */ { preferredId = null, signal } = {},
    ) => {
      const sessions = await fetchSessions(target, signal);
      const next = sessions.find((candidate) => candidate.id === preferredId) ?? sessions[0] ?? null;
      setSession(next);
      return next;
    },
    [],
  );

  /**
   * Start a session for a target. Rejects on failure so the caller can decide
   * how to present a launch problem (it usually has a dedicated message).
   * @param {import('../types').SessionTarget} target
   * @param {import('../types').AgentProvider} provider
   */
  const start = useCallback(
    async (
      /** @type {import('../types').SessionTarget} */ target,
      /** @type {import('../types').AgentProvider} */ provider,
    ) => {
      const created = await createSession(target, provider);
      setSession(created);
      onChange?.();
      return created;
    },
    [onChange],
  );

  const kill = useCallback(async () => {
    if (!session) return;
    setActionError('');
    try {
      await killSession(session.id);
      setSession(null);
      onChange?.();
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to stop terminal'));
    }
  }, [onChange, session]);

  const reattach = useCallback(async () => {
    if (!session) return;
    setActionError('');
    try {
      setSession(await reattachSession(session.id));
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to reattach terminal'));
    }
  }, [session]);

  const handleExit = useCallback(() => {
    setSession(null);
    onChange?.();
  }, [onChange]);

  useEffect(() => {
    if (session && onAcknowledgeSession) onAcknowledgeSession(session.id);
  }, [onAcknowledgeSession, session]);

  return { session, setSession, actionError, setActionError, load, start, kill, reattach, handleExit };
}
