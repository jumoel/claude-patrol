/** Schema v7 intentionally resets every pre-v7 database. */

export const CURRENT_SCHEMA_VERSION = 7;

function resetSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS automation_jobs;
    DROP TABLE IF EXISTS rule_subscriptions;
    DROP TABLE IF EXISTS rule_runs;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS workspaces;
    DROP TABLE IF EXISTS sync_state;
    DROP TABLE IF EXISTS prs;

    CREATE TABLE prs (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      repo TEXT NOT NULL,
      org TEXT NOT NULL,
      author TEXT NOT NULL,
      url TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL DEFAULT 'main',
      is_fork INTEGER NOT NULL DEFAULT 0,
      draft INTEGER NOT NULL DEFAULT 0,
      mergeable TEXT NOT NULL DEFAULT 'UNKNOWN',
      checks JSON NOT NULL DEFAULT '[]',
      reviews JSON NOT NULL DEFAULT '[]',
      labels JSON NOT NULL DEFAULT '[]',
      comments JSON NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );

    CREATE INDEX idx_prs_org ON prs(org);
    CREATE INDEX idx_prs_repo ON prs(repo);

    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT REFERENCES prs(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      repo TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
      created_at TEXT NOT NULL,
      destroyed_at TEXT,
      operation_state TEXT NOT NULL DEFAULT 'ready',
      operation_step TEXT,
      operation_error TEXT,
      operation_updated_at TEXT
    );

    CREATE INDEX idx_workspaces_pr ON workspaces(pr_id);
    CREATE INDEX idx_workspaces_operation_state ON workspaces(operation_state);
    CREATE UNIQUE INDEX idx_workspaces_active_pr
      ON workspaces(pr_id) WHERE status = 'active';

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'detached', 'killed')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      claude_project_dir TEXT,
      transcript_path TEXT
    );

    CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);

    CREATE TABLE rule_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      pr_id TEXT,
      workspace_id TEXT,
      session_id TEXT,
      cooldown_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running', 'success', 'error')),
      error TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE INDEX idx_rule_runs_cooldown
      ON rule_runs(rule_id, cooldown_key, started_at);
    CREATE INDEX idx_rule_runs_started ON rule_runs(started_at DESC);

    CREATE TABLE rule_subscriptions (
      rule_id TEXT NOT NULL,
      pr_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, pr_id)
    );

    CREATE INDEX idx_rule_subscriptions_pr ON rule_subscriptions(pr_id);

    CREATE TABLE sync_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      synced_at TEXT,
      last_sweep_at TEXT,
      last_full_sweep_at TEXT
    );

    INSERT INTO sync_state (id) VALUES (1);

    CREATE TABLE automation_jobs (
      id TEXT PRIMARY KEY REFERENCES rule_runs(id) ON DELETE CASCADE,
      payload JSON NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'done', 'cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dedupe_key TEXT
    );

    CREATE INDEX idx_automation_jobs_status
      ON automation_jobs(status, created_at);
    CREATE UNIQUE INDEX idx_automation_jobs_dedupe
      ON automation_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
}

/**
 * Upgrade a database to the current schema. The v7 reset and version update
 * happen in one transaction; db.js writes a pre-migration backup first.
 */
export function migrateDb(db) {
  const row = db.prepare('PRAGMA user_version').get();
  const version = Number(row?.user_version ?? 0);
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Database schema ${version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`);
  }
  if (version === CURRENT_SCHEMA_VERSION) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    resetSchema(db);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.exec('COMMIT');
    console.log(`[db] Destructive schema reset to version ${CURRENT_SCHEMA_VERSION} complete`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
