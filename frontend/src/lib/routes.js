/**
 * @typedef {{type: 'dashboard'} | {type: 'setup', section: 'poll' | 'work_items'} | {type: 'pr' | 'workspace', id: string} | {type: 'work_item', id: string, selectedPrId?: string} | {type: 'not_found'}} AppRoute
 */

/** @param {string} value */
function decodeId(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/** @param {string} hash @returns {AppRoute} */
export function parseAppRoute(hash) {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path, query = ''] = raw.split('?');
  if (!path || path === '/' || path === '') return { type: 'dashboard' };
  if (path === '/setup') {
    const section = new URLSearchParams(query).get('section') === 'work-items' ? 'work_items' : 'poll';
    return { type: 'setup', section };
  }
  /** @type {Array<[string, 'pr' | 'workspace' | 'work_item']>} */
  const routes = [
    ['/pr/', 'pr'],
    ['/workspace/', 'workspace'],
    ['/work-item/', 'work_item'],
  ];
  for (const [prefix, type] of routes) {
    if (path.startsWith(prefix)) {
      const encodedId = path.slice(prefix.length);
      if (!encodedId || encodedId.includes('/')) return { type: 'not_found' };
      const id = decodeId(encodedId);
      if (!id || (type !== 'pr' && id.includes('/'))) return { type: 'not_found' };
      if (type === 'work_item') {
        const selectedPrId = new URLSearchParams(query).get('pr');
        return selectedPrId ? { type, id, selectedPrId } : { type, id };
      }
      return { type, id };
    }
  }
  return { type: 'not_found' };
}

/** @param {string} workItemId @param {string | null | undefined} [selectedPrId] */
export function workItemPath(workItemId, selectedPrId) {
  const path = `/work-item/${encodeURIComponent(workItemId)}`;
  return selectedPrId ? `${path}?pr=${encodeURIComponent(selectedPrId)}` : path;
}

/** @param {Pick<import('../types').PullRequest, 'id' | 'work_item_id'>} pr */
export function pullRequestPath(pr) {
  return pr.work_item_id ? workItemPath(pr.work_item_id, pr.id) : `/pr/${encodeURIComponent(pr.id)}`;
}
