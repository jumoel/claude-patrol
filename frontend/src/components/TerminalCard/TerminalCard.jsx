import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useResizeHandle } from '../../hooks/useResizeHandle.js';
import shared from '../../styles/shared.module.css';
import { QuickActions } from '../QuickActions/QuickActions.jsx';
import { Terminal } from '../Terminal/Terminal.jsx';
import { Button } from '../ui/Button/Button.jsx';

/**
 * Shared terminal UI with maximize, close, resize, and detach/reattach support.
 * Used by PRDetail and WorkspaceDetail for consistent terminal chrome.
 *
 * @param {{
 *   session: { id: string, status: string },
 *   title: string,
 *   onKill: () => void,
 *   onExit: () => void,
 *   onPopOut?: () => void,
 *   onReattach?: () => Promise<void>,
 *   wsRef?: { current: WebSocket | null },
 * }} props
 */
export function TerminalCard({ session, title, onKill, onExit, onPopOut, onReattach, wsRef: externalWsRef }) {
  const [maximized, setMaximized] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [reattaching, setReattaching] = useState(false);
  const internalWsRef = useRef(null);
  const wsRef = externalWsRef || internalWsRef;

  const {
    height: termHeight,
    dragging,
    handleProps,
  } = useResizeHandle({
    initial: 400,
    min: 150,
    max: 900,
  });

  // Only un-maximize on Escape if it didn't come from the terminal
  // (xterm sends Escape to the PTY, but the DOM event also bubbles up)
  useEscapeKey(
    maximized,
    useCallback((e) => {
      if (e?.target?.closest?.('.xterm')) return;
      setMaximized(false);
    }, []),
  );

  const toggleMaximize = useCallback(() => setMaximized((prev) => !prev), []);

  const handleExit = useCallback(() => {
    setMaximized(false);
    onExit();
  }, [onExit]);

  const handleSendCommand = useCallback(
    (text) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
      }
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

  // Detached - session alive in external terminal, can reattach
  if (session.status === 'detached') {
    return (
      <div className={shared.card}>
        <div className={shared.terminalHeader}>
          <h3 className={shared.sectionTitle}>Terminal</h3>
          <div className={shared.terminalActions}>
            <Button variant="primary" size="sm" onClick={handleReattach} disabled={reattaching}>
              {reattaching ? 'Reattaching...' : 'Reattach'}
            </Button>
            <Button variant="danger" size="sm" onClick={onKill}>
              Kill session
            </Button>
          </div>
        </div>
        <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0 }}>Session running in external terminal</p>
      </div>
    );
  }

  // Maximized overlay - portaled to body so ancestor transforms can't break fixed positioning
  if (maximized) {
    return createPortal(
      <div className={shared.terminalOverlay}>
        <div className={shared.overlayHeader}>
          <span className={shared.overlayTitle}>{title}</span>
          <div className={shared.terminalActions}>
            {onPopOut && (
              <Button variant="default" size="sm" dark onClick={onPopOut}>
                Pop out
              </Button>
            )}
            <Button variant="default" size="sm" dark onClick={() => setMaximized(false)} title="Restore (Cmd+Enter)">
              Restore
            </Button>
            <Button
              variant="default"
              size="sm"
              dark
              onClick={() => {
                setMaximized(false);
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
                setMaximized(false);
                onKill();
              }}
            >
              Kill session
            </Button>
          </div>
        </div>
        <div className={shared.overlayContent}>
          <Terminal
            wsUrl={`/ws/sessions/${session.id}`}
            wsRef={wsRef}
            onExit={handleExit}
            onToggleMaximize={toggleMaximize}
            borderless
          />
        </div>
        <QuickActions onSend={handleSendCommand} />
      </div>,
      document.body,
    );
  }

  // Collapsed - session running but terminal hidden
  if (!terminalOpen) {
    return (
      <div className={shared.card}>
        <div className={shared.terminalHeader}>
          <h3 className={shared.sectionTitle}>Terminal</h3>
          <div className={shared.terminalActions}>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                setTerminalOpen(true);
                setMaximized(true);
              }}
            >
              Maximize <kbd style={{ fontSize: '11px', opacity: 0.5 }}>Cmd+Enter</kbd>
            </Button>
            <Button variant="primary" size="sm" onClick={() => setTerminalOpen(true)}>
              Open terminal
            </Button>
            <Button variant="danger" size="sm" onClick={onKill}>
              Kill session
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Inline terminal card
  return (
    <div className={shared.card}>
      <div className={shared.terminalHeader}>
        <h3 className={shared.sectionTitle}>Terminal</h3>
        <div className={shared.terminalActions}>
          {onPopOut && (
            <Button variant="default" size="sm" onClick={onPopOut}>
              Pop out
            </Button>
          )}
          <Button variant="default" size="sm" onClick={() => setMaximized(true)}>
            Maximize <kbd style={{ fontSize: '11px', opacity: 0.5 }}>Cmd+Enter</kbd>
          </Button>
          <Button variant="default" size="sm" onClick={() => setTerminalOpen(false)}>
            Close
          </Button>
          <Button variant="danger" size="sm" onClick={onKill}>
            Kill session
          </Button>
        </div>
      </div>
      <QuickActions onSend={handleSendCommand} />
      <div style={{ height: termHeight }}>
        <Terminal
          wsUrl={`/ws/sessions/${session.id}`}
          wsRef={wsRef}
          onExit={handleExit}
          onToggleMaximize={toggleMaximize}
        />
      </div>
      <div className={shared.resizeHandle} {...handleProps}>
        <div className={shared.resizeGrip} />
      </div>
      {dragging && <div className={shared.dragOverlay} />}
    </div>
  );
}
