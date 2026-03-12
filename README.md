# Claude Patrol

A self-hosted PR monitoring dashboard that watches your GitHub orgs and repos, shows CI/review/merge status at a glance, and lets you spin up jj workspaces with embedded Claude Code terminal sessions. When something needs attention, you can dispatch Claude to investigate and fix it - all from one place.

![Claude Patrol dashboard](screenshots/dashboard.png)

## What it does

- **PR dashboard** - live-updating table of open PRs across your GitHub orgs and repos. Filter by org, repo, CI status, review state, merge readiness, draft. Quick filters for "Merge Ready", "Review Ready", and "Needs Work".
- **Workspace management** - create jj workspaces for any PR with one click. Supports per-repo symlinks, init commands, and Claude memory linking.
- **Terminal sessions** - embedded xterm.js terminals running Claude Code inside tmux. Multiple browser tabs or a native Ghostty window can share the same session. Pop out to Ghostty at any time.
- **Session transcripts** - Claude Code JSONL transcripts are archived when sessions end. View past conversations with searchable, structured output (tool calls, thinking blocks, results).
- **CI diagnostics** - view failed check logs inline, extract error context from GitHub Actions, retrigger failed checks.
- **MCP server** - exposes PR data, workspace ops, and CI logs as tools for Claude Code. Claude can triage PRs, create workspaces, and investigate failures autonomously.

## Prerequisites

You'll need these installed and on your PATH:

- **Node.js** >= 22 (uses `node:sqlite` built-in)
- **pnpm** - package manager
- **gh** - GitHub CLI, authenticated (`gh auth login`)
- **jj** - Jujutsu version control
- **claude** - Claude Code CLI
- **tmux** - terminal multiplexer (sessions survive server restarts)
- **Ghostty** (optional) - for the "Pop out" and "Terminal" buttons

## Getting started

```sh
$ git clone <repo-url> && cd claude-patrol
$ pnpm install
```

Create a `config.json` in the project root:

```json
{
  "poll": {
    "orgs": ["your-org"],
    "repos": ["owner/repo"],
    "interval_seconds": 600
  },
  "db_path": "./data/claude-patrol.db",
  "port": 3000,
  "workspace_base_path": "~/.claude-patrol/workspaces",
  "work_dir": "~/work",
  "global_terminal_cwd": "~/work"
}
```

Then start the server:

```sh
$ pnpm start
```

This builds the frontend and starts the server. Press space to open the dashboard in your browser, or pass `--open` to launch it automatically.

## Running in development

```sh
$ pnpm watch
```

This runs `vite build --watch` for the frontend and the backend server concurrently. The server's TUI (status bar, keyboard shortcuts) works normally. When you edit a backend `.js` file, the server restarts automatically with `--reattach` - active terminal sessions survive the restart and browser WebSockets reconnect.

## CLI

If you install globally (`pnpm install -g`), the `claude-patrol` command is available:

```sh
$ claude-patrol start [--open]   # build frontend, start server
$ claude-patrol stop             # graceful shutdown
$ claude-patrol status           # show running state and uptime
$ claude-patrol clean            # remove DB, PID file, MCP config
```

Running without a subcommand defaults to `start`.

## Configuration

| Field | Description |
|---|---|
| `poll.orgs` | GitHub organizations to monitor |
| `poll.repos` | Individual `owner/repo` entries to monitor |
| `poll.interval_seconds` | Polling interval (minimum 5s) |
| `db_path` | Path to the SQLite database file |
| `port` | Server port (auto-increments if in use) |
| `workspace_base_path` | Base directory for jj workspaces |
| `work_dir` | Base directory where your repos are cloned. Expects a `<org>/<repo>` structure (e.g. `~/work/acme/api-server`, `~/work/acme/webapp`). When creating jj workspaces, Claude Patrol resolves the main repo at `<work_dir>/<org>/<repo>`. |
| `global_terminal_cwd` | Working directory for the global terminal |
| `symlink_memory` | Create `.claude/memory` symlinks in workspaces |
| `repos.<org/repo>.symlinks` | Additional symlinks to create in workspaces |
| `repos.<org/repo>.initCommands` | Commands to run after workspace creation |

Config changes are picked up automatically - no restart needed.

## Architecture

```
Browser (React + xterm.js)
    |
    |-- REST API (/api/prs, /api/workspaces, /api/sessions, ...)
    |-- SSE (/api/events) for live PR updates
    |-- WebSocket (/ws/sessions/:id) for terminal I/O
    |
Fastify server
    |-- Poller: gh api graphql -> SQLite
    |-- PTY manager: tmux sessions with node-pty bridge
    |-- Workspace manager: jj workspace create/destroy
    |-- MCP server: stdio transport for Claude Code
    |
SQLite (node:sqlite) -- prs, workspaces, sessions
```

**Backend**: Fastify 5, node:sqlite (DatabaseSync), node-pty, MCP SDK, zod.
**Frontend**: React 19, Vite 7, Tailwind CSS 4, xterm.js 6, TanStack Table.

No native database dependencies - `node:sqlite` is built into Node.js.

## API

**PRs**: `GET /api/prs` (filterable), `GET /api/prs/:id`, `GET /api/prs/:id/diff`, `GET /api/prs/:id/comments`, `GET /api/prs/:id/check-logs`

**Workspaces**: `POST /api/workspaces`, `GET /api/workspaces`, `GET /api/workspaces/:id`, `DELETE /api/workspaces/:id`, `POST /api/workspaces/:id/terminal`, `POST /api/workspaces/cleanup`

**Sessions**: `POST /api/sessions`, `GET /api/sessions`, `DELETE /api/sessions/:id`, `POST /api/sessions/:id/popout`, `GET /api/sessions/history`, `GET /api/sessions/:id/transcript`

**Other**: `POST /api/sync/trigger`, `GET /api/config`, `GET /api/events` (SSE), `POST /api/checks/retrigger`

## MCP tools

When Claude Code connects via the auto-generated MCP config, it gets access to:

- `list_prs` - list and filter PRs
- `get_pr` / `get_pr_diff` / `get_pr_comments` - PR details
- `get_check_logs` - failed CI logs with error extraction
- `create_workspace` / `create_scratch_workspace` / `destroy_workspace` / `cleanup_workspaces` - workspace management
- `list_workspaces` - list workspaces with filtering
- `retrigger_checks` - re-run failed CI
- `wait_for_checks` - poll until CI checks reach a final state
- `trigger_sync` - force a GitHub poll

## License

ISC
