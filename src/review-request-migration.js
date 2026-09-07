import { randomUUID } from 'node:crypto';
import { reviewRevision } from './review-revision.js';

/** Runs inside the database initializer's migration transaction. */
export function migrateReviewRequests(db) {
  db.exec(`
    ALTER TABLE prs ADD COLUMN github_node_id TEXT;
    ALTER TABLE prs ADD COLUMN github_state TEXT CHECK(github_state IN ('OPEN', 'CLOSED', 'MERGED'));
    ALTER TABLE prs ADD COLUMN summary_synced_at TEXT;
    ALTER TABLE prs ADD COLUMN body_synced_at TEXT;
    ALTER TABLE prs ADD COLUMN body_source_updated_at TEXT;
    ALTER TABLE prs ADD COLUMN details_synced_at TEXT;
    ALTER TABLE prs ADD COLUMN detail_source_updated_at TEXT;
    ALTER TABLE prs ADD COLUMN snapshot_version TEXT NOT NULL DEFAULT '';
    ALTER TABLE prs ADD COLUMN body_head_oid TEXT;
    ALTER TABLE prs ADD COLUMN body_title TEXT;
    ALTER TABLE prs ADD COLUMN review_revision TEXT;
    CREATE UNIQUE INDEX idx_prs_github_node ON prs(github_node_id) WHERE github_node_id IS NOT NULL;

    ALTER TABLE sync_state ADD COLUMN viewer_id TEXT;
    ALTER TABLE sync_state ADD COLUMN viewer_login TEXT;
    ALTER TABLE sync_state ADD COLUMN authored_scope_key TEXT;
    ALTER TABLE sync_state ADD COLUMN viewer_verified INTEGER NOT NULL DEFAULT 0 CHECK(viewer_verified IN (0, 1));

    CREATE TABLE pr_authored_state (
      pr_id TEXT PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE,
      viewer_id TEXT,
      last_seen_at TEXT,
      complete_cycle_at TEXT,
      missing_since TEXT,
      last_state_check_at TEXT,
      baseline_json TEXT
    );
    CREATE INDEX idx_pr_authored_viewer ON pr_authored_state(viewer_id, pr_id);
    CREATE INDEX idx_pr_authored_missing ON pr_authored_state(missing_since, last_state_check_at, pr_id);
    CREATE VIEW authored_prs AS
      SELECT p.* FROM prs p
      JOIN pr_authored_state a ON a.pr_id = p.id
      JOIN sync_state s ON s.id = 1 AND s.viewer_verified = 1 AND s.viewer_id = a.viewer_id
      WHERE p.github_state IS NULL OR p.github_state = 'OPEN';

    CREATE TABLE review_watch_targets (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('user', 'team')),
      name TEXT NOT NULL,
      configured_values TEXT NOT NULL,
      viewer_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      generation TEXT NOT NULL,
      list_version TEXT NOT NULL,
      synced_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE review_watch_scopes (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES review_watch_targets(id) ON DELETE CASCADE,
      query_hash TEXT NOT NULL,
      query TEXT NOT NULL,
      cursor TEXT,
      issue_count INTEGER,
      first_attempt_at TEXT,
      first_synced_at TEXT,
      overflow_attempt_at TEXT,
      overflow_synced_at TEXT,
      incomplete INTEGER NOT NULL DEFAULT 1 CHECK(incomplete IN (0, 1)),
      limited INTEGER NOT NULL DEFAULT 0 CHECK(limited IN (0, 1)),
      error TEXT,
      UNIQUE(target_id, query_hash)
    );
    CREATE INDEX idx_review_scopes_first ON review_watch_scopes(first_attempt_at, id);
    CREATE INDEX idx_review_scopes_overflow ON review_watch_scopes(overflow_attempt_at, id) WHERE cursor IS NOT NULL;
    CREATE TABLE pr_review_request_state (
      pr_id TEXT NOT NULL REFERENCES prs(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES review_watch_targets(id) ON DELETE CASCADE,
      match_state TEXT NOT NULL CHECK(match_state IN ('candidate', 'active', 'inactive')),
      proof_viewer_id TEXT,
      event_id TEXT,
      event_at TEXT,
      event_source_updated_at TEXT,
      last_seen_at TEXT,
      last_verified_at TEXT,
      last_attempt_at TEXT,
      verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending', 'verified', 'error')),
      verification_error TEXT,
      acknowledged_event_id TEXT,
      acknowledged_revision TEXT,
      acknowledged_head_oid TEXT,
      acknowledged_title TEXT,
      acknowledgement_invalidated INTEGER NOT NULL DEFAULT 0 CHECK(acknowledgement_invalidated IN (0, 1)),
      state_version TEXT NOT NULL,
      PRIMARY KEY(pr_id, target_id)
    );
    CREATE INDEX idx_review_target_matches ON pr_review_request_state(target_id, match_state, pr_id);
    CREATE INDEX idx_review_attempts ON pr_review_request_state(match_state, last_attempt_at, pr_id, target_id);
    CREATE TABLE pr_review_probe_state (
      pr_id TEXT PRIMARY KEY REFERENCES prs(id) ON DELETE CASCADE,
      state_version TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      head_oid TEXT,
      title TEXT,
      review_revision TEXT,
      target_plan_hash TEXT NOT NULL,
      cursor TEXT,
      progress_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'error')),
      error TEXT,
      last_attempt_at TEXT
    );
    CREATE INDEX idx_review_probes_pending ON pr_review_probe_state(status, last_attempt_at, pr_id);
    ALTER TABLE work_item_repositories ADD COLUMN source_pr_number INTEGER CHECK(source_pr_number > 0);
  `);

  const updatePr = db.prepare(`
    UPDATE prs SET snapshot_version = ?, summary_synced_at = synced_at,
      body_synced_at = synced_at, body_source_updated_at = updated_at,
      details_synced_at = synced_at, detail_source_updated_at = updated_at,
      body_head_oid = head_oid, body_title = title, review_revision = ? WHERE id = ?
  `);
  const seedAuthored = db.prepare(`
    INSERT INTO pr_authored_state (pr_id, last_seen_at, baseline_json) VALUES (?, ?, ?)
  `);
  for (const row of db.prepare('SELECT * FROM prs').all()) {
    updatePr.run(randomUUID(), reviewRevision(row.head_oid, row.title, row.body), row.id);
    seedAuthored.run(
      row.id,
      row.synced_at,
      JSON.stringify({
        checks: row.checks,
        mergeable: row.mergeable,
        draft: row.draft,
        labels: row.labels,
      }),
    );
  }

  const links = db
    .prepare(`SELECT l.*, wi.state AS item_state FROM work_item_pull_requests l
    JOIN work_items wi ON wi.id = l.work_item_id`)
    .all();
  const oldCount = db.prepare('SELECT COUNT(*) AS n FROM work_item_pull_requests').get().n;
  db.exec(`
    DROP TABLE work_item_pull_requests;
    CREATE TABLE work_item_pull_requests (
      pr_id TEXT NOT NULL,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      source TEXT NOT NULL CHECK(source IN ('explicit', 'provenance')),
      linked_at TEXT NOT NULL,
      local_repository TEXT,
      ownership_state TEXT NOT NULL DEFAULT 'active' CHECK(ownership_state IN ('active', 'historical')),
      ended_at TEXT,
      end_reason TEXT,
      PRIMARY KEY(pr_id, work_item_id)
    );
    CREATE UNIQUE INDEX idx_work_item_pr_active ON work_item_pull_requests(pr_id) WHERE ownership_state = 'active';
    CREATE INDEX idx_work_item_pull_requests_work_item ON work_item_pull_requests(work_item_id, linked_at DESC);
  `);
  const insertLink = db.prepare(`INSERT INTO work_item_pull_requests
    (pr_id, work_item_id, source, linked_at, local_repository, ownership_state, end_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const link of links) {
    const historical = link.item_state === 'destroyed';
    const repository = link.pr_id.slice(0, link.pr_id.lastIndexOf('#'));
    insertLink.run(
      link.pr_id,
      link.work_item_id,
      link.source,
      link.linked_at,
      repository,
      historical ? 'historical' : 'active',
      historical ? 'work_item_destroyed' : null,
    );
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM work_item_pull_requests').get().n !== oldCount) {
    throw new Error('Review migration did not preserve every work-item PR link');
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Review migration foreign key violation');
}
