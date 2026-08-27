import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import {
  createSession as apiCreateSession,
  killSession as apiKillSession,
  reattachSession as apiReattachSession,
  renameSession as apiRenameSession,
  promoteSession,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { clearMaximizedTerminal, maximizedTerminalId, replaceMaximizedTerminal } from '../../lib/terminal-url.js';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { RepoCombobox } from '../ui/RepoCombobox/RepoCombobox.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './GlobalTerminal.module.css';

const BAR_HEIGHT = 43;

/**
 * @param {string | null} sessionId
 * @param {unknown} error
 * @param {string} fallback
 */
function actionFailure(sessionId, error, fallback) {
  return { sessionId, message: getErrorMessage(error, fallback) };
}

/**
 * Inactive tabs rely on tmux replay so each extra session does not keep an
 * xterm renderer and WebSocket mounted.
 * @param {{
 *   open: boolean,
 *   onToggle: () => void,
 *   sessions: import('../../types').Session[],
 *   activeSession: import('../../types').Session | null,
 *   loading: boolean,
 *   loadError: unknown,
 *   onReload: () => void,
 *   onSelectSession: (sessionId: string) => void,
 *   onUpsertSession: (session: import('../../types').Session, select?: boolean) => void,
 *   onRemoveSession: (sessionId: string) => void,
 * }} props
 */
export function GlobalTerminal({
  open,
  onToggle,
  sessions,
  activeSession,
  loading,
  loadError,
  onReload,
  onSelectSession,
  onUpsertSession,
  onRemoveSession,
}) {
  const { provider } = useAgentProvider();
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState(
    /** @type {{sessionId: string | null, message: string} | null} */ (null),
  );
  const [showPromote, setShowPromote] = useState(false);
  const [promoteRepo, setPromoteRepo] = useState('');
  const [promoteBranch, setPromoteBranch] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [reattaching, setReattaching] = useState(false);
  const [killing, setKilling] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const sessionMutationPending = killing || reattaching || promoting || savingName;
  const previousActiveSessionId = useRef(activeSession?.id);
  const drawerRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  useEffect(() => {
    if (loading) return undefined;

    const restoreFromUrl = () => {
      const sessionId = maximizedTerminalId();
      const requestedSession = sessions.find((session) => session.id === sessionId);
      if (!requestedSession) {
        return;
      }
      if (activeSession?.id !== requestedSession.id) onSelectSession(requestedSession.id);
      if (!open) onToggle();
    };

    restoreFromUrl();
    window.addEventListener('hashchange', restoreFromUrl);
    return () => window.removeEventListener('hashchange', restoreFromUrl);
  }, [activeSession?.id, loading, onSelectSession, onToggle, open, sessions]);

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return undefined;
    const root = document.documentElement;
    const updateHeight = () => {
      const height = Math.max(BAR_HEIGHT, Math.round(drawer.getBoundingClientRect().height));
      root.style.setProperty('--global-terminal-height', `${height}px`);
    };
    updateHeight();
    if (typeof ResizeObserver === 'undefined') {
      return () => root.style.removeProperty('--global-terminal-height');
    }
    const observer = new ResizeObserver(updateHeight);
    observer.observe(drawer);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--global-terminal-height');
    };
  }, []);

  useEffect(() => {
    if (previousActiveSessionId.current === activeSession?.id) return;
    previousActiveSessionId.current = activeSession?.id;
    setShowPromote(false);
    setRenaming(false);
  }, [activeSession?.id]);

  const startSession = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setActionError(null);
    try {
      const created = await apiCreateSession({ type: 'global' }, provider);
      onUpsertSession(created, true);
    } catch (error) {
      setActionError(actionFailure(null, error, `Failed to start ${provider === 'codex' ? 'Codex' : 'Claude'}`));
    } finally {
      setStarting(false);
    }
  }, [onUpsertSession, provider, starting]);

  const createSession = useCallback(() => {
    if (!open) onToggle();
    void startSession();
  }, [onToggle, open, startSession]);

  const killSession = useCallback(async () => {
    if (!activeSession || sessionMutationPending) return;
    setKilling(true);
    setActionError(null);
    try {
      await apiKillSession(activeSession.id);
      if (maximizedTerminalId() === activeSession.id) clearMaximizedTerminal(activeSession.id);
      onRemoveSession(activeSession.id);
    } catch (error) {
      setActionError(actionFailure(activeSession.id, error, 'Failed to kill session'));
    } finally {
      setKilling(false);
    }
  }, [activeSession, onRemoveSession, sessionMutationPending]);

  const handleSessionExit = useCallback(
    /** @param {import('../../types').Session} session */
    (session) => {
      if (maximizedTerminalId() === session.id) {
        clearMaximizedTerminal(session.id);
      }
      onRemoveSession(session.id);
    },
    [onRemoveSession],
  );

  const reattachSession = useCallback(async () => {
    if (!activeSession || sessionMutationPending) return;
    setReattaching(true);
    setActionError(null);
    try {
      onUpsertSession(await apiReattachSession(activeSession.id));
    } catch (error) {
      setActionError(actionFailure(activeSession.id, error, 'Failed to reattach the global session'));
    } finally {
      setReattaching(false);
    }
  }, [activeSession, onUpsertSession, sessionMutationPending]);

  const handlePromote = useCallback(async () => {
    if (!activeSession || !promoteRepo || !promoteBranch || sessionMutationPending) return;
    setPromoting(true);
    setActionError(null);
    try {
      const result = await promoteSession(activeSession.id, promoteRepo, promoteBranch);
      onRemoveSession(activeSession.id);
      setShowPromote(false);
      setPromoteBranch('');
      if (maximizedTerminalId() === activeSession.id) clearMaximizedTerminal(activeSession.id);
      onToggle();
      window.location.hash = `#/workspace/${result.workspace.id}`;
    } catch (error) {
      setActionError(actionFailure(activeSession.id, error, 'Failed to promote session'));
    } finally {
      setPromoting(false);
    }
  }, [activeSession, onRemoveSession, onToggle, promoteBranch, promoteRepo, sessionMutationPending]);

  const startRename = useCallback(() => {
    if (!activeSession) return;
    setRenameValue(activeSession.name || '');
    setRenaming(true);
    setActionError(null);
  }, [activeSession]);

  const saveRename = useCallback(
    /** @param {React.FormEvent<HTMLFormElement>} event */
    async (event) => {
      event.preventDefault();
      if (!activeSession || sessionMutationPending) return;
      setSavingName(true);
      setActionError(null);
      try {
        onUpsertSession(await apiRenameSession(activeSession.id, renameValue));
        setRenaming(false);
      } catch (error) {
        setActionError(actionFailure(activeSession.id, error, 'Failed to rename session'));
      } finally {
        setSavingName(false);
      }
    },
    [activeSession, onUpsertSession, renameValue, sessionMutationPending],
  );

  const selectTab = useCallback(
    /** @param {string} sessionId @param {'tab' | 'terminal'} focusTarget */ (sessionId, focusTarget = 'tab') => {
      onSelectSession(sessionId);
      if (maximizedTerminalId()) replaceMaximizedTerminal(sessionId);
      if (!open) onToggle();
      if (focusTarget === 'terminal') {
        setTerminalFocusRequest((request) => request + 1);
      } else {
        const tab = document.getElementById(`global-session-tab-${sessionId}`);
        tab?.focus();
        requestAnimationFrame(() => tab?.focus());
      }
    },
    [onSelectSession, onToggle, open],
  );

  const closePanel = useCallback(() => {
    if (activeSession && maximizedTerminalId() === activeSession.id) clearMaximizedTerminal(activeSession.id);
    setRenaming(false);
    setShowPromote(false);
    onToggle();
  }, [activeSession, onToggle]);

  const handleTabKeyDown = useCallback(
    /** @param {React.KeyboardEvent<HTMLButtonElement>} event @param {number} index */
    (event, index) => {
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % sessions.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + sessions.length) % sessions.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = sessions.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      selectTab(sessions[nextIndex].id);
    },
    [selectTab, sessions],
  );

  const visibleActionError =
    actionError && (actionError.sessionId === null || actionError.sessionId === activeSession?.id)
      ? actionError.message
      : '';
  const visibleError =
    visibleActionError || (loadError ? getErrorMessage(loadError, 'Failed to load global sessions') : '');

  return (
    <div
      ref={drawerRef}
      className={`${styles.drawer} ${!open ? styles.collapsed : ''}`}
      role="region"
      aria-label="Global sessions"
    >
      <div className={styles.handle}>
        <button
          type="button"
          className={styles.barToggle}
          aria-label={`Global sessions, ${sessions.length} running`}
          aria-expanded={open}
          aria-controls="global-session-panel"
          onClick={open ? closePanel : onToggle}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="1" y="2" width="14" height="12" rx="2" />
            <polyline points="5,6 7.5,8.5 5,11" />
            <line x1="9" y1="11" x2="12" y2="11" />
          </svg>
          <span className={styles.barLabel}>Global sessions</span>
          <span className={styles.sessionCount}>{sessions.length}</span>
        </button>
        <div className={styles.tabsWrap}>
          <div className={styles.tabList} role="tablist" aria-label="Global sessions">
            {sessions.map((session, index) => {
              const selected = activeSession?.id === session.id;
              const sessionName = session.name || (session.provider === 'codex' ? 'Codex' : 'Claude');
              return (
                <button
                  key={session.id}
                  id={`global-session-tab-${session.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls="global-session-panel"
                  tabIndex={selected || (!activeSession && index === 0) ? 0 : -1}
                  className={`${styles.tab} ${selected ? styles.tabActive : ''}`}
                  title={session.status === 'detached' ? `${sessionName} - external terminal` : sessionName}
                  onClick={() => selectTab(session.id, 'terminal')}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  {sessionName}
                </button>
              );
            })}
          </div>
          <AgentProviderButton
            variant="primary"
            size="xs"
            onClick={createSession}
            disabled={starting || loading}
            busy={starting}
            className={styles.createGroup}
            actionClassName={styles.createButton}
          >
            <span aria-hidden="true">+</span> Create
          </AgentProviderButton>
        </div>
        {open && (
          <Stack gap={2} className={styles.controls}>
            {activeSession && (
              <>
                <Button size="xs" onClick={startRename} disabled={sessionMutationPending}>
                  Rename
                </Button>
                {activeSession.status === 'active' && activeSession.provider === 'claude' && (
                  <Button
                    variant="success"
                    size="xs"
                    onClick={() => setShowPromote((shown) => !shown)}
                    disabled={sessionMutationPending}
                  >
                    Promote
                  </Button>
                )}
              </>
            )}
            <button
              type="button"
              className={styles.closeButton}
              aria-label="Close global sessions"
              onClick={closePanel}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <line x1="3" y1="3" x2="11" y2="11" />
                <line x1="11" y1="3" x2="3" y2="11" />
              </svg>
            </button>
          </Stack>
        )}
      </div>
      {open && renaming && activeSession && (
        <form className={styles.renameForm} onSubmit={saveRename}>
          <label htmlFor="global-session-name">Session name</label>
          <input
            id="global-session-name"
            className={styles.renameInput}
            value={renameValue}
            maxLength={80}
            autoFocus
            disabled={sessionMutationPending}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setRenaming(false);
            }}
          />
          <Button type="submit" variant="primary" size="xs" disabled={sessionMutationPending} busy={savingName}>
            Save
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setRenaming(false)}>
            Cancel
          </Button>
        </form>
      )}
      {open && showPromote && activeSession?.provider === 'claude' && (
        <Stack gap={2} className={styles.promoteForm}>
          <RepoCombobox
            value={promoteRepo}
            onChange={setPromoteRepo}
            disabled={sessionMutationPending}
            variant="light"
          />
          <input
            className={styles.promoteInput}
            type="text"
            placeholder="branch-name"
            value={promoteBranch}
            onChange={(event) => setPromoteBranch(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && handlePromote()}
            disabled={sessionMutationPending}
          />
          <Button
            variant="success"
            size="xs"
            filled
            onClick={handlePromote}
            disabled={sessionMutationPending || !promoteRepo || !promoteBranch}
            busy={promoting}
          >
            {promoting ? 'Promoting...' : 'Go'}
          </Button>
          <Button variant="ghost" size="xs" onClick={() => setShowPromote(false)} disabled={promoting}>
            Cancel
          </Button>
        </Stack>
      )}
      {open && visibleError && (
        <div className={styles.errorBar} role="alert">
          <span>{visibleError}</span>
          {loadError != null && (
            <Button size="xs" onClick={onReload}>
              Retry
            </Button>
          )}
        </div>
      )}
      <div
        id="global-session-panel"
        className={`${styles.content} ${!open ? styles.contentHidden : ''}`}
        role="tabpanel"
        aria-hidden={!open}
        aria-labelledby={activeSession ? `global-session-tab-${activeSession.id}` : undefined}
      >
        {loading && sessions.length === 0 && (
          <LoadingIndicator className={styles.loading}>Loading global sessions...</LoadingIndicator>
        )}
        {open && activeSession && (
          <TerminalCard
            key={activeSession.id}
            session={activeSession}
            title={activeSession.name || `${activeSession.provider === 'codex' ? 'Codex' : 'Claude'} session`}
            onKill={killSession}
            onExit={() => handleSessionExit(activeSession)}
            onReattach={reattachSession}
            sessionState={activeSession.activity_state ?? undefined}
            presentation="global"
            focusRequest={terminalFocusRequest}
            controlsDisabled={sessionMutationPending}
            killPending={killing}
          />
        )}
        {!activeSession && !loading && (
          <div className={styles.placeholder}>
            <p className={styles.detached}>No global sessions are running.</p>
          </div>
        )}
      </div>
    </div>
  );
}
