-- Schema captured from eaf93ad393a3 for data-preserving migration tests.
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
CREATE TABLE work_item_pull_requests (
      pr_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      source TEXT NOT NULL CHECK(source IN ('explicit', 'provenance')),
      linked_at TEXT NOT NULL
    );
CREATE INDEX idx_work_item_pull_requests_work_item
      ON work_item_pull_requests(work_item_id, linked_at DESC);
CREATE TABLE workspace_orphans (
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
CREATE INDEX idx_workspace_orphans_operation_state
      ON workspace_orphans(operation_state, operation_updated_at);
PRAGMA user_version = 17;
