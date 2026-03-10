const FAILED_CONCLUSIONS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT']);
const PASSED_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

export function isFailedCheck(check) {
  return FAILED_CONCLUSIONS.has(check.conclusion);
}

export function isPassedCheck(check) {
  return PASSED_CONCLUSIONS.has(check.conclusion);
}

export function checkToStatus(check) {
  if (isFailedCheck(check)) return 'fail';
  if (isPassedCheck(check)) return 'pass';
  return 'pending';
}
