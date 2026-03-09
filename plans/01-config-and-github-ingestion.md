# 01 - Config and GitHub Ingestion

## Goal

Pull open PRs from a known list of GitHub orgs and cache them locally in SQLite.

## File structure

```
src/
  config.js          - config loading, validation, live-reload, event emitter
  db.js              - SQLite setup, all table schemas (prs, workspaces, sessions), query helpers
  poller.js          - GitHub polling loop
  index.js           - entry point (starts poller, later starts server)
config.json          - user config (gitignored, copied from config.example.json)
config.example.json  - example config checked into repo
```

## Config (live-reloaded)

JSON file at project root. Watched with `fs.watchFile` (more reliable than `fs.watch` for single files on macOS).

```json
{
  "orgs": ["org-a", "org-b"],
  "poll_interval_seconds": 30,
  "db_path": "./data/claude-patrol.db",
  "port": 3000,
  "workspace_base_path": "~/.claude-patrol/workspaces",
  "main_repo_path": "~/work/repo",
  "symlinks": {
    "claude_memory": "~/.claude/memory",
    "jsgr_token": "~/.config/jsgr/token"
  }
}
```

Config module:
- `loadConfig()` - read, validate (required fields, types), return frozen object
- `watchConfig(callback)` - on file change, validate new config, call callback if valid, log warning if invalid
- Export an EventEmitter: `config.on('change', (newConfig) => { ... })`
- Consumers re-read what they need on change (poller adjusts interval, etc.)

## GitHub Poller

Use `gh api graphql` to fetch PRs. This avoids building a separate auth layer - reuses `gh auth` directly.

GraphQL query fetches per org:
```graphql
query($org: String!, $cursor: String) {
  search(query: "org:$org is:pr is:open author:@me", type: ISSUE, first: 100, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        isDraft
        headRefName
        createdAt
        updatedAt
        repository { name owner { login } }
        labels(first: 10) { nodes { name color } }
        reviews(last: 10) { nodes { author { login } state submittedAt } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 50) {
                  nodes {
                    ... on CheckRun { name status conclusion detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

Invoked via: `gh api graphql -f query='...' -f org='org-a'`

Poller module:
- `startPoller(config)` - starts `setInterval` at configured rate
- Each tick: run query per org, upsert results into SQLite, log count
- On config change: clear old interval, start new one with updated interval/orgs
- Rate limit: GitHub GraphQL has 5000 points/hour. This query costs ~1 point per org per tick. At 30s intervals, 2 orgs = 240 points/hour. Not a concern.

## SQLite Schema

Single table. Checks, reviews, and labels stored as JSON columns - no JOINs needed for a local tool with <100 PRs.

```sql
CREATE TABLE IF NOT EXISTS prs (
  id TEXT PRIMARY KEY,          -- 'org/repo#number' composite key
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  repo TEXT NOT NULL,
  org TEXT NOT NULL,
  author TEXT NOT NULL,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0,
  checks JSON NOT NULL DEFAULT '[]',    -- [{name, status, conclusion, url}]
  reviews JSON NOT NULL DEFAULT '[]',   -- [{reviewer, state, submitted_at}]
  labels JSON NOT NULL DEFAULT '[]',    -- [{name, color}]
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  synced_at TEXT NOT NULL               -- when we last fetched this PR
);

CREATE INDEX IF NOT EXISTS idx_prs_org ON prs(org);
CREATE INDEX IF NOT EXISTS idx_prs_repo ON prs(repo);
```

Upsert on each sync: `INSERT OR REPLACE INTO prs ...`

PRs that disappear from GitHub (closed/merged) get deleted: after each sync, delete any PR in SQLite for that org that wasn't in the latest result set.

## Dependencies

- `better-sqlite3` - SQLite driver
- No other runtime deps for this phase

## Deliverable

- `node src/index.js` starts the poller, creates/populates SQLite
- Config changes (edit config.json, save) take effect within seconds
- Can verify with `sqlite3 ./data/claude-patrol.db "SELECT org, repo, number, title FROM prs"`
