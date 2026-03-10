import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import styles from './Terminal.module.css';

/**
 * Terminal component backed by xterm.js and a WebSocket connection.
 * @param {{ wsUrl: string, wsRef?: import('react').MutableRefObject<WebSocket | null> }} props
 */
export function Terminal({ wsUrl, wsRef: externalWsRef }) {
  const containerRef = useRef(null);
  const termRef = useRef(null);
  const wsRef = useRef(null);
  const fitRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !wsUrl) return;

    const term = new XTerm({
      cursorBlink: true,
      fontSize: 16,
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

    termRef.current = term;
    fitRef.current = fitAddon;

    // WebSocket connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const fullUrl = wsUrl.startsWith('ws') ? wsUrl : `${protocol}//${window.location.host}${wsUrl}`;
    const ws = new WebSocket(fullUrl);
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
      // Send initial resize
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Resize handling
    const observer = new ResizeObserver(() => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      ws.close();
      term.dispose();
    };
  }, [wsUrl]);

  return (
    <div className={styles.wrapper}>
      <div ref={containerRef} className={styles.terminal} />
    </div>
  );
}
