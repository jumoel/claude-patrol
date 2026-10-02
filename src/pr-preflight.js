import { getDb, withTransaction } from './db.js';
import { taggedError } from './errors.js';
import { githubClient } from './github-client.js';
import { requireGraphqlRoot } from './github-graphql.js';
import { prStore } from './pr-store.js';
import { PR_SUMMARY_FIELDS } from './review-request-query.js';
import { parsePullRequestReference } from './work-item-prs.js';

/** Only GitHub PR URLs bypass the configured project-reference resolver. */
export function githubPullRequestReference(reference) {
  if (typeof reference !== 'string' || !/^https:\/\//iu.test(reference.trim())) return null;
  try {
    const url = new URL(reference.trim());
    if (url.username || url.password || url.port) return null;
    return parsePullRequestReference(reference);
  } catch {
    return null;
  }
}

/** A pasted URL has no displayed head; bind it to the head GitHub returns. */
export async function resolvePullRequest(reference, config) {
  return fetchOpenPullRequest(parsePullRequestReference(reference), null, config);
}

/** A checkout request binds to the exact head the caller displayed. */
export async function preflightPullRequest(id, expectedHead, config) {
  const db = getDb();
  const cached = db.prepare('SELECT * FROM prs WHERE id = ?').get(id);
  if (!cached) throw taggedError('pr_not_found', 'Pull request not found');
  if (!/^[0-9a-f]{40,64}$/i.test(expectedHead ?? ''))
    throw taggedError('invalid_revision', 'An exact displayed PR head is required');
  if (cached.head_oid !== expectedHead)
    throw taggedError('invalid_state', 'PR head changed; refresh before creating a workspace');
  return fetchOpenPullRequest(cached, expectedHead, config);
}

async function fetchOpenPullRequest(coordinates, expectedHead, config) {
  const db = getDb();
  const client = githubClient(db);
  client.configure(config.poll);
  const observation = client.capture();
  const store = prStore(db);
  const context = store.begin();
  try {
    const result = await client.request(
      `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${PR_SUMMARY_FIELDS} } }
    }`,
      { owner: coordinates.org, repo: coordinates.repo, number: coordinates.number },
      { observation },
    );
    const node = requireGraphqlRoot(result, 'repository').pullRequest;
    if (!node) throw taggedError('upstream_failed', 'GitHub did not return the PR');
    const row = withTransaction(db, () => {
      observation.assertCurrent();
      return store.write(store.prepare(node, 'summary', context));
    });
    store.fence.accept(context.read, [`pr:${row.id}`]);
    if (row.github_state !== 'OPEN' || (expectedHead !== null && row.head_oid !== expectedHead)) {
      throw taggedError('invalid_state', 'PR state or head changed; refresh before creating a workspace');
    }
    if (!/^[0-9a-f]{40,64}$/i.test(row.head_oid ?? ''))
      throw taggedError('invalid_revision', 'GitHub did not return an exact PR head');
    return row;
  } finally {
    store.end(context);
  }
}
