# 04 - Terminal Bridge

## Goal

Interactive Claude CLI sessions running in jj workspaces, streamed to the browser via WebSocket.

## File structure

```
src/
  routes/
    sessions.js      - session CRUD endpoints + WebSocket upgrade
  pty-manager.js     - PTY lifecycle, output buffering, process management
```

## SQLite Schema Addition

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,           -- uuid
  workspace_id TEXT,             -- null for global session
  pid INTEGER,                   -- OS process ID
  status TEXT NOT NULL DEFAULT 'active',  -- active | detached | killed
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);
```

Note: This table should be created at app startup (plan 01's db.js), not when plan 04 is implemented. Plan 03's destroy sequence queries this table to kill sessions - if no sessions exist yet, the query just returns empty results.

## PTY Manager

### Spawning

Use `node-pty` to spawn `claude` in a pseudo-terminal:

```js
const pty = require('node-pty');

const proc = pty.spawn('claude', [], {
  name: 'xterm-256color',
  cols: 120,
  rows: 30,
  cwd: workspacePath,  // or project root for global session
  env: { ...process.env }
});
```

### Output buffer

Ring buffer per session, 50,000 bytes max. Used for replay when a client reattaches to an existing session. When buffer fills, oldest bytes are dropped.

Stored in memory (Map keyed by session ID), not persisted to disk. If the server restarts, sessions are dead anyway.

### Session registry

In-memory Map alongside SQLite:
```
sessions: Map<sessionId, { proc, buffer, websockets: Set<WebSocket> }>
```

SQLite is the source of truth for what sessions exist. The in-memory map holds live process handles and buffers.

On server startup: mark any sessions with status='active' as 'killed' in SQLite (they're orphaned from a previous run).

## WebSocket Protocol

Upgrade path: `GET /ws/sessions/:id` upgrades to WebSocket.

Messages are JSON:

**Client -> Server:**
```json
{ "type": "input", "data": "ls -la\r" }
{ "type": "resize", "cols": 120, "rows": 30 }
```

**Server -> Client:**
```json
{ "type": "output", "data": "..." }
{ "type": "replay", "data": "..." }     // sent on attach, contains buffer contents
{ "type": "exit", "code": 0 }           // PTY process exited
```

Multiple WebSocket clients can attach to the same session (e.g. multiple browser tabs). All see the same output. Input from any client goes to the same PTY.

## Session Lifecycle

### Create
1. Validate workspace exists (or null for global session)
2. Spawn PTY in workspace directory
3. Insert into SQLite with status='active'
4. Store proc + buffer in memory map
5. Return session ID

### Attach
1. Client opens WebSocket to `/ws/sessions/:id`
2. Server sends `replay` message with buffer contents
3. Add WebSocket to the session's client set
4. Forward PTY output to all connected clients
5. Forward client input to PTY stdin

### Detach
WebSocket closes (browser tab closed, network drop). Session keeps running. PTY output continues filling the buffer.

### Kill
1. Send SIGTERM to PTY process
2. Wait up to 5s, then SIGKILL if still alive
3. Close all connected WebSockets with `exit` message
4. Remove from memory map
5. Update SQLite: status='killed', ended_at=now

## Global Session

- Created on demand (first time user opens the global terminal panel)
- Runs in the claude-patrol project root directory
- workspace_id is null in the database
- If killed, can be re-created from the UI
- Only one global session at a time. Creating a new one when one exists returns the existing one.

## API Endpoints

**`POST /api/sessions`**
Body: `{ workspace_id: "..." }` or `{ global: true }`
Returns: `{ id: "...", ws_url: "ws://localhost:3000/ws/sessions/..." }`

**`GET /api/sessions`**
Returns all active/detached sessions. Filter by `workspace_id`.

**`DELETE /api/sessions/:id`**
Triggers kill sequence. Returns `{ ok: true }`.

## Frontend

### Terminal component (xterm.js)

```
frontend/src/components/
  Terminal/
    Terminal.jsx              - xterm.js instance, WebSocket connection, resize handling
    Terminal.module.css
    Terminal.stories.jsx      - stories with mock WebSocket for visual testing
  GlobalTerminal/
    GlobalTerminal.jsx        - persistent drawer/panel wrapping Terminal for global session
    GlobalTerminal.module.css
    GlobalTerminal.stories.jsx
  WorkspaceTerminal/
    WorkspaceTerminal.jsx     - terminal embedded in PR detail view
    WorkspaceTerminal.module.css
    WorkspaceTerminal.stories.jsx
```

Same rules as plan 02: all styles in CSS modules, no className props, no styles in parent pages. Variant behavior through explicit props (e.g. `<Terminal status="connected" />`).

Terminal.jsx:
- Initializes xterm.js with `@xterm/xterm` and `@xterm/addon-fit` (auto-resize to container)
- Connects to WebSocket URL
- On `replay` message: write to terminal (shows history)
- On `output` message: write to terminal
- On keypress: send `input` message over WebSocket
- On container resize: call `fitAddon.fit()`, send `resize` message

GlobalTerminal.jsx:
- Fixed panel at bottom of the UI (collapsible drawer)
- Creates global session on first open
- Persists across page navigation (mounted at app shell level, not per-route)

## Dependencies

- `node-pty` - pseudo-terminal spawning (native addon, needs build tools)
- `@xterm/xterm` - terminal emulator for the browser
- `@xterm/addon-fit` - auto-resize addon
- `@fastify/websocket` - WebSocket support for Fastify

## Deliverable

- Open global terminal from any page, interact with Claude
- Create workspace, open terminal for it, interact with Claude in that workspace context
- Close browser tab, reopen, reattach to running session with output history
- Kill session from UI
