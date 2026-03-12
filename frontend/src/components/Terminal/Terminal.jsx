import { useEffect, useRef } from 'react';
import { init, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web';
import styles from './Terminal.module.css';

const RECONNECT_DELAYS = [500, 1000, 2000, 4000];

/**
 * Terminal component backed by ghostty-web and a WebSocket connection.
 * Auto-reconnects on disconnect (for server restarts in watch mode).
 * @param {{ wsUrl: string, wsRef?: import('react').MutableRefObject<WebSocket | null> }} props
 */
export function Terminal({ wsUrl, wsRef: externalWsRef, focus }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !wsUrl) return;

    let cancelled = false;
    let term, observer;
    let reconnectAttempt = 0;
    let reconnectTimer = null;

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
            term.write(msg.data);
          } else if (msg.type === 'exit') {
            term.write(`\r\n[Process exited with code ${msg.code}]\r\n`);
          } else if (msg.type === 'error') {
            term.write(`\r\n[Error: ${msg.message}]\r\n`);
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

    init().then(() => {
      if (cancelled) return;

      term = new GhosttyTerminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace',
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

      // Resize handling
      observer = new ResizeObserver(() => {
        fitAddon.fit();
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      });
      observer.observe(containerRef.current);

      connectWs();
    });

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
// fix terminal resize
