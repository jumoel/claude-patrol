import { getErrorMessage } from './errors.js';

/** @param {unknown} error @param {boolean} loading @param {boolean} loaded @param {boolean} [enabled] */
export function dashboardSourceState(error, loading, loaded, enabled = true) {
  if (!enabled) return { status: /** @type {const} */ ('disabled'), error: null };
  if (error) {
    return {
      status: loaded ? /** @type {const} */ ('stale') : /** @type {const} */ ('unavailable'),
      error: getErrorMessage(error),
    };
  }
  return {
    status: loading && !loaded ? /** @type {const} */ ('loading') : /** @type {const} */ ('ready'),
    error: null,
  };
}

/** @param {import('../types').PullRequest | import('../types').WorkItemPullRequest} pr */
function summarizePullRequest(pr) {
  const tracked = !('tracked' in pr) || pr.tracked;
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title || `Pull request #${pr.number}`,
    url: pr.url,
    org: pr.org,
    repo: pr.repo,
    draft: pr.draft,
    mergeable: pr.mergeable,
    ci_status: tracked ? pr.ci_status : null,
    review_status: tracked ? pr.review_status : null,
    updated_at: pr.updated_at,
    tracked,
    stack_root: 'stack_root' in pr ? pr.stack_root : null,
    stack_depth: 'stack_depth' in pr ? pr.stack_depth : 0,
    is_stacked: 'is_stacked' in pr ? pr.is_stacked : false,
  };
}

/** @param {import('../types').Session} session */
function summarizeSession(session) {
  return {
    id: session.id,
    name: session.name,
    provider: session.provider,
    target: session.target,
    status: /** @type {'active' | 'detached'} */ (session.status),
    activity_state: session.activity_state,
    activity_changed_at: session.activity_changed_at,
    started_at: session.started_at,
  };
}

/** @param {Array<string | null | undefined>} values */
function latestTimestamp(values) {
  const valid = values.filter(Boolean).map((value) => /** @type {string} */ (value));
  if (valid.length === 0) return new Date(0).toISOString();
  return valid.sort((a, b) => b.localeCompare(a))[0];
}

/**
 * Build the dashboard's ownership model. Attached pull requests belong to
 * their work item and never appear a second time as standalone rows.
 *
 * @param {{
 *   pullRequests: import('../types').PullRequest[],
 *   workItems: import('../types').WorkItemListItem[],
 *   workspaces: import('../types').Workspace[],
 *   sessions: import('../types').Session[],
 * }} input
 * @returns {import('../types').DashboardWorkRow[]}
 */
export function buildDashboardRows({ pullRequests, workItems, workspaces, sessions }) {
  const pullRequestById = new Map(pullRequests.map((pr) => [pr.id, pr]));
  /** @type {Map<string, import('../types').PullRequest[]>} */
  const pullRequestsByWorkItem = new Map();
  for (const pr of pullRequests) {
    if (!pr.work_item_id) continue;
    const owned = pullRequestsByWorkItem.get(pr.work_item_id) || [];
    owned.push(pr);
    pullRequestsByWorkItem.set(pr.work_item_id, owned);
  }
  const ownedPullRequestIds = new Set();
  const liveSessions = sessions.filter((session) => session.status === 'active' || session.status === 'detached');
  const sessionsByWorkItem = new Map();
  const sessionsByWorkspace = new Map();

  for (const session of liveSessions) {
    const targetMap = session.target.type === 'work_item' ? sessionsByWorkItem : sessionsByWorkspace;
    if (session.target.type === 'global') continue;
    const current = targetMap.get(session.target.id) || [];
    current.push(summarizeSession(session));
    targetMap.set(session.target.id, current);
  }

  /** @type {import('../types').DashboardWorkRow[]} */
  const rows = workItems.map((workItem) => {
    const linkedPullRequests = [
      ...workItem.pull_requests,
      ...(pullRequestsByWorkItem.get(workItem.id) || []).filter(
        (pr) => !workItem.pull_requests.some((linked) => linked.id === pr.id),
      ),
    ];
    const attached = linkedPullRequests.flatMap((linked) => {
      const tracked = pullRequestById.get(linked.id);
      if (tracked?.work_item_id && tracked.work_item_id !== workItem.id) return [];
      if (ownedPullRequestIds.has(linked.id)) return [];
      ownedPullRequestIds.add(linked.id);
      return [summarizePullRequest(tracked || linked)];
    });
    const readyWorkspaces = workItem.repository_workspaces.filter((workspace) => workspace.state === 'ready');
    const childSessions = readyWorkspaces.flatMap((workspace) =>
      workspace.workspace_id ? sessionsByWorkspace.get(workspace.workspace_id) || [] : [],
    );
    return {
      kind: /** @type {const} */ ('work_item'),
      id: workItem.id,
      title: workItem.title || workItem.reference_display || workItem.reference,
      work_reference: {
        display: workItem.reference_display || workItem.reference,
        system: workItem.reference_system,
        url: workItem.reference_url,
      },
      repositories: workItem.repositories,
      pull_requests: attached,
      sessions: [...(sessionsByWorkItem.get(workItem.id) || []), ...childSessions],
      workspace_count: readyWorkspaces.length,
      workspace_id: null,
      updated_at: latestTimestamp([workItem.updated_at, ...attached.map((pr) => pr.updated_at)]),
      state: workItem.state,
    };
  });

  for (const pr of pullRequests) {
    if (ownedPullRequestIds.has(pr.id)) continue;
    const workspace = workspaces.find((candidate) => candidate.pr_id === pr.id) || null;
    rows.push({
      kind: 'pull_request',
      id: pr.id,
      title: pr.title,
      work_reference: null,
      repositories: [`${pr.org}/${pr.repo}`],
      pull_requests: [summarizePullRequest(pr)],
      sessions: workspace ? sessionsByWorkspace.get(workspace.id) || [] : [],
      workspace_count: workspace ? 1 : 0,
      workspace_id: workspace?.id || null,
      updated_at: pr.updated_at,
      state: null,
    });
  }

  for (const workspace of workspaces) {
    if (workspace.pr_id) continue;
    rows.push({
      kind: 'scratch',
      id: workspace.id,
      title: workspace.name || workspace.bookmark,
      work_reference: null,
      repositories: workspace.repo ? [workspace.repo] : [],
      pull_requests: [],
      sessions: sessionsByWorkspace.get(workspace.id) || [],
      workspace_count: 1,
      workspace_id: workspace.id,
      updated_at: workspace.operation_updated_at || workspace.created_at,
      state: null,
    });
  }

  return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.title.localeCompare(b.title));
}

