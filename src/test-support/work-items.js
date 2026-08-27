/**
 * Insert a v15 work item for backend tests that need persisted lifecycle state.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   id: string,
 *   reference?: string | null,
 *   title?: string | null,
 *   summary?: string | null,
 *   repositories?: string[],
 *   path?: string,
 *   bookmark?: string,
 *   creationSource?: 'manual'|'reference'|'pull_request',
 *   resolverProvider?: 'claude'|'codex',
 *   state?: string,
 *   stage?: string,
 *   progressCurrent?: number,
 *   progressTotal?: number,
 *   createdAt?: string,
 * }} input
 */
export function insertTestWorkItem(db, input) {
  const createdAt = input.createdAt ?? '2026-08-27T12:00:00.000Z';
  const state = input.state ?? 'ready';
  const stage = input.stage ?? (state === 'ready' || state === 'destroyed' ? 'complete' : 'child_creation');
  const reference = input.reference === undefined ? `PROJECT-${input.id}` : input.reference;
  const creationSource = input.creationSource ?? (reference ? 'reference' : 'manual');
  const repositories = input.repositories ?? [];
  db.prepare(
    `INSERT INTO work_items (
      id, title, summary, creation_source, path, bookmark, state, stage,
      progress_current, progress_total, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.title ?? `Work ${input.id}`,
    input.summary ?? null,
    creationSource,
    input.path ?? `/tmp/${input.id}`,
    input.bookmark ?? `patrol/work-item-${input.id}`,
    state,
    stage,
    input.progressCurrent ?? 0,
    input.progressTotal ?? 0,
    createdAt,
    createdAt,
  );
  if (reference) {
    db.prepare(
      `INSERT INTO work_item_references (work_item_id, reference, resolver_provider)
       VALUES (?, ?, ?)`,
    ).run(input.id, reference, input.resolverProvider ?? 'codex');
  }
  const insertRepository = db.prepare(
    `INSERT INTO work_item_repositories (
      work_item_id, repo, start_revision, position, membership_source, state, created_at, updated_at
    ) VALUES (?, ?, 'main@origin', ?, 'initial', ?, ?, ?)`,
  );
  repositories.forEach((repository, position) => {
    insertRepository.run(input.id, repository, position, state === 'ready' ? 'ready' : 'adding', createdAt, createdAt);
  });
}
