/** Schema v7 intentionally resets every pre-v7 database. */

export const CURRENT_SCHEMA_VERSION = 16;

function createWorkspaceOrphansTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_orphans (
      path TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      ownership_source TEXT NOT NULL CHECK(ownership_source IN ('marker', 'database')),
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      operation_state TEXT NOT NULL CHECK(operation_state IN ('detected', 'destroying', 'error')),
      operation_step TEXT NOT NULL,
      operation_error TEXT,
      operation_updated_at TEXT NOT NULL,
      commit_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_orphans_operation_state
      ON workspace_orphans(operation_state, operation_updated_at);
  `);
}

function captureResetWorkspaceOwnership(db) {
  const hasWorkspaces = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'").get();
  if (!hasWorkspaces) return [];
  const workspaceColumns = new Set(
    db
      .prepare("PRAGMA table_info('workspaces')")
      .all()
      .map((column) => column.name),
  );
  if (![...['id', 'name', 'path']].every((column) => workspaceColumns.has(column))) return [];

  const hasPrs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prs'").get();
  const canJoinPrs = hasPrs && workspaceColumns.has('pr_id');
  const repoExpression = workspaceColumns.has('repo') ? 'w.repo' : 'NULL';
  const join = canJoinPrs ? 'LEFT JOIN prs p ON p.id = w.pr_id' : '';
  const prOwner = canJoinPrs ? 'p.org' : 'NULL';
  const prRepo = canJoinPrs ? 'p.repo' : 'NULL';
  try {
    return db
      .prepare(
        `SELECT w.id, w.name, w.path, ${repoExpression} AS workspace_repo,
                ${prOwner} AS pr_owner, ${prRepo} AS pr_repo
           FROM workspaces w ${join}`,
      )
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        path: row.path,
        repo: row.workspace_repo ?? (row.pr_owner && row.pr_repo ? `${row.pr_owner}/${row.pr_repo}` : null),
      }))
      .filter((row) => typeof row.repo === 'string' && row.repo.split('/').length === 2);
  } catch {
    return [];
  }
}

function restoreResetWorkspaceOwnership(db, workspaces) {
  if (workspaces.length === 0) return;
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO workspace_orphans (
      path, repo, workspace_name, ownership_source, first_seen, last_seen,
      operation_state, operation_step, operation_updated_at
    ) VALUES (?, ?, ?, 'database', ?, ?, 'detected', 'destroy:detected', ?)
  `);
  for (const workspace of workspaces) {
    insert.run(workspace.path, workspace.repo, workspace.name, now, now, now);
  }
}
function createWorkItemTables(db) {
  db.exec(`
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      title TEXT,
      summary TEXT,
      creation_source TEXT NOT NULL CHECK(creation_source IN ('manual', 'reference', 'pull_request')),
      path TEXT NOT NULL UNIQUE,
      bookmark TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('resolving', 'preparing', 'ready', 'error', 'destroying', 'destroyed')),
      stage TEXT NOT NULL CHECK(stage IN (
        'provider_check', 'reference_resolution', 'root_generation', 'child_creation',
        'child_compensation', 'session_launch', 'session_stop', 'transcript_archive',
        'child_destruction', 'root_destruction', 'complete'
      )),
      progress_current INTEGER NOT NULL DEFAULT 0 CHECK(progress_current >= 0),
      progress_total INTEGER NOT NULL DEFAULT 0 CHECK(progress_total >= 0 AND progress_current <= progress_total),
      error_code TEXT,
      error_detail TEXT,
      error_provider TEXT CHECK(error_provider IN ('claude', 'codex')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      destroyed_at TEXT
    );

    CREATE INDEX idx_work_items_state ON work_items(state);

    CREATE TABLE work_item_references (
      work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
      reference TEXT NOT NULL,
      reference_display TEXT,
      reference_system TEXT,
      reference_url TEXT,
      resolver_provider TEXT NOT NULL CHECK(resolver_provider IN ('claude', 'codex'))
    );

    CREATE TABLE work_item_repositories (
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      repo TEXT NOT NULL,
      start_revision TEXT,
      position INTEGER NOT NULL CHECK(position >= 0),
      membership_source TEXT NOT NULL CHECK(membership_source IN ('initial', 'addition')),
      state TEXT NOT NULL CHECK(state IN ('adding', 'ready', 'error')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (work_item_id, repo)
    );

    CREATE INDEX idx_work_item_repositories_state
      ON work_item_repositories(work_item_id, state, position);
  `);
}

