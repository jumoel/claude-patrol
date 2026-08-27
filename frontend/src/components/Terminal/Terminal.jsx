import { FitAddon } from '@xterm/addon-fit';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { Terminal as XTerm } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import '@xterm/xterm/css/xterm.css';
import styles from './Terminal.module.css';
import { writeTerminalReplay } from './terminal-replay.js';

const RECONNECT_DELAYS = [500, 1000, 2000, 4000];

/**
 * Terminal component backed by xterm.js and a WebSocket connection.
 * Auto-reconnects on disconnect (for server restarts in watch mode).
 * @param {{
 *   wsUrl: string,
 *   wsRef?: import('react').MutableRefObject<WebSocket | null>,
 *   focus?: boolean,
 *   onExit?: (code: number) => void,
 *   onToggleMaximize?: () => void,
 *   borderless?: boolean,
 * }} props
 */
export function Terminal({ wsUrl, wsRef: externalWsRef, focus, onExit, onToggleMaximize, borderless }) {
  const containerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const termRef = useRef(/** @type {XTerm | null} */ (null));
  const wsRef = useRef(/** @type {WebSocket | null} */ (null));
  const refitRef = useRef(/** @type {((forceRedraw?: boolean) => void) | null} */ (null));
  const externalWsRefRef = useRef(externalWsRef);
  const callbacksRef = useRef({ onExit, onToggleMaximize });

  externalWsRefRef.current = externalWsRef;
  callbacksRef.current = { onExit, onToggleMaximize };

  // wsUrl is the connection identity. Other prop changes must not rebuild xterm or reconnect its WebSocket.
  useEffect(() => {
    if (!containerRef.current || !wsUrl) return undefined;

    let cancelled = false;
    /** @type {ResizeObserver | undefined} */
    let observer;
    let reconnectAttempt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let reconnectTimer = null;
    /** @type {number | null} */
    let fitFrame = null;
    /** @type {number | null} */
    let redrawFrame = null;
    let pendingForceRedraw = false;

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
    if (term.textarea) {
      term.textarea.name = 'terminal-input';
      term.textarea.autocomplete = 'off';
    }

    // Unicode 15 with grapheme cluster support - makes emoji double-width,
    // handles compound emoji, skin tones, ZWJ sequences
    const unicodeAddon = new UnicodeGraphemesAddon();
    term.loadAddon(unicodeAddon);

    // The optional renderer is large, so load it only after a terminal opens.
    // xterm keeps its DOM renderer if WebGL is unavailable or the import fails.
    import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (cancelled) return;
        const webglAddon = new WebglAddon({ customGlyphs: true });
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
          scheduleFit(true);
        });
        term.loadAddon(webglAddon);
        scheduleFit(true);
      })
      .catch(() => {});

    term.focus();

    /**
     * Re-fit and notify the server of the new dimensions.
     * When forceRedraw is true, jiggle the size by 1 row first to force
     * tmux to SIGWINCH even when dimensions haven't changed - this makes
     * the app inside tmux redraw at the correct size after stale replay.
     */
    function fitAndSync(forceRedraw = false) {
      const wrapper = containerRef.current?.parentElement;
      if (!wrapper?.isConnected) return;
      const bounds = wrapper.getBoundingClientRect();
      if (bounds.width < 2 || bounds.height < 2) return;

      fitAddon.fit();
      // Font loading, renderer changes, and CSS resizing can leave WebGL's
      // cached glyphs at the previous cell size. Rebuild the atlas before the
      // redraw so characters do not overlap after a refresh or resize.
      term.clearTextureAtlas();
      if (term.rows > 0) term.refresh(0, term.rows - 1);
      if (redrawFrame !== null) cancelAnimationFrame(redrawFrame);
      redrawFrame = requestAnimationFrame(() => {
        redrawFrame = null;
        if (!cancelled && term.rows > 0) term.refresh(0, term.rows - 1);
      });
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (forceRedraw && term.rows > 2) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows - 1 }));
        }
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    }

    /**
     * Batch layout changes into the next frame. ResizeObserver can fire before
     * the browser has committed a new container size, especially during the
     * work-page collapse animation.
     */
    function scheduleFit(forceRedraw = false) {
      pendingForceRedraw ||= forceRedraw;
      if (fitFrame !== null) return;
      fitFrame = requestAnimationFrame(() => {
        fitFrame = null;
        const shouldForceRedraw = pendingForceRedraw;
        pendingForceRedraw = false;
        if (!cancelled) fitAndSync(shouldForceRedraw);
      });
    }

    termRef.current = term;
    refitRef.current = scheduleFit;

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
      // Cmd+Enter toggles maximize - handle here since xterm captures the event
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey) {
        if (ev.type === 'keydown') callbacksRef.current.onToggleMaximize?.();
        return false;
      }
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

    // Resize handling - observe the wrapper (outer div) so we catch
    // layout changes even when the inner container dimensions haven't
    // propagated yet.
    observer = new ResizeObserver(() => scheduleFit());
    const wrapper = containerRef.current.parentElement;
    if (wrapper) observer.observe(wrapper);

    scheduleFit(true);
    void document.fonts?.ready.then(() => {
      if (!cancelled) scheduleFit(true);
    });

    function connectWs() {
      if (cancelled || !term) return;

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fullUrl = wsUrl.startsWith('ws') ? wsUrl : `${protocol}//${window.location.host}${wsUrl}`;
      const ws = new WebSocket(fullUrl);
      wsRef.current = ws;
      if (externalWsRefRef.current) externalWsRefRef.current.current = ws;

      ws.onopen = () => {
        if (reconnectAttempt > 0) {
          term.write('\r\n\x1b[32m[Reconnected]\x1b[0m\r\n');
        }
        reconnectAttempt = 0;
        // Re-fit now that the connection is live - layout is settled by this point
        scheduleFit();
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            term.write(msg.data);
          } else if (msg.type === 'replay') {
            // Replay may contain historical terminal queries. Rendering it
            // with stdin enabled would answer stale queries after tmux has
            // stopped waiting and inject their replies into the pane.
            writeTerminalReplay(term, msg.data, () => {
              if (cancelled) return;
              // The replay data was formatted for the previous client's
              // dimensions. Redraw only after xterm has parsed it.
              scheduleFit(true);
            });
          } else if (msg.type === 'exit') {
            term.write(`\r\n[Process exited with code ${msg.code}]\r\n`);
            cancelled = true;
            callbacksRef.current.onExit?.(msg.code);
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
      if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      if (redrawFrame !== null) cancelAnimationFrame(redrawFrame);
      observer?.disconnect();
      const ws = wsRef.current;
      ws?.close();
      if (externalWsRefRef.current?.current === ws) externalWsRefRef.current.current = null;
      if (wsRef.current === ws) wsRef.current = null;
      if (refitRef.current === scheduleFit) refitRef.current = null;
      term?.dispose();
    };
  }, [wsUrl]);

  useEffect(() => {
    if (!externalWsRef) return undefined;
    externalWsRef.current = wsRef.current;
    return () => {
      if (externalWsRef.current === wsRef.current) externalWsRef.current = null;
    };
  }, [externalWsRef]);

  useEffect(() => {
    if (focus && termRef.current) {
      refitRef.current?.(true);
      termRef.current.focus();
    }
  }, [focus]);

  const handleClick = () => {
    if (termRef.current) termRef.current.focus();
  };

  return (
    <div className={`${styles.wrapper}${borderless ? ` ${styles.borderless}` : ''}`} onClick={handleClick}>
      <div ref={containerRef} className={styles.terminal} />
    </div>
  );
}
