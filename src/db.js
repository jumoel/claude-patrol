import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT NOT NULL REFERENCES prs(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
      created_at TEXT NOT NULL,
      destroyed_at TEXT
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_workspaces_pr ON workspaces(pr_id)');
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_active_pr ON workspaces(pr_id) WHERE status = 'active'");

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
