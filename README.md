# Claude Patrol

A PR dashboard and workspace manager for teams using GitHub, [jj (Jujutsu)](https://martinvonz.github.io/jj/), and [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli). Polls your GitHub orgs and repos for open PRs, shows CI/review/merge status at a glance, and lets you spin up jj workspaces with integrated Claude terminal sessions - all from one place.

![Dashboard with terminal](screenshots/resizable-terminal.png)

## What it does

- **PR dashboard** with live updates via SSE. Filter by org, repo, CI status, review state, merge status, draft. Quick filters for "Merge Ready", "Review Ready", and "Needs Work".
- **Workspace management** - create jj workspaces for any PR with one click. Supports per-repo symlinks, init commands, and Claude memory linking.
- **Terminal sessions** - embedded xterm.js terminals running Claude CLI inside tmux. Multiple clients (web + Ghostty) can share the same session. Pop out to a native terminal window at any time.
- **CI diagnostics** - view failed check logs inline, extract error context from GitHub Actions, retrigger failed checks.
- **MCP server** - exposes PR data, workspace ops, and CI logs as tools for Claude CLI. Claude can triage PRs, create workspaces, and investigate failures autonomously.

## Prerequisites

You'll need these installed and on your PATH:

- **Node.js** >= 22 (uses `node:sqlite` built-in)
- **pnpm** - package manager
- **gh** - GitHub CLI, authenticated (`gh auth login`)
- **jj** - Jujutsu version control
- **claude** - Claude CLI
- **tmux** - terminal multiplexer (for session sharing)
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

This builds the frontend, starts the server, and opens your browser. For development, use `node src/index.js --no-open` to skip the browser launch.

## Configuration

| Field | Description |
|---|---|
| `poll.orgs` | GitHub organizations to monitor |
| `poll.repos` | Individual `owner/repo` entries to monitor |
| `poll.interval_seconds` | Polling interval (minimum 5s) |
| `db_path` | Path to the SQLite database file |
| `port` | Server port (auto-increments if in use) |
| `workspace_base_path` | Base directory for jj workspaces |
| `work_dir` | Base directory where your repos are cloned |
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
    |-- MCP server: stdio transport for Claude CLI
    |
SQLite (node:sqlite) -- prs, workspaces, sessions
```

**Backend**: Fastify 5, node:sqlite (DatabaseSync), node-pty, MCP SDK, zod.
**Frontend**: React 19, Vite 7, Tailwind CSS 4, xterm.js 6, TanStack Table.

No native database dependencies - `node:sqlite` is built into Node.js.

## MCP tools

When Claude CLI connects via the MCP config, it gets access to:

- `list_prs` - list and filter PRs
- `get_pr` / `get_pr_diff` / `get_pr_comments` - PR details
- `get_check_logs` - failed CI logs with error extraction
- `create_workspace` / `destroy_workspace` / `cleanup_workspaces` - workspace management
- `retrigger_checks` - re-run failed CI
- `trigger_sync` - force a GitHub poll

The MCP config is auto-generated at startup and passed to Claude sessions.

## License

ISC
