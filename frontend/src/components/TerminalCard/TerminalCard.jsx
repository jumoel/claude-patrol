import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useResizeHandle } from '../../hooks/useResizeHandle.js';
import { sendTerminalCommand, whenWsOpen } from '../../lib/terminal.js';
import { clearMaximizedTerminal, maximizedTerminalId, replaceMaximizedTerminal } from '../../lib/terminal-url.js';
import shared from '../../styles/shared.module.css';
import { QuickActions } from '../QuickActions/QuickActions.jsx';
import { LazyTerminal } from '../Terminal/LazyTerminal.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import { WORKING_LABEL } from '../ui/WorkingBadge/WorkingBadge.jsx';
import styles from './TerminalCard.module.css';

const DEFAULT_TERMINAL_HEIGHT = 400;
const MIN_TERMINAL_HEIGHT = 150;
const MAX_TERMINAL_HEIGHT = 900;

/**
 * Shared terminal UI with maximize, close, resize, and detach/reattach support.
 * Used by PRDetail and WorkspaceDetail for consistent terminal chrome.
 *
 * @param {{
 *   session: import('../../types').Session,
 *   title: string,
 *   onKill: () => void,
 *   onExit: () => void,
 *   onReattach?: () => Promise<void>,
 *   wsRef?: { current: WebSocket | null },
 *   baseBranch?: string,
 *   workspaceId?: string,
 *   prId?: string,
 *   sessionState?: 'working' | 'idle',
 *   presentation?: 'card' | 'work-page' | 'global',
 *   focusRequest?: number,
 *   controlsDisabled?: boolean,
 *   killPending?: boolean,
 * }} props
 */
