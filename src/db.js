import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** @type {DatabaseSync | null} */
let db = null;

/**
 * Initialize the database, creating tables if needed.
 * @param {string} dbPath - absolute path (already expanded by config loader)
 * @returns {DatabaseSync}
 */
export function initDb(dbPath) {
  if (db) {
    db.close();
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  /** Run ALTER TABLE ADD COLUMN, logging success and swallowing "already exists". */
  function addColumn(table, columnDef) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
      const colName = columnDef.split(/\s/)[0];
      console.log(`[db] Migration: added column ${table}.${colName}`);
    } catch {
      /* column already exists */
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS prs (
      id TEXT PRIMARY KEY,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      repo TEXT NOT NULL,
      org TEXT NOT NULL,
      author TEXT NOT NULL,
      url TEXT NOT NULL,
      branch TEXT NOT NULL,
      draft INTEGER NOT NULL DEFAULT 0,
      checks JSON NOT NULL DEFAULT '[]',
      reviews JSON NOT NULL DEFAULT '[]',
      labels JSON NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT NOT NULL
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_prs_org ON prs(org)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_prs_repo ON prs(repo)');

  addColumn('prs', "mergeable TEXT NOT NULL DEFAULT 'UNKNOWN'");
  addColumn('prs', "base_branch TEXT NOT NULL DEFAULT 'main'");
  addColumn('prs', "body TEXT NOT NULL DEFAULT ''");
  addColumn('prs', "body_html TEXT NOT NULL DEFAULT ''");
  addColumn('prs', "pr_summary TEXT NOT NULL DEFAULT ''")

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT REFERENCES prs(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      repo TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
      created_at TEXT NOT NULL,
      destroyed_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_workspaces_pr ON workspaces(pr_id)');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_active_pr ON workspaces(pr_id) WHERE status = 'active'");

  // Migration: make pr_id nullable and add repo column (SQLite requires table recreation)
  {
    const cols = db.prepare("PRAGMA table_info('workspaces')").all();
    const prIdCol = cols.find((c) => c.name === 'pr_id');
    const repoCol = cols.find((c) => c.name === 'repo');
    if ((prIdCol && prIdCol.notnull === 1) || !repoCol) {
      console.log('[db] Migration: recreating workspaces table (nullable pr_id + repo column)');
      db.exec('PRAGMA foreign_keys = OFF');
      db.exec('BEGIN');
      try {
        db.exec(`CREATE TABLE workspaces_new (
          id TEXT PRIMARY KEY,
          pr_id TEXT REFERENCES prs(id),
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          bookmark TEXT NOT NULL,
          repo TEXT,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
          created_at TEXT NOT NULL,
          destroyed_at TEXT
        )`);
        db.exec(
          'INSERT INTO workspaces_new (id, pr_id, name, path, bookmark, status, created_at, destroyed_at) SELECT id, pr_id, name, path, bookmark, status, created_at, destroyed_at FROM workspaces',
        );
        db.exec('DROP TABLE workspaces');
        db.exec('ALTER TABLE workspaces_new RENAME TO workspaces');
        db.exec('CREATE INDEX idx_workspaces_pr ON workspaces(pr_id)');
        db.exec("CREATE UNIQUE INDEX idx_workspaces_active_pr ON workspaces(pr_id) WHERE status = 'active'");
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'detached', 'killed')),
      started_at TEXT NOT NULL,
      ended_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id)');

  addColumn('sessions', 'claude_project_dir TEXT');
  addColumn('sessions', 'transcript_path TEXT');
  addColumn('workspaces', 'summary TEXT');
  addColumn('workspaces', 'summary_updated_at TEXT');

  return db;
}

/**
 * Get the database instance. Throws if not initialized.
 * @returns {DatabaseSync}
 */
export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