function createWorkspaceTablesV9(db) {
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      pr_id TEXT REFERENCES prs(id),
      work_item_id TEXT REFERENCES work_items(id),
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
      operation_updated_at TEXT,
      start_revision TEXT,
      base_commit TEXT,
      setup_warnings_json JSON,
      CHECK(NOT (pr_id IS NOT NULL AND work_item_id IS NOT NULL))
    );

    CREATE INDEX idx_workspaces_pr ON workspaces(pr_id);
    CREATE INDEX idx_workspaces_work_item ON workspaces(work_item_id);
    CREATE INDEX idx_workspaces_operation_state ON workspaces(operation_state);
    CREATE UNIQUE INDEX idx_workspaces_active_pr
      ON workspaces(pr_id) WHERE status = 'active';
    CREATE UNIQUE INDEX idx_workspaces_active_work_item_repo
      ON workspaces(work_item_id, repo)
      WHERE work_item_id IS NOT NULL AND status = 'active';

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      work_item_id TEXT REFERENCES work_items(id),
      name TEXT,
      pid INTEGER,
      provider TEXT NOT NULL DEFAULT 'claude' CHECK(provider IN ('claude', 'codex')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'detached', 'killed')),
      started_at TEXT NOT NULL,
      ended_at TEXT,
      last_idle_at TEXT,
      claude_project_dir TEXT,
      transcript_path TEXT,
      CHECK(NOT (workspace_id IS NOT NULL AND work_item_id IS NOT NULL))
    );

    CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
    CREATE INDEX idx_sessions_work_item ON sessions(work_item_id);
    CREATE UNIQUE INDEX idx_sessions_live_work_item
      ON sessions(work_item_id)
      WHERE work_item_id IS NOT NULL AND status IN ('active', 'detached');

    CREATE TABLE workspace_claims (
      repo TEXT NOT NULL,
      bookmark TEXT NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
      operation TEXT NOT NULL CHECK(operation IN ('create', 'destroy')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (repo, bookmark)
    );
  `);
}

function addSessionNames(db) {
  const hasName = db
    .prepare("PRAGMA table_info('sessions')")
    .all()
    .some((column) => column.name === 'name');
  if (!hasName) db.exec('ALTER TABLE sessions ADD COLUMN name TEXT');

  db.exec(`
    UPDATE sessions
       SET name = CASE provider WHEN 'codex' THEN 'Codex' ELSE 'Claude' END
     WHERE workspace_id IS NULL
       AND work_item_id IS NULL
       AND (name IS NULL OR trim(name) = '')
  `);
}

function addSessionLastIdleAt(db) {
  const hasLastIdleAt = db
    .prepare("PRAGMA table_info('sessions')")
    .all()
    .some((column) => column.name === 'last_idle_at');
  if (!hasLastIdleAt) db.exec('ALTER TABLE sessions ADD COLUMN last_idle_at TEXT');
}

function createWorkItemRepositoryAdditionTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_repository_additions (
      work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
      repository TEXT NOT NULL,
      start_revision TEXT NOT NULL,
      workspace_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
}

function createWorkItemPullRequestTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_item_pull_requests (
      pr_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      source TEXT NOT NULL CHECK(source IN ('explicit', 'provenance')),
      linked_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_item_pull_requests_work_item
      ON work_item_pull_requests(work_item_id, linked_at DESC);
  `);
}

function addPrHeadOid(db) {
  const hasPrs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'prs'").get();
  if (!hasPrs) return;
  const hasHeadOid = db
    .prepare("PRAGMA table_info('prs')")
    .all()
    .some((column) => column.name === 'head_oid');
  if (!hasHeadOid) db.exec('ALTER TABLE prs ADD COLUMN head_oid TEXT');
}

