/**
 * @param {import('../types').SessionTarget | null | undefined} target
 * @returns {string | null}
 */
export function sessionTargetKey(target) {
  if (!target || target.type === 'global') return null;
  return `${target.type === 'work_item' ? 'work-item' : 'workspace'}:${target.id}`;
}
