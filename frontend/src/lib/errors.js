/**
 * Convert an unknown thrown value into display-safe text without assuming
 * every rejection is an Error instance.
 * @param {unknown} error
 * @param {string} [fallback]
 * @returns {string}
 */
export function getErrorMessage(error, fallback = 'Unknown error') {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return fallback;
}
