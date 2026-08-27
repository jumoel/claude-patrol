import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useResizeHandle } from '../../hooks/useResizeHandle.js';
import {
  createSession as apiCreateSession,
  killSession as apiKillSession,
  reattachSession as apiReattachSession,
  renameSession as apiRenameSession,
  promoteSession,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import shared from '../../styles/shared.module.css';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { LazyTerminal } from '../Terminal/LazyTerminal.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { RepoCombobox } from '../ui/RepoCombobox/RepoCombobox.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './GlobalTerminal.module.css';

const MIN_HEIGHT = 150;
const MAX_HEIGHT_RATIO = 0.85;
const DEFAULT_HEIGHT = 410;
const STORAGE_KEY = 'claude-patrol-terminal-height';

function loadHeight() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const h = Number(saved);
      if (h >= MIN_HEIGHT && h <= window.innerHeight * MAX_HEIGHT_RATIO) return h;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_HEIGHT;
}

/** @param {number} h */
function persistHeight(h) {
  try {
    localStorage.setItem(STORAGE_KEY, String(Math.round(h)));
  } catch {
    /* ignore */
  }
}

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
  const [maximized, setMaximized] = useState(false);
  const [showPromote, setShowPromote] = useState(false);
  const [promoteRepo, setPromoteRepo] = useState('');
  const [promoteBranch, setPromoteBranch] = useState('');
  const [promoting, setPromoting] = useState(false);
  const [reattaching, setReattaching] = useState(false);
  const [killing, setKilling] = useState(false);
  const [poppingOut, setPoppingOut] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [savingName, setSavingName] = useState(false);
  const sessionMutationPending = killing || poppingOut || reattaching || promoting || savingName;
  const autoStartAttempted = useRef(false);
  const previousActiveSessionId = useRef(activeSession?.id);
  const poppingOutSessionId = useRef(/** @type {string | null} */ (null));

  const { height, setHeight, dragging, handleProps } = useResizeHandle({
    initial: loadHeight(),
    min: MIN_HEIGHT,
    max: window.innerHeight * MAX_HEIGHT_RATIO,
    direction: 'up',
    onPersist: persistHeight,
  });

  useEscapeKey(
    maximized,
    useCallback(() => setMaximized(false), []),
  );

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

  useEffect(() => {
    if (!open) {
      autoStartAttempted.current = false;
    } else if (!loading && !loadError && !starting && !autoStartAttempted.current) {
      autoStartAttempted.current = true;
      if (sessions.length === 0) startSession();
    }
  }, [open, sessions.length, loading, loadError, starting, startSession]);

  const killSession = useCallback(async () => {
    if (!activeSession || sessionMutationPending) return;
    setKilling(true);
    setActionError(null);
    try {
      await apiKillSession(activeSession.id);
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
      if (poppingOutSessionId.current === session.id) {
        poppingOutSessionId.current = null;
        onUpsertSession({ ...session, status: 'detached' });
      } else {
        onRemoveSession(session.id);
      }
    },
    [onRemoveSession, onUpsertSession],
  );

  const popOutSession = useCallback(async () => {
    if (!activeSession || sessionMutationPending) return;
    poppingOutSessionId.current = activeSession.id;
    setPoppingOut(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/sessions/${activeSession.id}/popout`, { method: 'POST' });
      if (!response.ok) throw new Error(`Pop out failed: ${response.status}`);
      poppingOutSessionId.current = null;
      onUpsertSession({ ...activeSession, status: 'detached' });
      setMaximized(false);
    } catch (error) {
      poppingOutSessionId.current = null;
      setActionError(actionFailure(activeSession.id, error, 'Failed to pop out session'));
    } finally {
      setPoppingOut(false);
    }
  }, [activeSession, onUpsertSession, sessionMutationPending]);

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
      setMaximized(false);
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
    /** @param {string} sessionId */ (sessionId) => {
      onSelectSession(sessionId);
      const tab = document.getElementById(`global-session-tab-${sessionId}`);
      tab?.focus();
      requestAnimationFrame(() => tab?.focus());
    },
    [onSelectSession],
  );

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

  const handleDoubleClick = useCallback(() => {
    setHeight((previous) => {
      const next = previous <= MIN_HEIGHT + 20 ? DEFAULT_HEIGHT : MIN_HEIGHT;
      persistHeight(next);
      return next;
    });
  }, [setHeight]);

  const handleResizeKeyDown = useCallback(
    /** @param {React.KeyboardEvent<HTMLDivElement>} event */ (event) => {
      const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
      let nextHeight = null;
      if (event.key === 'ArrowUp') nextHeight = Math.min(maxHeight, height + 40);
      else if (event.key === 'ArrowDown') nextHeight = Math.max(MIN_HEIGHT, height - 40);
      else if (event.key === 'Home') nextHeight = MIN_HEIGHT;
      else if (event.key === 'End') nextHeight = maxHeight;
      if (nextHeight === null) return;
      event.preventDefault();
      setHeight(nextHeight);
      persistHeight(nextHeight);
    },
    [height, setHeight],
  );

  const spacerHeight = open && !maximized ? height : 0;
  const visibleActionError =
    actionError && (actionError.sessionId === null || actionError.sessionId === activeSession?.id)
      ? actionError.message
      : '';
  const visibleError =
    visibleActionError || (loadError ? getErrorMessage(loadError, 'Failed to load global sessions') : '');

  return (
    <>
      <div style={{ height: spacerHeight, flexShrink: 0 }} />
      {dragging && <div className={shared.dragOverlay} />}
      <div
        className={maximized ? styles.maximized : styles.drawer}
        style={maximized ? { display: open ? 'flex' : 'none' } : { height, display: open ? 'flex' : 'none' }}
      >
        {!maximized && (
          <div
            className={styles.resizeHandle}
            {...handleProps}
            role="separator"
            aria-label="Resize global terminal"
            aria-orientation="horizontal"
            aria-valuemin={MIN_HEIGHT}
            aria-valuemax={Math.round(window.innerHeight * MAX_HEIGHT_RATIO)}
            aria-valuenow={Math.round(height)}
            tabIndex={0}
            title="Drag to resize. Double-click to minimize or restore."
            onDoubleClick={handleDoubleClick}
            onKeyDown={handleResizeKeyDown}
          >
            <div className={styles.resizeGrip} />
          </div>
        )}
        <div className={styles.handle}>
          <div className={styles.tabsWrap}>
            <div className={styles.tabList} role="tablist" aria-label="Global sessions">
              {sessions.map((session, index) => {
                const selected = activeSession?.id === session.id;
                return (
                  <button
                    key={session.id}
                    id={`global-session-tab-${session.id}`}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls="global-session-panel"
                    tabIndex={selected ? 0 : -1}
                    className={`${styles.tab} ${selected ? styles.tabActive : ''}`}
                    title={session.name || 'Global session'}
                    onClick={() => selectTab(session.id)}
                    onKeyDown={(event) => handleTabKeyDown(event, index)}
                  >
                    {session.name || (session.provider === 'codex' ? 'Codex' : 'Claude')}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className={styles.addTab}
              onClick={startSession}
              disabled={starting}
              aria-label={`Start another ${provider === 'codex' ? 'Codex' : 'Claude'} session`}
              title={`Start another ${provider === 'codex' ? 'Codex' : 'Claude'} session`}
            >
              +
            </button>
          </div>
          <Stack gap={2} className={styles.controls}>
            {activeSession && (
              <>
                <Button size="xs" dark onClick={startRename} disabled={sessionMutationPending}>
                  Rename
                </Button>
                {activeSession.status === 'active' && activeSession.provider === 'claude' && (
                  <Button
                    variant="success"
                    size="xs"
                    dark
                    onClick={() => setShowPromote((shown) => !shown)}
                    disabled={sessionMutationPending}
                  >
                    Promote
                  </Button>
                )}
                {activeSession.status === 'active' ? (
                  <>
                    <Button size="xs" dark onClick={() => setMaximized((value) => !value)}>
                      {maximized ? 'Restore' : 'Maximize'}
                    </Button>
                    <Button
                      variant="primary"
                      size="xs"
                      dark
                      onClick={popOutSession}
                      disabled={sessionMutationPending}
                      busy={poppingOut}
                    >
                      Pop out
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="primary"
                    size="xs"
                    dark
                    onClick={reattachSession}
                    disabled={sessionMutationPending}
                    busy={reattaching}
                  >
                    {reattaching ? 'Reattaching...' : 'Reattach'}
                  </Button>
                )}
                <Button
                  variant="danger"
                  size="xs"
                  dark
                  onClick={killSession}
                  disabled={sessionMutationPending}
                  busy={killing}
                >
                  Kill
                </Button>
              </>
            )}
            <button
              type="button"
              className={styles.closeButton}
              aria-label="Close global sessions"
              onClick={() => {
                setMaximized(false);
                onToggle();
              }}
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
        </div>
        {renaming && activeSession && (
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
            <Button type="submit" variant="primary" size="xs" dark disabled={sessionMutationPending} busy={savingName}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="xs" dark onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        )}
        {showPromote && activeSession?.provider === 'claude' && (
          <Stack gap={2} className={styles.promoteForm}>
            <RepoCombobox
              value={promoteRepo}
              onChange={setPromoteRepo}
              disabled={sessionMutationPending}
              variant="dark"
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
              dark
              filled
              onClick={handlePromote}
              disabled={sessionMutationPending || !promoteRepo || !promoteBranch}
              busy={promoting}
            >
              {promoting ? 'Promoting...' : 'Go'}
            </Button>
            <Button variant="ghost" size="xs" dark onClick={() => setShowPromote(false)} disabled={promoting}>
              Cancel
            </Button>
          </Stack>
        )}
        {visibleError && (
          <div className={styles.errorBar} role="alert">
            <span>{visibleError}</span>
            {loadError != null && (
              <Button size="xs" dark onClick={onReload}>
                Retry
              </Button>
            )}
          </div>
        )}
        <div
          id="global-session-panel"
          className={styles.content}
          role="tabpanel"
          aria-labelledby={activeSession ? `global-session-tab-${activeSession.id}` : undefined}
        >
          {loading && sessions.length === 0 && (
            <LoadingIndicator className={styles.loading}>Loading global sessions...</LoadingIndicator>
          )}
          {activeSession?.status === 'active' && (
            <LazyTerminal
              key={activeSession.id}
              wsUrl={`/ws/sessions/${activeSession.id}`}
              focus={open}
              onExit={() => handleSessionExit(activeSession)}
            />
          )}
          {activeSession?.status === 'detached' && (
            <div className={styles.placeholder}>
              <Stack direction="col" gap={3}>
                <p className={styles.detached}>Session is running in an external terminal.</p>
                <Button
                  variant="primary"
                  size="lg"
                  dark
                  onClick={reattachSession}
                  disabled={sessionMutationPending}
                  busy={reattaching}
                >
                  {reattaching ? 'Reattaching...' : 'Reattach global session'}
                </Button>
              </Stack>
            </div>
          )}
          {!activeSession && !loading && (
            <div className={styles.placeholder}>
              <Stack direction="col" gap={3}>
                <AgentProviderButton variant="primary" size="lg" dark onClick={startSession} busy={starting}>
                  {starting ? 'Starting...' : `Start global ${provider === 'codex' ? 'Codex' : 'Claude'} session`}
                </AgentProviderButton>
              </Stack>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