export function TerminalCard({
  session,
  title,
  onKill,
  onExit,
  onReattach,
  wsRef: externalWsRef,
  baseBranch,
  workspaceId,
  prId,
  sessionState,
  presentation = 'card',
  focusRequest = 0,
  controlsDisabled = false,
  killPending = false,
}) {
  const [maximized, setMaximized] = useState(() => maximizedTerminalId() === session.id);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalFocusRequest, setTerminalFocusRequest] = useState(0);
  const [reattaching, setReattaching] = useState(false);
  const internalWsRef = useRef(/** @type {WebSocket | null} */ (null));
  const wsRef = externalWsRef || internalWsRef;

  const {
    height: termHeight,
    setHeight: setTermHeight,
    dragging,
    handleProps,
  } = useResizeHandle({
    initial: DEFAULT_TERMINAL_HEIGHT,
    min: MIN_TERMINAL_HEIGHT,
    max: MAX_TERMINAL_HEIGHT,
  });

  const handleWorkPageResizeKeyDown = useCallback(
    /** @param {React.KeyboardEvent<HTMLDivElement>} event */ (event) => {
      let nextHeight = null;
      if (event.key === 'ArrowUp') nextHeight = Math.max(MIN_TERMINAL_HEIGHT, termHeight - 40);
      else if (event.key === 'ArrowDown') nextHeight = Math.min(MAX_TERMINAL_HEIGHT, termHeight + 40);
      else if (event.key === 'Home') nextHeight = MIN_TERMINAL_HEIGHT;
      else if (event.key === 'End') nextHeight = MAX_TERMINAL_HEIGHT;
      if (nextHeight === null) return;
      event.preventDefault();
      setTermHeight(nextHeight);
    },
    [setTermHeight, termHeight],
  );

  // Only un-maximize on Escape if it didn't come from the terminal
  // (xterm sends Escape to the PTY, but the DOM event also bubbles up)
  const updateMaximized = useCallback(
    /** @param {boolean} next */ (next) => {
      setMaximized(next);
      if (next) {
        replaceMaximizedTerminal(session.id);
        setTerminalFocusRequest((request) => request + 1);
      } else {
        clearMaximizedTerminal(session.id);
      }
    },
    [session.id],
  );

  useEffect(() => {
    const syncFromUrl = () => setMaximized(maximizedTerminalId() === session.id);
    syncFromUrl();
    window.addEventListener('hashchange', syncFromUrl);
    return () => window.removeEventListener('hashchange', syncFromUrl);
  }, [session.id]);

  useEffect(() => {
    if (session.status === 'detached') updateMaximized(false);
  }, [session.status, updateMaximized]);

  useEscapeKey(
    maximized,
    useCallback(
      (e) => {
        if (e.target instanceof Element && e.target.closest('.xterm')) return;
        updateMaximized(false);
      },
      [updateMaximized],
    ),
  );

  const toggleMaximize = useCallback(() => updateMaximized(!maximized), [maximized, updateMaximized]);
  const toggleWorkPageMaximize = useCallback(() => {
    setTerminalOpen(true);
    updateMaximized(!maximized);
  }, [maximized, updateMaximized]);

  const handleExit = useCallback(() => {
    updateMaximized(false);
    onExit();
  }, [onExit, updateMaximized]);

  const handleKill = useCallback(() => {
    updateMaximized(false);
    onKill();
  }, [onKill, updateMaximized]);

  const handleSendCommand = useCallback(
    /** @param {string} text */
    async (text) => {
      // QuickAction click can fire while the WS is still in CONNECTING (e.g.
      // session was just reattached). Wait briefly so we don't silently drop.
      const ws = await whenWsOpen(wsRef, 2000);
      if (!ws) return;
      sendTerminalCommand(ws, text);
    },
    [wsRef],
  );

  const handleReattach = useCallback(async () => {
    if (!onReattach) return;
    setReattaching(true);
    try {
      await onReattach();
    } finally {
      setReattaching(false);
    }
  }, [onReattach]);

  if (presentation === 'work-page' || presentation === 'global') {
    const isGlobal = presentation === 'global';
    const workPageTitle = title.replace(/^Terminal\s*-\s*/, '');
    const stateLabel = sessionState === 'working' ? WORKING_LABEL : sessionState === 'idle' ? 'Waiting' : 'Idle';
    const stateClass =
      sessionState === 'working' ? styles.working : sessionState === 'idle' ? styles.waiting : styles.inactive;
    if (session.status === 'detached') {
      return (
        <section
          className={`${styles.workPageDetached} ${isGlobal ? styles.globalDetached : ''}`}
          aria-labelledby={`terminal-${session.id}`}
        >
          <div className={styles.workPageHeader}>
            <h2 id={`terminal-${session.id}`} className={styles.workPageTitle}>
              <span
                className={`${styles.workPageStatus} ${styles.inactive}`}
                data-state-marker="detached"
                aria-hidden="true"
              />
              {workPageTitle}
              <span className={styles.sessionProvider}>· {session.provider}</span>
              <span className={styles.sessionState}>Detached</span>
            </h2>
            <Stack gap={2} wrap>
              <Button
                variant="primary"
                size="sm"
                onClick={handleReattach}
                disabled={reattaching || controlsDisabled}
                busy={reattaching}
              >
                {reattaching ? 'Reattaching...' : 'Reattach'}
              </Button>
              <Button variant="danger" size="sm" onClick={handleKill} disabled={controlsDisabled} busy={killPending}>
                Kill session
              </Button>
            </Stack>
          </div>
          <p className={styles.detachedMessage}>Session running in an external terminal.</p>
        </section>
      );
    }

    return (
      <section
        className={`${styles.workPageTerminal} ${isGlobal ? styles.globalTerminal : ''} ${
          maximized ? styles.workPageMaximized : terminalOpen ? '' : styles.workPageCollapsed
        }`}
        aria-labelledby={`terminal-${session.id}`}
      >
        <div className={styles.workPageHeader}>
          <h2 id={`terminal-${session.id}`} className={styles.workPageTitle}>
            <span
              className={`${styles.workPageStatus} ${stateClass}`}
              data-state-marker={sessionState === 'working' ? 'working' : sessionState === 'idle' ? 'waiting' : 'idle'}
              aria-hidden="true"
            />
            {workPageTitle}
            <span className={styles.sessionProvider}>· {session.provider}</span>
            <span className={styles.sessionState}>{stateLabel}</span>
          </h2>
          <Stack gap={1} className={styles.workPageControls}>
            {!maximized && (
              <Button
                variant="ghost"
                size="xs"
                dark
                aria-expanded={terminalOpen}
                aria-controls={`terminal-viewport-${session.id}`}
                onClick={() => setTerminalOpen((open) => !open)}
              >
                {terminalOpen ? 'Collapse' : 'Expand'}
              </Button>
            )}
            <Button
              variant="ghost"
              size="xs"
              dark
              title={maximized ? 'Restore terminal' : 'Maximize terminal (Cmd+Enter)'}
              onClick={toggleWorkPageMaximize}
              disabled={controlsDisabled}
            >
              {maximized ? 'Restore' : 'Maximize'}
            </Button>
            <Button variant="danger" size="xs" dark onClick={handleKill} disabled={controlsDisabled} busy={killPending}>
              Kill session
            </Button>
          </Stack>
        </div>
        <div
          id={`terminal-viewport-${session.id}`}
          className={styles.workPageViewport}
          hidden={!terminalOpen && !maximized}
          style={maximized ? undefined : { height: termHeight }}
        >
          <LazyTerminal
            wsUrl={`/ws/sessions/${session.id}`}
            wsRef={wsRef}
            onExit={handleExit}
            onToggleMaximize={toggleWorkPageMaximize}
            focus={terminalOpen || maximized}
            focusRequest={terminalFocusRequest + focusRequest}
            borderless
          />
        </div>
        {!maximized && terminalOpen && (
          <div
            className={styles.workPageResizeHandle}
            {...handleProps}
            role="separator"
            aria-label="Resize terminal"
            aria-orientation="horizontal"
            aria-valuemin={MIN_TERMINAL_HEIGHT}
            aria-valuemax={MAX_TERMINAL_HEIGHT}
            aria-valuenow={Math.round(termHeight)}
            tabIndex={0}
            title="Drag to resize terminal"
            onKeyDown={handleWorkPageResizeKeyDown}
          >
            <div className={styles.workPageResizeGrip} />
          </div>
        )}
        {dragging && <div className={shared.dragOverlay} />}
      </section>
    );
  }

  // Detached - session alive in external terminal, can reattach
  if (session.status === 'detached') {
    return (
      <Box p={5} border rounded="lg" bg="white">
        <Stack justify="between">
          <h3 className={shared.sectionTitle}>Terminal</h3>
          <Stack gap={2}>
            <Button variant="primary" size="sm" onClick={handleReattach} disabled={reattaching} busy={reattaching}>
              {reattaching ? 'Reattaching...' : 'Reattach'}
            </Button>
            <Button variant="danger" size="sm" onClick={onKill}>
              Kill session
            </Button>
          </Stack>
        </Stack>
        <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0 }}>Session running in external terminal</p>
      </Box>
    );
  }

  // Maximized overlay - portaled to body so ancestor transforms can't break fixed positioning
  if (maximized) {
    return createPortal(
      <div className={shared.terminalOverlay}>
        <Stack justify="between" className={shared.overlayHeader}>
          <span className={shared.overlayTitle}>{title}</span>
          <Stack gap={2}>
            <Button variant="default" size="sm" dark onClick={() => updateMaximized(false)} title="Restore (Cmd+Enter)">
              Restore
            </Button>
            <Button
              variant="default"
              size="sm"
              dark
              onClick={() => {
                updateMaximized(false);
                setTerminalOpen(false);
              }}
            >
              Close
            </Button>
            <Button
              variant="danger"
              size="sm"
              dark
              onClick={() => {
                handleKill();
              }}
            >
              Kill session
            </Button>
          </Stack>
        </Stack>
        <div className={shared.overlayContent}>
          <LazyTerminal
            wsUrl={`/ws/sessions/${session.id}`}
            wsRef={wsRef}
            onExit={handleExit}
            onToggleMaximize={toggleMaximize}
            focus
            focusRequest={terminalFocusRequest + focusRequest}
            borderless
          />
        </div>
        <QuickActions
          onSend={handleSendCommand}
          baseBranch={baseBranch}
          workspaceId={workspaceId}
          prId={prId}
          sessionState={sessionState}
          sessionProvider={session.provider}
        />
      </div>,
      document.body,
    );
  }

  // Collapsed - session running but terminal hidden
  if (!terminalOpen) {
    return (
      <Box p={5} border rounded="lg" bg="white">
        <Stack justify="between">
          <h3 className={shared.sectionTitle}>Terminal</h3>
          <Stack gap={2}>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setTerminalOpen(true);
                updateMaximized(true);
              }}
            >
              Maximize <kbd style={{ fontSize: '11px', opacity: 0.5, lineHeight: 1 }}>Cmd+Enter</kbd>
            </Button>
            <Button variant="primary" size="sm" onClick={() => setTerminalOpen(true)}>
              Open terminal
            </Button>
            <Button variant="danger" size="sm" onClick={handleKill}>
              Kill session
            </Button>
          </Stack>
        </Stack>
      </Box>
    );
  }

  // Inline terminal card
  return (
    <Box p={5} border rounded="lg" bg="white">
      <Stack justify="between">
        <h3 className={shared.sectionTitle}>Terminal</h3>
        <Stack gap={2}>
          <Button variant="default" size="sm" onClick={() => updateMaximized(true)}>
            Maximize <kbd style={{ fontSize: '11px', opacity: 0.5, lineHeight: 1 }}>Cmd+Enter</kbd>
          </Button>
          <Button variant="default" size="sm" onClick={() => setTerminalOpen(false)}>
            Close
          </Button>
          <Button variant="danger" size="sm" onClick={handleKill}>
            Kill session
          </Button>
        </Stack>
      </Stack>
      <QuickActions
        onSend={handleSendCommand}
        baseBranch={baseBranch}
        workspaceId={workspaceId}
        prId={prId}
        sessionState={sessionState}
        sessionProvider={session.provider}
      />
      <div style={{ height: termHeight }}>
        <LazyTerminal
          wsUrl={`/ws/sessions/${session.id}`}
          wsRef={wsRef}
          onExit={handleExit}
          onToggleMaximize={toggleMaximize}
          focusRequest={terminalFocusRequest + focusRequest}
        />
      </div>
      <div className={shared.resizeHandle} {...handleProps}>
        <div className={shared.resizeGrip} />
      </div>
      {dragging && <div className={shared.dragOverlay} />}
    </Box>
  );
}
