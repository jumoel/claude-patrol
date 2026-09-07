import { createHash } from 'node:crypto';

export const REVIEW_LIMITS = Object.freeze({
  targets: 32,
  aliases: 32,
  scope: 5,
  searchPage: 50,
  overflow: 4,
  retained: 100,
  reviewers: 100,
  probes: 20,
  events: 100,
  interactive: 4,
});
export const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function normalizedScope(poll) {
  const orgs = [...new Set((poll.orgs ?? []).map((value) => value.toLowerCase()))].sort();
  const repos = [...new Set((poll.repos ?? []).map((value) => value.toLowerCase()))]
    .filter((value) => !orgs.includes(value.split('/')[0]))
    .sort();
  return { orgs, repos };
}

export function inReviewScope(pr, poll) {
  const { orgs, repos } = normalizedScope(poll);
  return orgs.includes(pr.org.toLowerCase()) || repos.includes(`${pr.org}/${pr.repo}`.toLowerCase());
}

export function reviewPlanId(poll) {
  return digest({
    scope: normalizedScope(poll),
    users: [...new Set(poll.review_requests?.users ?? ['@me'])].sort(),
    teams: [...new Set(poll.review_requests?.teams ?? [])].sort(),
  });
}

/** Configuration contains exact targets, never a request to enumerate teams. */
export function reviewTargets(poll, viewer = null) {
  const targets = new Map();
  for (const [kind, values] of [
    ['user', poll.review_requests?.users ?? ['@me']],
    ['team', poll.review_requests?.teams ?? []],
  ]) {
    for (const literal of values) {
      const name = literal === '@me' && viewer ? viewer.login.toLowerCase() : literal.toLowerCase();
      const id = `${kind}:${name}`;
      const target = targets.get(id) ?? { id, kind, name, configured_values: [], viewer_id: null };
      target.configured_values.push(literal);
      if (kind === 'user' && viewer?.login.toLowerCase() === name) target.viewer_id = viewer.id;
      targets.set(id, target);
    }
  }
  return [...targets.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function reviewShards(poll, viewer) {
  const scope = normalizedScope(poll);
  const shards = [];
  for (const target of reviewTargets(poll, viewer)) {
    const owner = target.kind === 'team' ? target.name.split('/')[0] : null;
    const qualifiers = [
      ...scope.orgs.filter((org) => !owner || org === owner).map((org) => `org:${org}`),
      ...scope.repos.filter((repo) => !owner || repo.split('/')[0] === owner).map((repo) => `repo:${repo}`),
    ];
    const qualifier =
      target.kind === 'team'
        ? `team-review-requested:${target.name}`
        : `user-review-requested:${target.viewer_id ? '@me' : target.name}`;
    for (let offset = 0; offset < qualifiers.length; offset += REVIEW_LIMITS.scope) {
      const query = `is:pr is:open ${qualifiers.slice(offset, offset + REVIEW_LIMITS.scope).join(' ')} ${qualifier} sort:updated-desc`;
      const hash = digest(query);
      shards.push({ id: digest([target.id, hash]), target_id: target.id, query_hash: hash, query });
    }
  }
  return shards;
}

export const PR_SUMMARY_FIELDS = `id number state title url createdAt updatedAt
  isDraft isCrossRepository headRefName headRefOid baseRefName
  author { login } repository { name owner { login } }`;
export const REVIEWER_FIELDS = `__typename ... on User { id login }
  ... on Team { slug organization { login } }`;
export const REVIEW_SEARCH_FIELDS = `issueCount pageInfo { hasNextPage endCursor }
  nodes { ... on PullRequest { ${PR_SUMMARY_FIELDS} } }`;

/** Numeric aliases and variables keep configuration outside GraphQL syntax. */
export function composeReviewSearch(query, variables, shards, retained = []) {
  if (shards.length > REVIEW_LIMITS.aliases || retained.length > REVIEW_LIMITS.retained) {
    throw new RangeError('Review operation exceeds its configured bounds');
  }
  const declarations = [];
  const fields = [];
  const next = { ...variables };
  shards.forEach((shard, index) => {
    declarations.push(`$reviewQ${index}: String!`);
    fields.push(
      `review${index}: search(query: $reviewQ${index}, type: ISSUE, first: ${REVIEW_LIMITS.searchPage}) { ${REVIEW_SEARCH_FIELDS} }`,
    );
    next[`reviewQ${index}`] = shard.query;
  });
  const retainedIds = retained.map((row) => (typeof row === 'string' ? row : row.github_node_id)).filter(Boolean);
  if (retainedIds.length) {
    declarations.push('$retainedIds: [ID!]!');
    fields.push(`retained: nodes(ids: $retainedIds) { ... on PullRequest { ${PR_SUMMARY_FIELDS} } }`);
    next.retainedIds = retainedIds;
  }
  retained.forEach((row, index) => {
    if (typeof row === 'string' || row.github_node_id) return;
    if (!row.org || !row.repo || !Number.isSafeInteger(row.number))
      throw new TypeError('Legacy PR coordinates are required');
    declarations.push(`$legacyOwner${index}: String!`, `$legacyRepo${index}: String!`, `$legacyNumber${index}: Int!`);
    Object.assign(next, {
      [`legacyOwner${index}`]: row.org,
      [`legacyRepo${index}`]: row.repo,
      [`legacyNumber${index}`]: row.number,
    });
    fields.push(`retainedLegacy${index}: repository(owner: $legacyOwner${index}, name: $legacyRepo${index}) {
      pullRequest(number: $legacyNumber${index}) { ${PR_SUMMARY_FIELDS} }
    }`);
  });
  const match = /query\s*\(([^)]*)\)\s*\{/.exec(query);
  if (!match) throw new TypeError('Expected a parameterized GraphQL query');
  return {
    query: query.replace(
      match[0],
      `query(${[match[1], ...declarations].filter(Boolean).join(', ')}) {
    ${fields.join('\n')}`,
    ),
    variables: next,
  };
}

export function exactReviewer(reviewer, target) {
  if (!reviewer) return false;
  if (target.kind === 'team')
    return (
      reviewer.__typename === 'Team' && `${reviewer.organization?.login}/${reviewer.slug}`.toLowerCase() === target.name
    );
  return (
    reviewer.__typename === 'User' &&
    (target.viewer_id ? reviewer.id === target.viewer_id : reviewer.login?.toLowerCase() === target.name)
  );
}

export function reviewReserve({ remaining, resetAt, interval, incrementalCost, fullCost, now = Date.now() }) {
  if (
    ![remaining, fullCost, interval].every(Number.isFinite) ||
    fullCost <= 0 ||
    interval <= 0 ||
    !Number.isFinite(Date.parse(resetAt))
  )
    return null;
  const seconds = Math.max(0, (Date.parse(resetAt) - now) / 1000);
  const cycles = Math.ceil(seconds / interval) + 1;
  const full = Math.min(cycles, Math.ceil(seconds / 1800) + 1);
  return Math.ceil(1.25 * ((cycles - full) * (incrementalCost ?? fullCost) + full * fullCost)) + fullCost;
}
