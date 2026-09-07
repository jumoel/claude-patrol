import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { parseConfig, updateConfig } from './config.js';
import { closeDb, initDb } from './db.js';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { migrateReviewRequests } from './review-request-migration.js';
import { insertTestWorkItem } from './test-support/work-items.js';

const temporaryDirectories = [];
const schemaV17 = readFileSync(new URL('./test-support/schema-v17.sql', import.meta.url), 'utf8');

test('v18 upgrade preserves review rows and adds an independent unattempted event clock', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-patrol-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'v18.db');
  const old = createV17Database(path);
  migrateReviewRequests(old);
  old.exec(`PRAGMA user_version = 18;
    INSERT INTO prs (id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at)
      VALUES ('org/repo#1', 1, 'Preserved', 'repo', 'org', 'alice', 'url', 'branch', 'now', 'now', 'now');
    INSERT INTO review_watch_targets (id, kind, name, configured_values, generation, list_version, created_at)
      VALUES ('user:alice', 'user', 'alice', '["@me"]', 'generation', 'version', 'now');
    INSERT INTO pr_review_request_state (pr_id, target_id, match_state, state_version, last_attempt_at, acknowledged_revision)
      VALUES ('org/repo#1', 'user:alice', 'active', 'saved-version', 'saved-attempt', 'saved-ack');`);
  old.close();
  const db = initDb(path);
  const row = db.prepare('SELECT * FROM pr_review_request_state').get();
  assert.equal(row.state_version, 'saved-version');
  assert.equal(row.acknowledged_revision, 'saved-ack');
  assert.equal(row.last_attempt_at, 'saved-attempt');
  assert.equal(row.last_probe_attempt_at, null);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  const backup = new DatabaseSync(`${path}.backup-v18-to-v19`, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 18);
  backup.close();
});

function createV17Database(path) {
  const db = new DatabaseSync(path);
  db.exec(schemaV17);
  db.exec('INSERT INTO sync_state (id) VALUES (1)');
  return db;
}

// Older tests focus on work-item/session migrations. Supply the unrelated PR
// tables from the captured schema rather than pretending those tables were
// absent in a real Patrol database.
function completeLegacyPrFixture(db) {
  for (const table of ['prs', 'sync_state']) {
    if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table)) {
      const sql = schemaV17.match(new RegExp(`CREATE TABLE ${table} \\([\\s\\S]*?\\);`))?.[0];
      assert.ok(sql);
      db.exec(sql);
    }
  }
  db.exec('INSERT OR IGNORE INTO sync_state (id) VALUES (1)');
}

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
  assert.ok(sessionColumns.has('last_idle_at'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_jobs'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_item_references'").get());
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_item_repositories'").get(),
  );
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_item_pull_requests'").get(),
  );
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_orphans'").get());
  assert.ok(
    db
      .prepare("PRAGMA table_info('workspace_orphans')")
      .all()
      .some((column) => column.name === 'first_seen'),
  );
  assert.ok(
    db
      .prepare("PRAGMA table_info('prs')")
      .all()
      .some((column) => column.name === 'head_oid'),
  );
  const workItemColumns = new Set(
    db
      .prepare("PRAGMA table_info('work_items')")
      .all()
      .map((column) => column.name),
  );
  assert.ok(workItemColumns.has('creation_source'));
  assert.ok(workItemColumns.has('bookmark'));
  assert.equal(workItemColumns.has('reference'), false);
});

