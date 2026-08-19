import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { parseConfig, updateConfig } from './config.js';
import { closeDb, initDb } from './db.js';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';

const temporaryDirectories = [];

afterEach(() => {
  closeDb();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'claude-patrol-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

test('a new database is migrated to the current schema', () => {
  const db = initDb(':memory:');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  assert.equal(version, CURRENT_SCHEMA_VERSION);

  const workspaceColumns = new Set(
    db
      .prepare("PRAGMA table_info('workspaces')")
      .all()
      .map((column) => column.name),
  );
  assert.ok(workspaceColumns.has('operation_state'));
  assert.ok(workspaceColumns.has('operation_error'));
  const sessionColumns = new Set(
    db
      .prepare("PRAGMA table_info('sessions')")
      .all()
      .map((column) => column.name),
  );
  assert.ok(sessionColumns.has('provider'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_jobs'").get());
});

test('the v7 to v8 migration preserves sessions as Claude sessions', () => {
  const path = join(temporaryDirectory(), 'v7.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      claude_project_dir TEXT,
      transcript_path TEXT
    );
    INSERT INTO sessions (id, status, started_at) VALUES ('session-1', 'active', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 7;
  `);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    { ...db.prepare('SELECT id, provider FROM sessions').get() },
    {
      id: 'session-1',
      provider: 'claude',
    },
  );
});

test('a pre-v7 database is backed up and reset to the clean schema', () => {
  const path = join(temporaryDirectory(), 'legacy.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE prs (
      id TEXT PRIMARY KEY, number INTEGER NOT NULL, title TEXT NOT NULL,
      repo TEXT NOT NULL, org TEXT NOT NULL, author TEXT NOT NULL,
      url TEXT NOT NULL, branch TEXT NOT NULL, draft INTEGER NOT NULL DEFAULT 0,
      checks JSON NOT NULL DEFAULT '[]', reviews JSON NOT NULL DEFAULT '[]',
      labels JSON NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, synced_at TEXT NOT NULL
    );
    INSERT INTO prs VALUES (
      'acme/widgets#1', 1, 'Legacy PR', 'widgets', 'acme', 'octocat',
      'https://example.test/1', 'feature', 0, '[]', '[]', '[]',
      '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT NOT NULL REFERENCES prs(id),
      name TEXT NOT NULL, path TEXT NOT NULL, bookmark TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'destroyed')),
      created_at TEXT NOT NULL, destroyed_at TEXT
    );
    INSERT INTO workspaces VALUES (
      'workspace-1', 'acme/widgets#1', 'legacy', '/tmp/legacy', 'feature',
      'active', '2025-01-01T00:00:00.000Z', NULL
    );
  `);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prs').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM workspaces').get().count, 0);
  assert.equal(readFileSync(`${path}.backup-v0-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('configuration defaults to loopback and authored polling cadence', () => {
  const config = parseConfig({ poll: { orgs: [], repos: [] } });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.poll.interval_seconds, 30);
});

test('configuration updates are validated before replacing the file', () => {
  const path = join(temporaryDirectory(), 'config.json');
  const original = {
    workspace_base_path: '~/portable-workspaces',
    poll: { interval_seconds: 30, orgs: ['acme'], repos: [] },
  };
  writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);

  const updated = updateConfig({ poll: { interval_seconds: 45 } }, path);
  assert.equal(updated.poll.interval_seconds, 45);
  assert.equal(updated.workspace_base_path.endsWith('/portable-workspaces'), true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).workspace_base_path, '~/portable-workspaces');

  const beforeInvalidUpdate = readFileSync(path, 'utf8');
  assert.throws(() => updateConfig({ poll: { interval_seconds: 1 } }, path), /Invalid config/);
  assert.equal(readFileSync(path, 'utf8'), beforeInvalidUpdate);
  assert.throws(() => updateConfig({ poll: null }, path), /Invalid config/);
  assert.equal(readFileSync(path, 'utf8'), beforeInvalidUpdate);
});