function addWorkItemReferenceMetadata(db) {
  const hasWorkItems = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'work_items'").get();
  if (!hasWorkItems) return;
  const columns = new Set(
    db
      .prepare("PRAGMA table_info('work_items')")
      .all()
      .map((column) => column.name),
  );
  if (!columns.has('reference')) return;
  if (!columns.has('reference_display')) db.exec('ALTER TABLE work_items ADD COLUMN reference_display TEXT');
  if (!columns.has('reference_system')) db.exec('ALTER TABLE work_items ADD COLUMN reference_system TEXT');
  if (!columns.has('reference_url')) db.exec('ALTER TABLE work_items ADD COLUMN reference_url TEXT');
}

function resetSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS automation_jobs;
    DROP TABLE IF EXISTS rule_subscriptions;
    DROP TABLE IF EXISTS rule_runs;
    DROP TABLE IF EXISTS work_item_pull_requests;
    DROP TABLE IF EXISTS work_item_repository_additions;
    DROP TABLE IF EXISTS work_item_repositories;
    DROP TABLE IF EXISTS work_item_references;
    DROP TABLE IF EXISTS workspace_orphans;
    DROP TABLE IF EXISTS workspace_claims;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS workspaces;
    DROP TABLE IF EXISTS work_items;
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
      head_oid TEXT,
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
  createWorkItemTables(db);
  createWorkspaceTablesV9(db);
  createWorkItemPullRequestTable(db);
  createWorkspaceOrphansTable(db);
}

function v8InvalidReferences(db) {
  const invalidWorkspacePrs = db
    .prepare(
      `SELECT w.id FROM workspaces w
       LEFT JOIN prs p ON p.id = w.pr_id
       WHERE w.pr_id IS NOT NULL AND p.id IS NULL
       ORDER BY w.id`,
    )
    .all()
    .map((row) => row.id);
  const invalidSessionWorkspaces = db
    .prepare(
      `SELECT s.id FROM sessions s
       LEFT JOIN workspaces w ON w.id = s.workspace_id
       WHERE s.workspace_id IS NOT NULL AND w.id IS NULL
       ORDER BY s.id`,
    )
    .all()
    .map((row) => row.id);
  return { invalidWorkspacePrs, invalidSessionWorkspaces };
}