test('v17 migration preserves PRs, missing snapshots and historical local-work ownership', () => {
  const path = join(temporaryDirectory(), 'v17.db');
  const legacy = createV17Database(path);
  insertTestWorkItem(legacy, { id: 'live', repositories: ['org/repo'] });
  insertTestWorkItem(legacy, { id: 'old', state: 'destroyed', repositories: ['org/repo'] });
  const now = '2026-09-01T00:00:00Z';
  legacy
    .prepare(`INSERT INTO prs (id, number, title, body, org, repo, author, url, branch, head_oid,
    created_at, updated_at, synced_at) VALUES ('org/repo#1', 1, 'Title', '', 'org', 'repo', 'alice',
    'https://github.com/org/repo/pull/1', 'feature', ?, ?, ?, ?)`)
    .run('a'.repeat(40), now, now, now);
  legacy
    .prepare(`INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at)
    VALUES ('org/repo#1', 'live', 'explicit', ?), ('org/repo#2', 'old', 'explicit', ?)`)
    .run(now, now);
  legacy.close();
  const db = initDb(path);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM prs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item_pull_requests').get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_item_repositories').get().n, 2);
  const links = db
    .prepare('SELECT pr_id, ownership_state, local_repository FROM work_item_pull_requests ORDER BY pr_id')
    .all();
  assert.deepEqual(
    links.map((row) => ({ ...row })),
    [
      { pr_id: 'org/repo#1', ownership_state: 'active', local_repository: 'org/repo' },
      { pr_id: 'org/repo#2', ownership_state: 'historical', local_repository: 'org/repo' },
    ],
  );
  assert.equal(db.prepare('SELECT viewer_id FROM pr_authored_state').get().viewer_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM authored_prs').get().n, 0);
  const pr = db.prepare('SELECT * FROM prs').get();
  assert.ok(pr.snapshot_version);
  assert.ok(pr.review_revision, 'a known empty body still has a revision');
  assert.equal(pr.github_node_id, null);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  const backup = new DatabaseSync(`${path}.backup-v17-to-v19`, { readOnly: true });
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 17);
  assert.equal(backup.prepare('SELECT COUNT(*) AS n FROM work_item_pull_requests').get().n, 2);
  backup.close();
});

test('review watch configuration normalizes exact targets and rejects ambiguous input', () => {
  const parsed = parseConfig({
    poll: {
      orgs: ['org'],
      review_requests: {
        users: [' @ME ', 'Alice', 'alice'],
        teams: ['ORG/Reviewers', 'org/reviewers'],
      },
    },
  });
  assert.deepEqual(parsed.poll.review_requests, { users: ['@me', 'alice'], teams: ['org/reviewers'] });
  assert.deepEqual(parseConfig({ poll: { review_requests: { users: [], teams: [] } } }).poll.review_requests, {
    users: [],
    teams: [],
  });
  for (const review_requests of [
    { users: ['team:org/name'] },
    { users: ['alice\n'] },
    { teams: ['org'] },
    { teams: ['outside/reviewers'] },
    { users: Array.from({ length: 33 }, (_, n) => `user${n}`) },
  ])
    assert.throws(() => parseConfig({ poll: { orgs: ['org'], review_requests } }));
});

