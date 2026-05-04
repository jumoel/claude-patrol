/**
 * Submit a prompt to a Claude terminal via WebSocket. Sends a single
 * `prompt-submit` message; the server-side handler writes the text, waits
 * briefly for the PTY to paint the input field, then writes Enter as a
 * separate write. The split-write timing lives in `pty-manager.js` and is
 * shared with the server-side rules engine - sending text+Enter in one
 * write can cause Claude's TUI to swallow the Enter.
 *
 * @param {WebSocket} ws  - Open WebSocket connection to the terminal
 * @param {string}    cmd - Command text (any trailing \r is stripped server-side)
 */
export function sendTerminalCommand(ws, cmd) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'prompt-submit', text: cmd }));
}