/**
 * @param {import('../types').Session[]} sessions
 * @param {Map<string, string>} acknowledgedIdle
 * @returns {import('../types').DashboardSessionSummary[]}
 */
export function buildWaitingSessions(sessions, acknowledgedIdle) {
  return sessions
    .filter((session) => {
      if (
        !['active', 'detached'].includes(session.status) ||
        session.activity_state !== 'idle' ||
        !session.activity_changed_at
      ) {
        return false;
      }
      return acknowledgedIdle.get(session.id) !== session.activity_changed_at;
    })
    .map(summarizeSession)
    .sort((a, b) => (b.activity_changed_at || b.started_at).localeCompare(a.activity_changed_at || a.started_at));
}

/**
 * @param {import('../types').Session[]} sessions
 * @returns {import('../types').DashboardSessionSummary[]}
 */
export function buildWorkingSessions(sessions) {
  return sessions
    .filter((session) => ['active', 'detached'].includes(session.status) && session.activity_state === 'working')
    .map(summarizeSession)
    .sort((a, b) => (b.activity_changed_at || b.started_at).localeCompare(a.activity_changed_at || a.started_at));
}

export const REVIEW_READY_FILTERS = Object.freeze({
  ci: ['pass'],
  review: ['changes_requested', 'pending'],
  mergeable: ['MERGEABLE'],
  draft: ['false'],
});

export const MERGE_READY_FILTERS = Object.freeze({ ...REVIEW_READY_FILTERS, review: ['approved'] });
const DASHBOARD_FILTER_KEYS = /** @type {const} */ (['org', 'repo', 'ci', 'review', 'mergeable', 'draft']);

/** @param {import('../types').DashboardPullRequestSummary} pr @param {import('../types').FilterState} filters */
function pullRequestMatches(pr, filters) {
  if (!pr.tracked) return false;
  if (filters.needsWork && pr.ci_status === 'pass' && pr.mergeable === 'MERGEABLE' && !pr.draft) return false;
  if (filters.org?.length && !filters.org.includes(pr.org)) return false;
  if (filters.repo?.length && !filters.repo.includes(pr.repo)) return false;
  if (filters.ci?.length && (!pr.ci_status || !filters.ci.includes(pr.ci_status))) return false;
  if (filters.review?.length && (!pr.review_status || !filters.review.includes(pr.review_status))) return false;
  if (filters.mergeable?.length && !filters.mergeable.includes(pr.mergeable)) return false;
  if (filters.draft?.length && !filters.draft.includes(pr.draft ? 'true' : 'false')) return false;
  return true;
}