function migrateV8ToV9(db) {
  const invalid = v8InvalidReferences(db);
  if (invalid.invalidWorkspacePrs.length || invalid.invalidSessionWorkspaces.length) {
    throw new Error(
      `Cannot migrate v8 database: invalid workspace PR rows [${invalid.invalidWorkspacePrs.join(', ')}]; ` +
        `invalid session workspace rows [${invalid.invalidSessionWorkspaces.join(', ')}]`,
    );
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_workspaces_pr;
    DROP INDEX IF EXISTS idx_workspaces_operation_state;
    DROP INDEX IF EXISTS idx_workspaces_active_pr;
    DROP INDEX IF EXISTS idx_sessions_workspace;
    ALTER TABLE sessions RENAME TO sessions_v8;
    ALTER TABLE workspaces RENAME TO workspaces_v8;
  `);

  createWorkItemTables(db);
  createWorkspaceTablesV9(db);

  db.exec(`
    INSERT INTO workspaces (
      id, pr_id, work_item_id, name, path, bookmark, repo, status, created_at,
      destroyed_at, operation_state, operation_step, operation_error,
      operation_updated_at, start_revision, base_commit, setup_warnings_json
    )
    SELECT
      id, pr_id, NULL, name, path, bookmark, repo, status, created_at,
      destroyed_at, operation_state, operation_step, operation_error,
      operation_updated_at, NULL, NULL, NULL
    FROM workspaces_v8;

    INSERT INTO sessions (
      id, workspace_id, work_item_id, pid, provider, status, started_at, ended_at,
      claude_project_dir, transcript_path
    )
    SELECT
      id, workspace_id, NULL, pid, provider, status, started_at, ended_at,
      claude_project_dir, transcript_path
    FROM sessions_v8;

    DROP TABLE sessions_v8;
    DROP TABLE workspaces_v8;
  `);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parsedRepositories(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((repo) => typeof repo === 'string') : [];
  } catch {
    return [];
  }
}

function migratedRepositoryState(item, workspace, pending) {
  if (pending) return item.state === 'error' ? 'error' : 'adding';
  if (workspace?.operation_state === 'error') return 'error';
  if (['resolving', 'preparing'].includes(item.state)) return 'adding';
  if (item.state === 'error' && ['root_generation', 'child_creation', 'child_compensation'].includes(item.stage)) {
    return 'error';
  }
  return 'ready';
}

function migrateWorkItemsToV15(db) {
  if (!tableExists(db, 'work_items')) return;
  const columns = new Set(
    db
      .prepare("PRAGMA table_info('work_items')")
      .all()
      .map((column) => column.name),
  );
  if (columns.has('bookmark')) return;

  const items = db.prepare('SELECT * FROM work_items').all();
  const workspaces = tableExists(db, 'workspaces') ? db.prepare('SELECT rowid, * FROM workspaces').all() : [];
  const sessions = tableExists(db, 'sessions') ? db.prepare('SELECT * FROM sessions').all() : [];
  const claims = tableExists(db, 'workspace_claims') ? db.prepare('SELECT * FROM workspace_claims').all() : [];
  const pullRequests = tableExists(db, 'work_item_pull_requests')
    ? db.prepare('SELECT * FROM work_item_pull_requests ORDER BY linked_at, pr_id').all()
    : [];
  const pendingAdditions = tableExists(db, 'work_item_repository_additions')
    ? db.prepare('SELECT * FROM work_item_repository_additions ORDER BY created_at, work_item_id').all()
    : [];

  if (tableExists(db, 'workspace_claims')) db.exec('DROP TABLE workspace_claims');
  if (tableExists(db, 'sessions')) db.exec('DROP TABLE sessions');
  if (tableExists(db, 'workspaces')) db.exec('DROP TABLE workspaces');
  db.exec('DROP TABLE IF EXISTS work_item_pull_requests');
  db.exec('DROP TABLE IF EXISTS work_item_repository_additions');
  db.exec('DROP TABLE work_items');

  createWorkItemTables(db);
  createWorkspaceTablesV9(db);
  createWorkItemPullRequestTable(db);

  const insertItem = db.prepare(`
    INSERT INTO work_items (
      id, title, summary, creation_source, path, bookmark, state, stage, progress_current, progress_total,
      error_code, error_detail, error_provider, created_at, updated_at, destroyed_at
    ) VALUES (?, ?, ?, 'reference', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertReference = db.prepare(`
    INSERT INTO work_item_references (
      work_item_id, reference, reference_display, reference_system, reference_url, resolver_provider
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertRepository = db.prepare(`
    INSERT INTO work_item_repositories (
      work_item_id, repo, start_revision, position, membership_source, state, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const childrenByItem = new Map();
  for (const workspace of workspaces) {
    if (!workspace.work_item_id) continue;
    const key = `${workspace.work_item_id}\0${workspace.repo}`;
    const previous = childrenByItem.get(key);
    if (!previous || `${workspace.created_at}\0${workspace.rowid}` > `${previous.created_at}\0${previous.rowid}`) {
      childrenByItem.set(key, workspace);
    }
  }
  const pendingByItem = new Map(
    pendingAdditions.map((addition) => [`${addition.work_item_id}\0${addition.repository}`, addition]),
  );

  for (const item of items) {
    const existingChild = workspaces.find((workspace) => workspace.work_item_id === item.id);
    const bookmark = existingChild?.bookmark ?? `patrol/work-item-${item.id.replaceAll('-', '').slice(0, 12)}`;
    insertItem.run(
      item.id,
      item.title,
      item.summary,
      item.path,
      bookmark,
      item.state,
      item.stage,
      item.progress_current,
      item.progress_total,
      item.error_code,
      item.error_detail,
      item.error_provider,
      item.created_at,
      item.updated_at,
      item.destroyed_at,
    );
    insertReference.run(
      item.id,
      item.reference,
      item.reference_display,
      item.reference_system,
      item.reference_url,
      item.resolver_provider,
    );

    const repositories = parsedRepositories(item.resolved_repositories_json);
    for (const workspace of workspaces) {
      if (workspace.work_item_id === item.id && workspace.repo && !repositories.includes(workspace.repo)) {
        repositories.push(workspace.repo);
      }
    }
    for (const addition of pendingAdditions) {
      if (addition.work_item_id === item.id && !repositories.includes(addition.repository)) {
        repositories.push(addition.repository);
      }
    }
    repositories.slice(0, 32).forEach((repo, position) => {
      const key = `${item.id}\0${repo}`;
      const workspace = childrenByItem.get(key) ?? null;
      const pending = pendingByItem.get(key) ?? null;
      insertRepository.run(
        item.id,
        repo,
        pending?.start_revision ?? workspace?.start_revision ?? null,
        position,
        pending ? 'addition' : 'initial',
        migratedRepositoryState(item, workspace, pending),
        pending?.created_at ?? workspace?.created_at ?? item.created_at,
        item.updated_at,
      );
    });
  }

  if (workspaces.length > 0) {
    const insertWorkspace = db.prepare(`
      INSERT INTO workspaces (
        id, pr_id, work_item_id, name, path, bookmark, repo, status, created_at, destroyed_at,
        operation_state, operation_step, operation_error, operation_updated_at, start_revision,
        base_commit, setup_warnings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const workspace of workspaces) {
      insertWorkspace.run(
        workspace.id,
        workspace.pr_id,
        workspace.work_item_id,
        workspace.name,
        workspace.path,
        workspace.bookmark,
        workspace.repo,
        workspace.status,
        workspace.created_at,
        workspace.destroyed_at,
        workspace.operation_state,
        workspace.operation_step,
        workspace.operation_error,
        workspace.operation_updated_at,
        workspace.start_revision,
        workspace.base_commit,
        workspace.setup_warnings_json,
      );
    }
  }

  const insertSession = db.prepare(`
    INSERT INTO sessions (
      id, workspace_id, work_item_id, name, pid, provider, status, started_at, ended_at,
      claude_project_dir, transcript_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const session of sessions) {
    insertSession.run(
      session.id,
      session.workspace_id,
      session.work_item_id,
      session.name ?? null,
      session.pid,
      session.provider,
      session.status,
      session.started_at,
      session.ended_at,
      session.claude_project_dir,
      session.transcript_path,
    );
  }

  const insertClaim = db.prepare(`
    INSERT INTO workspace_claims (repo, bookmark, workspace_id, operation, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const claim of claims) {
    insertClaim.run(claim.repo, claim.bookmark, claim.workspace_id, claim.operation, claim.created_at);
  }

  const insertPullRequest = db.prepare(`
    INSERT INTO work_item_pull_requests (pr_id, work_item_id, source, linked_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const pullRequest of pullRequests) {
    insertPullRequest.run(pullRequest.pr_id, pullRequest.work_item_id, pullRequest.source, pullRequest.linked_at);
  }
}

/**
 * Upgrade a database to the current schema. Databases older than v7 still
 * take the intentional clean reset. Later migrations preserve authored rows.
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
    db.exec('PRAGMA defer_foreign_keys = ON');
    const resetWorkspaceOwnership = version < 7 ? captureResetWorkspaceOwnership(db) : [];
    if (version < 7) {
      resetSchema(db);
    } else if (version === 7) {
      db.exec(
        "ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude' CHECK(provider IN ('claude', 'codex'))",
      );
      migrateV8ToV9(db);
    } else if (version === 8) {
      migrateV8ToV9(db);
    }
    if (version >= 9) {
      addWorkItemReferenceMetadata(db);
      const legacyWorkItems = new Set(
        db
          .prepare("PRAGMA table_info('work_items')")
          .all()
          .map((column) => column.name),
      ).has('reference');
      if (legacyWorkItems) createWorkItemRepositoryAdditionTable(db);
      createWorkItemPullRequestTable(db);
      migrateWorkItemsToV15(db);
    }
    addSessionNames(db);
    addSessionLastIdleAt(db);
    addPrHeadOid(db);
    createWorkItemPullRequestTable(db);
    createWorkspaceOrphansTable(db);
    restoreResetWorkspaceOwnership(db, resetWorkspaceOwnership);
    db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
    db.exec('COMMIT');
    const kind = version < 7 ? 'Destructive schema reset' : 'Schema migration';
    console.log(`[db] ${kind} to version ${CURRENT_SCHEMA_VERSION} complete`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
