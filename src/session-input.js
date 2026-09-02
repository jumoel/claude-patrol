/**
 * Writing prompts into a session PTY. Shared by the WebSocket prompt-submit
 * handler and the server-side dispatcher so the timing lives in one place.
 */

/**
 * Default delay between writing prompt text and writing the Enter that
 * submits it. Single source of truth for the WS `prompt-submit` handler and
 * server-side dispatchers.
 */
const PROMPT_SUBMIT_DELAY_MS = 100;

/**
 * Internal: write `text + Enter` to a session entry's PTY using the two-step
 * split that Claude's TUI requires (text first, brief delay, then Enter).
 * Sending them as a single write can cause the TUI to swallow Enter while
 * still painting the input field.
 *
 * Both the WebSocket `prompt-submit` handler and `dispatchToSession` route
 * through here so the split lives in exactly one place.
 *
 * @param {object} entry - session entry from `sessions` map
 * @param {string} text
 * @param {number} delay
 * @returns {Promise<void>}
 */
export async function submitPromptToEntry(entry, text, delay = PROMPT_SUBMIT_DELAY_MS) {
  const stripped = text.replace(/\r+$/, '');
  entry.proc.write(stripped);
  await new Promise((r) => setTimeout(r, delay));
  entry.proc.write('\r');
}
