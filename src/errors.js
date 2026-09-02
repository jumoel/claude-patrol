/**
 * Build an Error that carries a machine-readable `code`. Every module that
 * used to define its own one-line factory (workItemError, workspaceError,
 * cleanupError, reviewError, ...) delegates here so the shape is identical
 * everywhere: `error.code` for routing, `error.message` for people, optional
 * extra fields for the HTTP envelope (failedProvider, sessionId, ...).
 * @param {string} code
 * @param {string} message
 * @param {Error | ({ cause?: unknown } & Record<string, unknown>)} [extras] an Error is taken as the cause
 * @returns {Error & { code: string }}
 */
export function taggedError(code, message, extras = {}) {
  const { cause, ...fields } = extras instanceof Error ? { cause: extras } : extras;
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  Object.assign(error, fields);
  return /** @type {Error & { code: string }} */ (error);
}
