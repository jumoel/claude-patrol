import { useState, useCallback, useRef } from 'react';
import { Terminal } from '../Terminal/Terminal.jsx';
import { QuickActions } from '../QuickActions/QuickActions.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useResizeHandle } from '../../hooks/useResizeHandle.js';
import shared from '../../styles/shared.module.css';

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

  const { height: termHeight, dragging, handleProps } = useResizeHandle({
    initial: 400, min: 150, max: 900,
  });

  useEscapeKey(maximized, useCallback(() => setMaximized(false), []));

  const toggleMaximize = useCallback(() => setMaximized(prev => !prev), []);

  const handleExit = useCallback(() => {
    setMaximized(false);
    onExit();
  }, [onExit]);

  const handleSendCommand = useCallback((text) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: text }));
    }
  }, [wsRef]);

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
            <button className={shared.openButton} onClick={handleReattach} disabled={reattaching} style={{ padding: '6px 12px', fontSize: '14px' }}>
              {reattaching ? 'Reattaching...' : 'Reattach'}
            </button>
            <button className={shared.killSessionButton} onClick={onKill}>
              Kill session
            </button>
          </div>
        </div>
        <p style={{ color: '#9ca3af', fontSize: '14px', margin: 0 }}>Session running in external terminal</p>
      </div>
    );
  }

  // Maximized overlay
  if (maximized) {
    return (
      <div className={shared.terminalOverlay}>
        <div className={shared.overlayHeader}>
          <span className={shared.overlayTitle}>{title}</span>
          <div className={shared.terminalActions}>
            {onPopOut && (
              <button className={shared.closeTermButton} onClick={onPopOut}>
                Pop out
              </button>
            )}
            <button className={shared.maximizeButton} onClick={() => setMaximized(false)} title="Restore (Cmd+Enter)">
              Restore
            </button>
            <button className={shared.closeTermButton} onClick={() => { setMaximized(false); setTerminalOpen(false); }}>
              Close
            </button>
            <button className={shared.killSessionButton} onClick={() => { setMaximized(false); onKill(); }}>
              Kill session
            </button>
          </div>
        </div>
        <div className={shared.overlayContent}>
          <Terminal wsUrl={`/ws/sessions/${session.id}`} wsRef={wsRef} onExit={handleExit} onToggleMaximize={toggleMaximize} />
        </div>
        <QuickActions onSend={handleSendCommand} />
      </div>
    );
  }

  // Collapsed - session running but terminal hidden
  if (!terminalOpen) {
    return (
      <div className={shared.card}>
        <div className={shared.terminalHeader}>
          <h3 className={shared.sectionTitle}>Terminal</h3>
          <div className={shared.terminalActions}>
            <button className={shared.maximizeButton} onClick={() => { setTerminalOpen(true); setMaximized(true); }}>
              Maximize <kbd style={{ fontSize: '11px', opacity: 0.5 }}>Cmd+Enter</kbd>
            </button>
            <button className={shared.openButton} onClick={() => setTerminalOpen(true)} style={{ padding: '6px 12px', fontSize: '14px' }}>
              Open terminal
            </button>
            <button className={shared.killSessionButton} onClick={onKill}>
              Kill session
            </button>
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
            <button className={shared.closeTermButton} onClick={onPopOut}>
              Pop out
            </button>
          )}
          <button className={shared.maximizeButton} onClick={() => setMaximized(true)}>
            Maximize <kbd style={{ fontSize: '11px', opacity: 0.5 }}>Cmd+Enter</kbd>
          </button>
          <button className={shared.closeTermButton} onClick={() => setTerminalOpen(false)}>
            Close
          </button>
          <button className={shared.killSessionButton} onClick={onKill}>
            Kill session
          </button>
        </div>
      </div>
      <QuickActions onSend={handleSendCommand} />
      <div style={{ height: termHeight }}>
        <Terminal wsUrl={`/ws/sessions/${session.id}`} wsRef={wsRef} onExit={handleExit} onToggleMaximize={toggleMaximize} />
      </div>
      <div className={shared.resizeHandle} {...handleProps}>
        <div className={shared.resizeGrip} />
      </div>
      {dragging && <div className={shared.dragOverlay} />}
    </div>
  );
}
