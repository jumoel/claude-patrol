const FAILED_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT']);
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export function isFailedCheck(check) {
  return FAILED_CONCLUSIONS.has(check.conclusion);
}

export function isPassedCheck(check) {
  return PASSED_CONCLUSIONS.has(check.conclusion);
}

export function isMergeReady(pr) {
  return pr.ci_status === 'pass' && pr.mergeable === 'MERGEABLE' && pr.review_status === 'approved' && !pr.draft;
}

export function checkToStatus(check) {
  if (isFailedCheck(check)) return 'fail';
  if (isPassedCheck(check)) return 'pass';
  return 'pending';
}
