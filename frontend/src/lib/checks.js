const FAILED_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT']);
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export function isFailedCheck(check) {
  return FAILED_CONCLUSIONS.has(check.conclusion);
}

export function isPassedCheck(check) {
  return PASSED_CONCLUSIONS.has(check.conclusion);
}

export function isRunningCheck(check) {
  return check.status === 'IN_PROGRESS' && !check.conclusion;
}

export function isScheduledCheck(check) {
  return !isFailedCheck(check) && !isPassedCheck(check) && !isRunningCheck(check);
}

export function isMergeReady(pr) {
  return pr.ci_status === 'pass' && pr.mergeable === 'MERGEABLE' && pr.review_status === 'approved' && !pr.draft;
}

/**
 * Map a check to a display status. Uses real GitHub status/conclusion values
 * when available, falling back to the raw status string.
 */
export function checkToStatus(check) {
  if (isFailedCheck(check)) return check.conclusion;
  if (isPassedCheck(check)) return check.conclusion;
  // Not completed - use the status field directly (IN_PROGRESS, QUEUED, WAITING, PENDING, REQUESTED)
  // StatusContext uses state field: EXPECTED, ERROR, FAILURE, PENDING, SUCCESS
  return check.status || 'PENDING';
}

/**
 * Map a status string to a color group for styling.
 * Groups: 'green', 'red', 'blue', 'yellow', 'gray'
 */
export function statusColorGroup(status) {
  switch (status) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'green';
    case 'FAILURE':
    case 'ERROR':
    case 'TIMED_OUT':
      return 'red';
    case 'IN_PROGRESS':
      return 'blue';
    case 'QUEUED':
    case 'WAITING':
    case 'PENDING':
    case 'REQUESTED':
    case 'EXPECTED':
      return 'yellow';
    default:
      return 'gray';
  }
}
