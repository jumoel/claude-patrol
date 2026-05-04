# Plan: PTY Server-Side Helpers (precursor to rules engine)

## Context

Plan 18 (rules engine) needs two pieces of PTY-state functionality from outside `src/pty-manager.js`:

1. **`writeToSession(sessionId, text)`** - server-side prompt injection into a Claude session. Today the only path that calls `entry.proc.write(text)` is the WebSocket `'input'` handler at `src/pty-manager.js:474-500`. Browser-only.
2. **`waitForFirstIdle(sessionId, timeoutMs)`** - resolve when a freshly-spawned session reaches `'idle'` state for the first time. A new session starts in state `null` (per `pty-manager.js:127-133`), transitions to `'working'` on Claude boot output, then to `'idle'` when Claude settles. Writing a prompt before that first `'idle'` would dump it into the boot screen and lose it.

These are PTY-state concerns, not rules-engine concerns. Lifting them into `pty-manager.js` keeps the layering right and gives any future caller (frontend, MCP tool, etc.) the same primitives.

This plan is independent of the others and can land standalone.

---

## Scope (in)

- Export `writeToSession(sessionId, text): boolean` from `pty-manager.js`
- Export `waitForFirstIdle(sessionId, timeoutMs): Promise<void>` from `pty-manager.js`
- A constant `BOOT_TIMEOUT_MS_DEFAULT` (e.g. 30_000) colocated with the other PTY constants

## Scope (out)

- Multi-line / bracketed-paste write semantics (rules engine v1 is single-line + `\r`; deferred regardless)
- Any session-creation refactor
- Hooking the helpers into the rules engine itself - that's plan 18

---

## Changes

### `src/pty-manager.js`

```js
/**
 * Write text directly into a session's PTY. Used by server-side callers
 * (rules engine, future automation) to inject prompts. Callers append
 * any submission key (e.g. '\r') themselves.
 * @param {string} sessionId
 * @param {string} text
 * @returns {boolean} false if session not found or not active
 */
export function writeToSession(sessionId, text) {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  entry.proc.write(text);
  return true;
}

/**
 * Resolve when the session emits its first 'idle' event after this call.
 * If the session is already in 'idle' state, resolves immediately.
 * Rejects if the session exits, is not found, or the timeout elapses.
 * @param {string} sessionId
 * @param {number} [timeoutMs=BOOT_TIMEOUT_MS_DEFAULT]
 * @returns {Promise<void>}
 */
export function waitForFirstIdle(sessionId, timeoutMs = BOOT_TIMEOUT_MS_DEFAULT) {
  return new Promise((resolve, reject) => {
    const entry = sessions.get(sessionId);
    if (!entry) return reject(new Error(`Session ${sessionId} not found`));
    if (entry.activityState === 'idle') return resolve();

    const handler = (data) => {
      if (data.sessionId !== sessionId) return;
      if (data.state === 'idle') {
        cleanup();
        resolve();
      } else if (data.state === 'exited') {
        cleanup();
        reject(new Error(`Session ${sessionId} exited before reaching idle`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Session ${sessionId} did not reach idle within ${timeoutMs}ms`));
    }, timeoutMs);
    function cleanup() {
      appEvents.removeListener('session-state', handler);
      clearTimeout(timer);
    }
    appEvents.on('session-state', handler);
  });
}
```

`pty-manager.js` currently imports only `emitSessionState` from `./app-events.js`. Add `appEvents` to the same import line so `waitForFirstIdle` can subscribe:

```js
import { appEvents, emitSessionState } from './app-events.js';
```

---

## File Summary

| File | Change |
|---|---|
| `src/pty-manager.js` | Export `writeToSession` and `waitForFirstIdle` (plus `BOOT_TIMEOUT_MS_DEFAULT`) |

---

## Verification

1. **`writeToSession` unknown session:** call with a bogus id; returns `false` cleanly without throwing.
2. **`writeToSession` write-through:** spawn a session, attach a WS, then call `writeToSession(id, 'echo hi\r')` from server-side code. The text appears in the WS replay buffer and is rendered in the terminal UI.
3. **`waitForFirstIdle` happy path:** spawn a session, await `waitForFirstIdle`. Resolves when `emitSessionState(... 'idle')` fires (post-boot).
4. **`waitForFirstIdle` already-idle:** call on a session whose `activityState` is already `'idle'`. Resolves immediately on the next microtask.
5. **`waitForFirstIdle` exit before idle:** spawn a session, kill its tmux pane before Claude finishes booting. Promise rejects with `exited before reaching idle`.
6. **`waitForFirstIdle` timeout:** simulate a session that never goes idle (e.g. start `claude` in a mode that never settles, or test with a small `timeoutMs` and a busy session). Promise rejects with the timeout message.

---

## Out-of-scope reminders

- Don't change the input handler at `pty-manager.js:474-500` - it has special CSI/kitty handling that goes through `tmux send-keys`, which is irrelevant for server-side prompts.
- Don't add bracketed paste handling here - that's a separate plan if/when multi-line prompts are needed.
