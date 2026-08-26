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
    const attached = workItem.pull_requests.map((linked) => {
      const tracked = pullRequestById.get(linked.id);
      return summarizePullRequest(tracked || linked);
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
    if (pr.work_item_id) continue;
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
 * @param {Set<string>} dismissedIdle
 * @returns {import('../types').DashboardSessionSummary[]}
 */
export function buildWaitingSessions(sessions, dismissedIdle) {
  return sessions
    .filter((session) => {
      if (!['active', 'detached'].includes(session.status) || session.activity_state !== 'idle') return false;
      if (session.target.type === 'global') return true;
      const key = `${session.target.type === 'work_item' ? 'work-item' : 'workspace'}:${session.target.id}`;
      return !dismissedIdle.has(key);
    })
    .map(summarizeSession)
    .sort((a, b) => (b.activity_changed_at || b.started_at).localeCompare(a.activity_changed_at || a.started_at));
}
