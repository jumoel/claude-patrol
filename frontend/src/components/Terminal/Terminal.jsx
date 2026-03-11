import { useEffect, useRef } from 'react';
import { init, Terminal as GhosttyTerminal, FitAddon } from 'ghostty-web';
import styles from './Terminal.module.css';

/**
 * Terminal component backed by ghostty-web and a WebSocket connection.
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
    let term, ws, observer;

    init().then(() => {
      if (cancelled) return;

      term = new GhosttyTerminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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

      // WebSocket connection
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fullUrl = wsUrl.startsWith('ws') ? wsUrl : `${protocol}//${window.location.host}${wsUrl}`;
      ws = new WebSocket(fullUrl);
      wsRef.current = ws;
      if (externalWsRef) externalWsRef.current = ws;

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

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      term.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // Resize handling
      observer = new ResizeObserver(() => {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      });
      observer.observe(containerRef.current);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      ws?.close();
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