test('the v16 migration restores creation sources without misclassifying later pull request links', () => {
  const path = join(temporaryDirectory(), 'v16.db');
  let db = createV17Database(path);
  const createdAt = '2026-08-27T12:00:00.000Z';
  const linkedLaterAt = '2026-08-27T13:00:00.000Z';
  insertTestWorkItem(db, { id: 'reference-item', reference: 'ECO-3764', createdAt });
  insertTestWorkItem(db, { id: 'manual-item', reference: null, creationSource: 'manual', createdAt });
  insertTestWorkItem(db, { id: 'pull-request-item', reference: null, creationSource: 'pull_request', createdAt });
  db.prepare(
    `INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at)
     VALUES (?, ?, 'explicit', ?)`,
  ).run('acme/widgets#1', 'pull-request-item', createdAt);
  db.prepare(
    `INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at)
     VALUES (?, ?, 'explicit', ?)`,
  ).run('acme/widgets#2', 'manual-item', linkedLaterAt);
  db.exec('ALTER TABLE work_items DROP COLUMN creation_source; PRAGMA user_version = 16');
  db.close();

  db = initDb(path);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    db
      .prepare('SELECT id, creation_source FROM work_items ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'manual-item', creation_source: 'manual' },
      { id: 'pull-request-item', creation_source: 'pull_request' },
      { id: 'reference-item', creation_source: 'reference' },
    ],
  );
  assert.throws(
    () => db.prepare("UPDATE work_items SET creation_source = 'unknown' WHERE id = 'manual-item'").run(),
    /CHECK constraint failed/u,
  );
  assert.equal(readFileSync(`${path}.backup-v16-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('the v15 migration adds durable idle timestamps without replacing sessions', () => {
  const path = join(temporaryDirectory(), 'v15.db');
  let db = createV17Database(path);
  const now = '2026-08-27T12:00:00.000Z';
  insertTestWorkItem(db, { id: 'item-1', path: '/tmp/item-1', createdAt: now });
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, provider, status, started_at)
     VALUES ('session-1', 'item-1', 'codex', 'active', ?)`,
  ).run(now);
  db.exec('ALTER TABLE sessions DROP COLUMN last_idle_at; PRAGMA user_version = 15');
  db.close();

  db = initDb(path);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    { ...db.prepare('SELECT id, work_item_id, last_idle_at FROM sessions').get() },
    { id: 'session-1', work_item_id: 'item-1', last_idle_at: null },
  );
  assert.equal(readFileSync(`${path}.backup-v15-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('the v13 migration creates workspace orphan storage for existing databases', () => {
  const path = join(temporaryDirectory(), 'v13.db');
  let db = createV17Database(path);
  const now = '2026-08-27T12:00:00.000Z';
  insertTestWorkItem(db, { id: 'item-1', reference: 'ECO-2364', path: '/tmp/item-1', createdAt: now });
  db.exec('DROP TABLE workspace_orphans; PRAGMA user_version = 13');
  db.close();

  db = initDb(path);

  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_orphans'").get());
  assert.deepEqual(
    {
      ...db
        .prepare(
          `SELECT wi.id, wr.reference
             FROM work_items wi
             JOIN work_item_references wr ON wr.work_item_id = wi.id
            WHERE wi.id = ?`,
        )
        .get('item-1'),
    },
    {
      id: 'item-1',
      reference: 'ECO-2364',
    },
  );
  assert.equal(readFileSync(`${path}.backup-v13-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('the v12 migration preserves work items and adds provider-native reference fields', () => {
  const path = join(temporaryDirectory(), 'v12.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      reference TEXT NOT NULL,
      title TEXT,
      summary TEXT,
      resolved_repositories_json JSON,
      path TEXT NOT NULL UNIQUE,
      work_provider TEXT NOT NULL,
      resolver_provider TEXT NOT NULL,
      state TEXT NOT NULL,
      stage TEXT NOT NULL,
      progress_current INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_detail TEXT,
      error_provider TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      destroyed_at TEXT
    );
    INSERT INTO work_items (
      id, reference, resolved_repositories_json, path, work_provider, resolver_provider, state, stage,
      created_at, updated_at
    ) VALUES (
      'item-1', 'eco-3351', '["acme/widgets"]', '/tmp/item-1', 'codex', 'codex', 'ready', 'complete',
      '2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z'
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      work_item_id TEXT,
      name TEXT,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL
    );
    PRAGMA user_version = 12;
  `);
  completeLegacyPrFixture(legacy);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    {
      ...db
        .prepare(
          `SELECT wi.id, wi.creation_source, wr.reference, wr.reference_display, wr.reference_system, wr.reference_url
             FROM work_items wi
             JOIN work_item_references wr ON wr.work_item_id = wi.id`,
        )
        .get(),
    },
    {
      id: 'item-1',
      creation_source: 'reference',
      reference: 'eco-3351',
      reference_display: null,
      reference_system: null,
      reference_url: null,
    },
  );
  assert.deepEqual(
    { ...db.prepare('SELECT repo, position, membership_source, state FROM work_item_repositories').get() },
    { repo: 'acme/widgets', position: 0, membership_source: 'initial', state: 'ready' },
  );
});

test('the v7 to current migration preserves workspaces and sessions', () => {
  const path = join(temporaryDirectory(), 'v7.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
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
    INSERT INTO prs (
      id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at
    ) VALUES (
      'acme/widgets#1', 1, 'Preserved PR', 'widgets', 'acme', 'octocat',
      'https://example.test/1', 'feature', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT REFERENCES prs(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      repo TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      destroyed_at TEXT,
      operation_state TEXT NOT NULL DEFAULT 'ready',
      operation_step TEXT,
      operation_error TEXT,
      operation_updated_at TEXT
    );
    INSERT INTO workspaces (
      id, pr_id, name, path, bookmark, repo, created_at, operation_updated_at
    ) VALUES (
      'workspace-1', 'acme/widgets#1', 'acme-widgets-1', '/tmp/workspace-1',
      'feature', 'acme/widgets', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
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
    INSERT INTO sessions (id, workspace_id, status, started_at)
    VALUES ('session-1', 'workspace-1', 'active', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 7;
  `);
  completeLegacyPrFixture(legacy);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    { ...db.prepare('SELECT id, workspace_id, work_item_id, provider FROM sessions').get() },
    {
      id: 'session-1',
      workspace_id: 'workspace-1',
      work_item_id: null,
      provider: 'claude',
    },
  );
  assert.deepEqual(
    { ...db.prepare('SELECT id, pr_id, work_item_id, repo FROM workspaces').get() },
    { id: 'workspace-1', pr_id: 'acme/widgets#1', work_item_id: null, repo: 'acme/widgets' },
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
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
  assert.deepEqual(
    { ...db.prepare('SELECT path, repo, workspace_name, ownership_source FROM workspace_orphans').get() },
    {
      path: '/tmp/legacy',
      repo: 'acme/widgets',
      workspace_name: 'legacy',
      ownership_source: 'database',
    },
  );
  assert.equal(readFileSync(`${path}.backup-v0-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('the v10 migration preserves live global sessions and adds names', () => {
  const path = join(temporaryDirectory(), 'v10.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE work_items (id TEXT PRIMARY KEY);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      work_item_id TEXT REFERENCES work_items(id),
      pid INTEGER,
      provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex')),
      status TEXT NOT NULL CHECK(status IN ('active', 'detached', 'killed')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      claude_project_dir TEXT,
      transcript_path TEXT
    );
    INSERT INTO sessions (
      id, pid, provider, status, started_at, claude_project_dir, transcript_path
    ) VALUES
      ('global-claude', 101, 'claude', 'active', '2026-08-20T10:00:00.000Z', '/tmp/claude', '/tmp/claude.jsonl'),
      ('global-codex', 202, 'codex', 'detached', '2026-08-20T11:00:00.000Z', NULL, NULL);
    PRAGMA user_version = 10;
  `);
  completeLegacyPrFixture(legacy);
  legacy.close();

  const db = initDb(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, CURRENT_SCHEMA_VERSION);
  assert.deepEqual(
    db
      .prepare(
        `SELECT id, name, pid, provider, status, started_at, claude_project_dir, transcript_path
           FROM sessions ORDER BY id`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: 'global-claude',
        name: 'Claude',
        pid: 101,
        provider: 'claude',
        status: 'active',
        started_at: '2026-08-20T10:00:00.000Z',
        claude_project_dir: '/tmp/claude',
        transcript_path: '/tmp/claude.jsonl',
      },
      {
        id: 'global-codex',
        name: 'Codex',
        pid: 202,
        provider: 'codex',
        status: 'detached',
        started_at: '2026-08-20T11:00:00.000Z',
        claude_project_dir: null,
        transcript_path: null,
      },
    ],
  );
  assert.equal(readFileSync(`${path}.backup-v10-to-v${CURRENT_SCHEMA_VERSION}`).length > 0, true);
});

test('configuration defaults to loopback and authored polling cadence', () => {
  const config = parseConfig({ poll: { orgs: [], repos: [] } });
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.poll.interval_seconds, 30);
  assert.deepEqual(config.workspace_reconciliation, {
    hourly_policy: 'report_only',
    retention_hours: 168,
  });
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

  const reconciliation = updateConfig({ workspace_reconciliation: { retention_hours: 24 } }, path);
  assert.deepEqual(reconciliation.workspace_reconciliation, {
    hourly_policy: 'report_only',
    retention_hours: 24,
  });
  const deletionPolicy = updateConfig({ workspace_reconciliation: { hourly_policy: 'delete_after_retention' } }, path);
  assert.deepEqual(deletionPolicy.workspace_reconciliation, {
    hourly_policy: 'delete_after_retention',
    retention_hours: 24,
  });

  const beforeInvalidUpdate = readFileSync(path, 'utf8');
  assert.throws(() => updateConfig({ poll: { interval_seconds: 1 } }, path), /Invalid config/);
  assert.equal(readFileSync(path, 'utf8'), beforeInvalidUpdate);
  assert.throws(() => updateConfig({ poll: null }, path), /Invalid config/);
  assert.equal(readFileSync(path, 'utf8'), beforeInvalidUpdate);
});

test('the current schema enforces work-item progress and exclusive workspace and session targets', () => {
  const db = initDb(':memory:');
  const now = new Date().toISOString();
  insertTestWorkItem(db, { id: 'item-1', repositories: ['acme/widgets'], createdAt: now });
  db.prepare(
    `INSERT INTO workspaces (
      id, work_item_id, name, path, bookmark, repo, status, created_at,
      operation_state, operation_updated_at
    ) VALUES ('child-1', 'item-1', 'child-1', '/tmp/child-1', 'patrol/work-item-1',
      'acme/widgets', 'active', ?, 'ready', ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO prs (
      id, number, title, repo, org, author, url, branch, created_at, updated_at, synced_at
    ) VALUES ('acme/widgets#1', 1, 'PR', 'widgets', 'acme', 'octocat',
      'https://example.test/1', 'feature', ?, ?, ?)`,
  ).run(now, now, now);
  assert.throws(() => db.prepare("UPDATE workspaces SET pr_id = 'acme/widgets#1' WHERE id = 'child-1'").run());

  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, work_item_id, provider, status, started_at)
       VALUES ('invalid-target', 'child-1', 'item-1', 'claude', 'active', ?)`,
      )
      .run(now),
  );
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, provider, status, started_at)
     VALUES ('session-1', 'item-1', 'claude', 'active', ?)`,
  ).run(now);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO sessions (id, work_item_id, provider, status, started_at)
       VALUES ('session-2', 'item-1', 'claude', 'detached', ?)`,
      )
      .run(now),
  );
  db.prepare("UPDATE sessions SET status = 'killed' WHERE id = 'session-1'").run();
  db.prepare(
    `INSERT INTO sessions (id, work_item_id, provider, status, started_at)
     VALUES ('session-2', 'item-1', 'claude', 'active', ?)`,
  ).run(now);
  assert.throws(() =>
    db.prepare('UPDATE work_items SET progress_current = 2, progress_total = 1 WHERE id = ?').run('item-1'),
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('the current schema allows one active child per work-item repository', () => {
  const db = initDb(':memory:');
  const now = new Date().toISOString();
  insertTestWorkItem(db, {
    id: 'item-1',
    repositories: ['acme/widgets'],
    state: 'preparing',
    stage: 'child_creation',
    progressTotal: 1,
    createdAt: now,
  });
  const insert = db.prepare(
    `INSERT INTO workspaces (
      id, work_item_id, name, path, bookmark, repo, status, created_at,
      operation_state, operation_updated_at
    ) VALUES (?, 'item-1', ?, ?, 'patrol/work-item-1', 'acme/widgets', ?, ?, 'ready', ?)`,
  );
  insert.run('child-1', 'child-1', '/tmp/child-1', 'active', now, now);
  assert.throws(() => insert.run('child-2', 'child-2', '/tmp/child-2', 'active', now, now));
  insert.run('child-2', 'child-2', '/tmp/child-2', 'destroyed', now, now);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
