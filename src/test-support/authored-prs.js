/** Explicit source membership for fixtures; inserting a shared PR is not authorship. */
export function markTestPrAuthored(db, id, viewer = { id: 'test-viewer', login: 'octocat' }) {
  db.prepare('UPDATE sync_state SET viewer_id = ?, viewer_login = ?, viewer_verified = 1 WHERE id = 1').run(
    viewer.id,
    viewer.login,
  );
  const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(id);
  db.prepare(`UPDATE prs SET details_synced_at = synced_at, body_synced_at = synced_at,
    body_source_updated_at = updated_at, detail_source_updated_at = updated_at WHERE id = ?`).run(id);
  db.prepare(`INSERT INTO pr_authored_state (pr_id, viewer_id, last_seen_at, baseline_json)
    VALUES (?, ?, ?, ?) ON CONFLICT(pr_id) DO UPDATE SET viewer_id=excluded.viewer_id`).run(
    id,
    viewer.id,
    row.synced_at,
    JSON.stringify({ checks: row.checks, mergeable: row.mergeable, draft: row.draft, labels: row.labels }),
  );
}
