/**
 * @typedef {{type: 'dashboard'} | {type: 'setup', section: 'poll' | 'work_items'} | {type: 'pr' | 'workspace' | 'work_item', id: string} | {type: 'not_found'}} AppRoute
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
      return { type, id };
    }
  }
  return { type: 'not_found' };
}