/** @param {string} repository */
function repositoryParts(repository) {
  const slash = repository.indexOf('/');
  return slash === -1
    ? { org: '', repo: repository }
    : { org: repository.slice(0, slash), repo: repository.slice(slash + 1) };
}

/** @param {import('../types').DashboardWorkRow} row @param {import('../types').FilterState} filters */
function repositoryMatches(row, filters) {
  return row.repositories.some((repository) => {
    const { org, repo } = repositoryParts(repository);
    if (filters.org?.length && !filters.org.includes(org)) return false;
    if (filters.repo?.length && !filters.repo.includes(repo)) return false;
    return true;
  });
}

/**
 * OR applies within one filter. AND applies across filters. Once any PR-only
 * constraint is active, the same tracked PR must satisfy org, repo, and every
 * status constraint.
 *
 * @param {import('../types').DashboardWorkRow[]} rows
 * @param {import('../types').FilterState} filters
 */
export function filterDashboardRows(rows, filters) {
  const hasRepositoryFilter = !!(filters.org?.length || filters.repo?.length);
  const hasPullRequestConstraint = !!(
    filters.ci?.length ||
    filters.review?.length ||
    filters.mergeable?.length ||
    filters.draft?.length ||
    filters.needsWork
  );
  if (!hasRepositoryFilter && !hasPullRequestConstraint) return rows;

  return rows.filter((row) => {
    if (hasPullRequestConstraint) return row.pull_requests.some((pr) => pullRequestMatches(pr, filters));
    return repositoryMatches(row, filters) || row.pull_requests.some((pr) => pullRequestMatches(pr, filters));
  });
}

/** @param {import('../types').DashboardWorkRow} row @param {string} key */
function sortValue(row, key) {
  const pr = row.pull_requests.find((candidate) => candidate.tracked);
  if (key === 'title') return row.title;
  if (key === 'repo') return row.repositories[0] || '';
  if (key === 'ci_status') return pr?.ci_status || '';
  if (key === 'review_status') return pr?.review_status || '';
  if (key === 'mergeable') return pr?.mergeable || '';
  if (key === 'pr_status') return pr ? (pr.draft ? 'draft' : 'open') : '';
  if (key === 'updated_at') return row.updated_at;
  return '';
}

/**
 * @param {import('../types').DashboardWorkRow[]} rows
 * @param {{id: string, desc: boolean}[]} sorting
 * @param {boolean} stackView
 */
export function sortDashboardRows(rows, sorting, stackView) {
  const result = [...rows];
  const activeSort = sorting[0];
  if (activeSort) {
    const direction = activeSort.desc ? -1 : 1;
    return result.sort(
      (a, b) =>
        sortValue(a, activeSort.id).localeCompare(sortValue(b, activeSort.id), undefined, { numeric: true }) *
        direction,
    );
  }
  if (!stackView) return result;

  const standaloneSlots = result.map((row, index) => ({ row, index })).filter(({ row }) => row.kind === 'pull_request');
  const ordered = standaloneSlots
    .map(({ row }) => row)
    .sort((a, b) => {
      const aPR = a.pull_requests[0];
      const bPR = b.pull_requests[0];
      if (aPR?.is_stacked && bPR?.is_stacked && aPR.stack_root === bPR.stack_root) {
        return aPR.stack_depth - bPR.stack_depth;
      }
      return b.updated_at.localeCompare(a.updated_at);
    });
  standaloneSlots.forEach(({ index }, orderedIndex) => {
    result[index] = ordered[orderedIndex];
  });
  return result;
}

/** @param {import('../types').FilterState} current @param {import('../types').FilterState} target */
export function dashboardFiltersMatch(current, target) {
  if (!!current.needsWork !== !!target.needsWork) return false;
  return DASHBOARD_FILTER_KEYS.every((key) => {
    const currentValue = current[key] || [];
    const targetValue = target[key] || [];
    return currentValue.length === targetValue.length && targetValue.every((item) => currentValue.includes(item));
  });
}

/** @param {import('../types').DashboardWorkRow[]} rows */
export function serializeDashboardRowsMarkdown(rows) {
  return rows
    .map((row) => {
      const kind = row.kind === 'work_item' ? 'Work item' : row.kind === 'pull_request' ? 'Pull request' : 'Scratch';
      const reference = row.work_reference
        ? row.work_reference.url
          ? ` [${row.work_reference.display}](${row.work_reference.url})`
          : ` ${row.work_reference.display}`
        : '';
      const pullRequests = row.pull_requests.map((pr) => `\n  - [#${pr.number}](${pr.url}) - ${pr.title}`).join('');
      return `- ${kind}${reference} - ${row.title}${pullRequests}`;
    })
    .join('\n');
}
