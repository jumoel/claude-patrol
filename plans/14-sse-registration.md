# Plan: SSE Array-Driven Registration (precursor to rules engine)

## Context

`src/server.js:88-124` registers SSE event handlers by hand. Today it forwards 5 event types (`sync`, `local-change`, `session-state`, `task-update`, `gh-rate-limit`), each requiring boilerplate at three sites: handler definition, `.on()` registration, and `.removeListener()` on close.

Adding a 6th type (`rule-run`, in plan 18) means three more boilerplate sites. The pattern obviously wants to be array-driven. Doing the cleanup now keeps the rules-engine PR's diff focused on rules-engine logic.

This plan is independent of the others and can land standalone.

---

## Scope (in)

- Refactor SSE handler registration in `src/server.js` to be array-driven
- Preserve all existing behavior: same event types, same payload shapes, same replay-on-connect logic for session states and gh rate-limit
- No changes to emitters or consumers

## Scope (out)

- Adding new event types (rules engine adds `rule-run` in plan 18)
- Changing payload shapes
- Refactoring the `appEvents` / `pollerEvents` split

---

## Changes

### `src/server.js` (refactor only)

Replace the per-handler boilerplate with:

```js
const SSE_EVENTS = [
  { name: 'sync', emitter: pollerEvents },
  { name: 'local-change', emitter: appEvents, payload: () => ({}) },
  { name: 'session-state', emitter: appEvents },
  { name: 'task-update', emitter: appEvents },
  { name: 'gh-rate-limit', emitter: appEvents },
];

// Inside the /api/events handler:
const handlers = SSE_EVENTS.map(({ name, emitter, payload }) => {
  const handler = (data) => {
    const body = payload ? payload(data) : data;
    raw.write(`event: ${name}\ndata: ${JSON.stringify(body ?? {})}\n\n`);
  };
  emitter.on(name, handler);
  return { name, emitter, handler };
});

// Replay-on-connect (kept verbatim):
for (const s of getSessionStates()) {
  raw.write(`event: session-state\ndata: ${JSON.stringify(s)}\n\n`);
}
raw.write(`event: gh-rate-limit\ndata: ${JSON.stringify(getGhRateLimitState())}\n\n`);

request.raw.on('close', () => {
  for (const { name, emitter, handler } of handlers) {
    emitter.removeListener(name, handler);
  }
  sseConnections.delete(raw);
});
```

The `payload` field on `SSE_EVENTS` only exists for `local-change` (which currently emits `{}` regardless of the data). All other entries pass the emitted payload through unchanged.

---

## File Summary

| File | Change |
|---|---|
| `src/server.js` | Array-driven SSE registration; same external behavior |

---

## Verification

1. **Wire-format parity:** open a browser tab on the dashboard against `main` and against this branch. Compare the SSE stream in DevTools network tab over a poll cycle - same `event:` names, same `data:` payloads.
2. **Listener leak check:** open and close 10 SSE connections in a row. After all close, `pollerEvents.listenerCount('sync')` and equivalents on `appEvents` for each forwarded event must equal what they were before any connection (modulo any always-on handlers in other modules).
3. **Replay-on-connect:** start the server with active sessions. Connect a new SSE client. Confirm initial `session-state` events for each active session arrive, plus the current `gh-rate-limit` snapshot.
4. **Disconnect cleanup:** kill an SSE client mid-stream. The `request.raw.on('close')` callback fires; subsequent emits don't try to write to a closed socket.

---

## Out-of-scope reminders

- Do not add `rule-run` to the array - that's plan 18's job.
- Do not change the SSE format or compress events.
- Do not consolidate `pollerEvents` and `appEvents` into one bus.
