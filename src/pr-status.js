import { isFailedConclusion, isPassedConclusion } from './utils.js';

/**
 * Derive overall CI status from checks array.
 * @param {Array<{status: string, conclusion: string | null}>} checks
 * @returns {'pass' | 'fail' | 'pending'}
 */
export function deriveCIStatus(checks) {
  if (checks.length === 0) return 'pending';
  const hasFailure = checks.some((c) => isFailedConclusion(c.conclusion));
  if (hasFailure) return 'fail';
  const allDone = checks.every((c) => c.status === 'COMPLETED' && isPassedConclusion(c.conclusion));
  if (allDone) return 'pass';
  return 'pending';
}

/**
 * Derive overall review status from reviews array.
 * @param {Array<{state: string}>} reviews
 * @returns {'approved' | 'changes_requested' | 'pending'}
 */
export function deriveReviewStatus(reviews) {
  if (reviews.length === 0) return 'pending';
  const byReviewer = new Map();
  for (const r of reviews) {
    byReviewer.set(r.reviewer, r.state);
  }
  const states = [...byReviewer.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return 'pending';
}

/**
 * Format a PR row for the API response (parse JSON columns once).
 * @param {object} row
 * @returns {object}
 */
export function formatPR(row) {
  const checks = JSON.parse(row.checks);
  const reviews = JSON.parse(row.reviews);
  return {
    ...row,
    draft: Boolean(row.draft),
    checks,
    reviews,
    labels: JSON.parse(row.labels),
    ci_status: deriveCIStatus(checks),
    review_status: deriveReviewStatus(reviews),
    base_branch: row.base_branch || 'main',
  };
}

/**
 * Enrich PRs with stack relationship data.
 * A PR is "stacked" if its base_branch matches another open PR's branch
 * within the same org/repo.
 * @param {object[]} prs - formatted PR objects
 * @returns {object[]} PRs with stack_parent, stack_children, stack_depth, stack_root fields
 */
export function enrichWithStackInfo(prs) {
  // Build lookup: org/repo + branch -> PR
  const branchToPR = new Map();
  for (const pr of prs) {
    const key = `${pr.org}/${pr.repo}:${pr.branch}`;
    branchToPR.set(key, pr);
  }

  // For each PR, find its parent (the PR whose branch matches this PR's base_branch)
  for (const pr of prs) {
    const parentKey = `${pr.org}/${pr.repo}:${pr.base_branch}`;
    const parent = branchToPR.get(parentKey);
    pr.stack_parent = parent ? parent.id : null;
    pr.stack_children = [];
  }

  // Build children lists
  for (const pr of prs) {
    if (pr.stack_parent) {
      const parent = prs.find((p) => p.id === pr.stack_parent);
      if (parent) parent.stack_children.push(pr.id);
    }
  }

  // Compute stack depth (distance from root of stack) and stack_root
  for (const pr of prs) {
    let depth = 0;
    let current = pr;
    while (current.stack_parent) {
      depth++;
      current = prs.find((p) => p.id === current.stack_parent);
      if (!current) break;
      if (depth > 50) break;
    }
    pr.stack_depth = depth;
    pr.stack_root = current ? current.id : pr.id;
    pr.is_stacked = depth > 0 || pr.stack_children.length > 0;
  }

  // Compute stack_size and stack_position (1-indexed) for each stacked PR
  const rootGroups = new Map();
  for (const pr of prs) {
    if (!pr.is_stacked) continue;
    if (!rootGroups.has(pr.stack_root)) rootGroups.set(pr.stack_root, []);
    rootGroups.get(pr.stack_root).push(pr);
  }
  for (const [, group] of rootGroups) {
    group.sort((a, b) => a.stack_depth - b.stack_depth);
    const size = group.length;
    for (let i = 0; i < group.length; i++) {
      group[i].stack_size = size;
      group[i].stack_position = i + 1;
    }
  }

  // Default for non-stacked
  for (const pr of prs) {
    if (!pr.is_stacked) {
      pr.stack_size = 0;
      pr.stack_position = 0;
    }
  }

  return prs;
}
