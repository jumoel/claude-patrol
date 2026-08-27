const TERMINAL_PARAM = 'terminal';

/**
 * Return the session whose terminal should be maximized in the current route.
 * @param {string} [hash]
 */
export function maximizedTerminalId(hash = window.location.hash) {
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1)).get(TERMINAL_PARAM);
}

/**
 * Set or clear the maximized terminal without adding a browser-history entry.
 * Other route query parameters, such as a selected pull request, are retained.
 * @param {string | null} sessionId
 */
export function replaceMaximizedTerminal(sessionId) {
  const hash = window.location.hash || '#/';
  const queryIndex = hash.indexOf('?');
  const path = queryIndex === -1 ? hash : hash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : hash.slice(queryIndex + 1));

  if (sessionId) params.set(TERMINAL_PARAM, sessionId);
  else params.delete(TERMINAL_PARAM);

  const query = params.toString();
  const nextHash = `${path}${query ? `?${query}` : ''}`;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

/**
 * Clear the query only when it belongs to the supplied session. A work terminal
 * and the global session bar can coexist on the same route.
 * @param {string} sessionId
 */
export function clearMaximizedTerminal(sessionId) {
  if (maximizedTerminalId() === sessionId) replaceMaximizedTerminal(null);
}
