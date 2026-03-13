import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { useIdleNotification } from '../../hooks/useIdleNotification.js';
import styles from './Terminal.module.css';

const RECONNECT_DELAYS = [500, 1000, 2000, 4000];

/**
 * Terminal component backed by xterm.js and a WebSocket connection.
 * Auto-reconnects on disconnect (for server restarts in watch mode).
 * @param {{ wsUrl: string, wsRef?: import('react').MutableRefObject<WebSocket | null> }} props
 */
export function Terminal({ wsUrl, sessionId, wsRef: externalWsRef, focus, onExit }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);
  const lastOutputRef = useRef(0);

  useIdleNotification(sessionId, lastOutputRef);

  useEffect(() => {
    if (!containerRef.current || !wsUrl) return;

    let cancelled = false;
    let observer;
    let reconnectAttempt = 0;
    let reconnectTimer = null;

    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 16,
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace',
      rescaleOverlappingGlyphs: true,
      theme: {
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Unicode 15 with grapheme cluster support - makes emoji double-width,
    // handles compound emoji, skin tones, ZWJ sequences
    const unicodeAddon = new UnicodeGraphemesAddon();
    term.loadAddon(unicodeAddon);

    // GPU-accelerated renderer with custom box-drawing/powerline glyphs
    try {
      const webglAddon = new WebglAddon({ customGlyphs: true });
      webglAddon.onContextLoss(() => webglAddon.dispose());
      term.loadAddon(webglAddon);
    } catch {
      // WebGL not available, fall back to DOM renderer
    }

    fitAddon.fit();
    term.focus();

    termRef.current = term;
    fitRef.current = fitAddon;

    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // xterm.js doesn't distinguish Shift+Enter from Enter by default.
    // Intercept it and send the CSI u (kitty keyboard protocol) sequence
    // so programs like Claude Code can tell the difference.
    // Both keydown AND keyup must be suppressed - if keyup leaks through,
    // xterm's internal state gets confused and subsequent Shift+Enter
    // events are treated as plain Enter.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        if (ev.type === 'keydown') {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: '\x1b[13;2u' }));
          }
        }
        return false; // suppress both keydown and keyup from xterm
      }
      return true;
    });

    // Resize handling
    observer = new ResizeObserver(() => {
      fitAddon.fit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    observer.observe(containerRef.current);

    function connectWs() {
      if (cancelled || !term) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fullUrl = wsUrl.startsWith('ws') ? wsUrl : `${protocol}//${window.location.host}${wsUrl}`;
      const ws = new WebSocket(fullUrl);
      wsRef.current = ws;
      if (externalWsRef) externalWsRef.current = ws;

      ws.onopen = () => {
        if (reconnectAttempt > 0) {
          term.write('\r\n\x1b[32m[Reconnected]\x1b[0m\r\n');
        }
        reconnectAttempt = 0;
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output' || msg.type === 'replay') {
            if (msg.type === 'output') lastOutputRef.current = Date.now();
            term.write(msg.data);
          } else if (msg.type === 'exit') {
            term.write(`\r\n[Process exited with code ${msg.code}]\r\n`);
            cancelled = true;
            if (onExit) onExit(msg.code);
          } else if (msg.type === 'popped-out') {
            cancelled = true;
            if (onExit) onExit(0);
          } else if (msg.type === 'error') {
            term.write(`\r\n[Error: ${msg.message}]\r\n`);
            cancelled = true;
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = (event) => {
        if (cancelled) return;
        // Code 1000 = normal close (e.g. session killed), don't reconnect
        // Code 1001 = going away (server shutdown), do reconnect
        // Code 1006 = abnormal (connection lost), do reconnect
        if (event.code === 1000) return;

        const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        reconnectAttempt++;
        if (reconnectAttempt === 1) {
          term.write('\r\n\x1b[33m[Connection lost, reconnecting...]\x1b[0m');
        }
        reconnectTimer = setTimeout(connectWs, delay);
      };
    }

    connectWs();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      observer?.disconnect();
      wsRef.current?.close();
      term?.dispose();
    };
  }, [wsUrl]);

  useEffect(() => {
    if (focus && termRef.current) termRef.current.focus();
  }, [focus]);

  const handleClick = () => {
    if (termRef.current) termRef.current.focus();
  };

  return (
    <div className={styles.wrapper} onClick={handleClick}>
      <div ref={containerRef} className={styles.terminal} />
    </div>
  );
}
