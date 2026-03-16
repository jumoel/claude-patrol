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
  };
}
