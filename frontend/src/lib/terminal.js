/**
 * Send a command to a Claude terminal via WebSocket, delivering the final
 * Enter keystroke as a separate message after a short delay.  This ensures
 * the PTY processes the full command text before the Enter arrives - without
 * the split, fast sends can swallow the Enter.
 *
 * @param {WebSocket} ws  - Open WebSocket connection to the terminal
 * @param {string}    cmd - Command text (any trailing \r is stripped automatically)
 * @param {{ delay?: number }} [opts]
 */
export function sendTerminalCommand(ws, cmd, { delay = 100 } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  // Strip trailing carriage-return so callers don't have to remember
  const text = cmd.replace(/\r+$/, '');

  ws.send(JSON.stringify({ type: 'input', data: text }));
  setTimeout(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: '\r' }));
    }
  }, delay);
}
