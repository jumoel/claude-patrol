import { execFile } from 'node:child_process';
import { submitPromptToEntry } from './session-input.js';

/**
 * WebSocket message dispatch table. Each entry owns both validation and
 * handling for a single message type, so adding a new type is one entry -
 * impossible to add a handler without validation or vice versa. Previously
 * had a separate `parseWsMessage` whitelist that drifted from the dispatcher
 * and silently dropped `prompt-submit` messages for the duration of the
 * f2436f3 → ebf502f window. (See `claude-patrol#2`.)
 *
 * Handlers receive `(entry, msg, ctx)`. `ctx` carries per-session info that
 * isn't on the entry itself (currently just `tmuxName`).
 *
 * @type {Record<string, {
 *   validate: (msg: any) => boolean,
 *   handle: (entry: any, msg: any, ctx: { tmuxName: string, execFile?: typeof execFile }) => void,
 * }>}
 */
const WS_MESSAGE_HANDLERS = {
  input: {
    validate: (msg) => typeof msg.data === 'string',
    handle: (entry, msg, ctx) => {
      if (msg.data.includes('\r') || msg.data.includes('\n')) entry.markWorking?.('terminal_input');
      // CSI u sequences (kitty keyboard protocol) can't go through tmux's
      // input parser - it doesn't understand them. Route them via
      // `tmux send-keys` which writes directly to the inner pane's PTY,
      // bypassing tmux's own key interpretation.
      if (msg.data.includes('\x1b[') && /\x1b\[\d+;\d+u/.test(msg.data)) {
        const hexKeys = [];
        for (let i = 0; i < msg.data.length; i++) {
          hexKeys.push(msg.data.charCodeAt(i).toString(16).padStart(2, '0'));
        }
        (ctx.execFile ?? execFile)(
          'tmux',
          ['send-keys', '-t', ctx.tmuxName, '-H', ...hexKeys],
          { timeout: 2000 },
          (error) => {
            if (error) console.warn(`[pty-manager] tmux send-keys failed for ${ctx.tmuxName}: ${error.message}`);
          },
        );
      } else {
        entry.proc.write(msg.data);
      }
    },
  },
  'prompt-submit': {
    // Programmatic prompt submission: write the text, wait briefly, write
    // Enter. Shares `submitPromptToEntry` with the server-side rules engine
    // so the split timing lives in one place.
    validate: (msg) => typeof msg.text === 'string',
    handle: (entry, msg) => {
      entry.markWorking?.('terminal_input');
      submitPromptToEntry(entry, msg.text).catch((error) => {
        console.warn(`[pty-manager] prompt-submit write failed: ${error.message}`);
      });
    },
  },
  resize: {
    validate: (msg) => Number.isInteger(msg.cols) && Number.isInteger(msg.rows),
    handle: (entry, msg) => {
      try {
        entry.proc.resize(msg.cols, msg.rows);
      } catch {
        // PTY fd already closed (EBADF) - session exited but WS still open
        return;
      }
    },
  },
  scroll: {
    validate: (msg) => Number.isInteger(msg.lines) && msg.lines !== 0 && Math.abs(msg.lines) <= 100,
    handle: (_entry, msg, ctx) => {
      const count = Math.abs(msg.lines);
      const command = msg.lines < 0 ? 'scroll-up' : 'scroll-down';
      const scrollCommand = `send-keys -X -t ${ctx.tmuxName} -N ${count} ${command}`;
      const enterAndScrollCommand = `copy-mode -e -t ${ctx.tmuxName} ; ${scrollCommand}`;
      const execFileImpl = ctx.execFile ?? execFile;
      execFileImpl(
        'tmux',
        ['if-shell', '-F', '-t', ctx.tmuxName, '#{pane_in_mode}', scrollCommand, enterAndScrollCommand],
        { timeout: 2_000 },
        () => {},
      );
    },
  },
};

/**
 * Dispatch a parsed WS message to its handler. Returns the handler entry that
 * was invoked (for testing) or null if the message was rejected. Exported so
 * tests can hit the validation + dispatch path without standing up a real
 * WebSocket + PTY.
 *
 * @param {string} raw - raw WS frame text
 * @param {any}    entry - session entry from the `sessions` map
 * @param {{tmuxName: string, execFile?: typeof execFile}} ctx
 * @returns {{ type: string } | null}
 */
export function dispatchWsMessage(raw, entry, ctx) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg.type !== 'string') return null;
  const handler = WS_MESSAGE_HANDLERS[msg.type];
  if (!handler || !handler.validate(msg)) return null;
  handler.handle(entry, msg, ctx);
  return { type: msg.type };
}
