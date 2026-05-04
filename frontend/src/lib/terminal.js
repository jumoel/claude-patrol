/**
 * Submit a prompt to a Claude terminal via WebSocket. Sends a single
 * `prompt-submit` message; the server-side handler writes the text, waits
 * briefly for the PTY to paint the input field, then writes Enter as a
 * separate write. The split-write timing lives in `pty-manager.js` and is
 * shared with the server-side rules engine - sending text+Enter in one
 * write can cause Claude's TUI to swallow the Enter.
 *
 * Returns true on success, false when dropped (with a console.warn). Silent
 * drops were previously how the f2436f3 / parseWsMessage regression hid for
 * hours - a noisy drop is strictly better.
 *
 * @param {WebSocket | null | undefined} ws
 * @param {string} cmd - Command text (any trailing \r is stripped server-side)
 * @returns {boolean}
 */
export function sendTerminalCommand(ws, cmd) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('[sendTerminalCommand] WebSocket not open; command dropped');
    return false;
  }
  ws.send(JSON.stringify({ type: 'prompt-submit', text: cmd }));
  return true;
}

/**
 * Wait until `wsRef.current` is an open WebSocket, polling every 50ms up to
 * `timeoutMs`. Returns the open WS, or null on timeout. Used by call sites
 * that just created a session and need to wait for the Terminal component
 * to mount + open its WS before sending a command.
 *
 * @param {{ current: WebSocket | null }} wsRef
 * @param {number} timeoutMs
 * @returns {Promise<WebSocket | null>}
 */
export async function whenWsOpen(wsRef, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
