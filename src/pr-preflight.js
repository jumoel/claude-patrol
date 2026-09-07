import { getDb, withTransaction } from './db.js';
import { taggedError } from './errors.js';
import { githubClient } from './github-client.js';
import { requireGraphqlRoot } from './github-graphql.js';
import { prStore } from './pr-store.js';
import { PR_SUMMARY_FIELDS } from './review-request-query.js';

/** A checkout request binds to the exact head the caller displayed. */
export async function preflightPullRequest(id, expectedHead, config) {
  const db = getDb();
  const cached = db.prepare('SELECT * FROM prs WHERE id = ?').get(id);
  if (!cached) throw taggedError('pr_not_found', 'Pull request not found');
  if (!/^[0-9a-f]{40,64}$/i.test(expectedHead ?? ''))
    throw taggedError('invalid_revision', 'An exact displayed PR head is required');
  if (cached.head_oid !== expectedHead)
    throw taggedError('invalid_state', 'PR head changed; refresh before creating a workspace');
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
      { owner: cached.org, repo: cached.repo, number: cached.number },
      { observation },
    );
    const node = requireGraphqlRoot(result, 'repository').pullRequest;
    if (!node) throw taggedError('upstream_failed', 'GitHub did not return the PR');
    const row = withTransaction(db, () => {
      observation.assertCurrent();
      return store.write(store.prepare(node, 'summary', context));
    });
    store.fence.accept(context.read, [`pr:${row.id}`]);
    if (row.github_state !== 'OPEN' || row.head_oid !== expectedHead) {
      throw taggedError('invalid_state', 'PR state or head changed; refresh before creating a workspace');
    }
    return row;
  } finally {
    store.end(context);
  }
}
