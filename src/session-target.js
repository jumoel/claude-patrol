const TARGET_TYPES = new Set(['global', 'workspace', 'work_item']);

export function normalizeSessionTarget(target) {
  if (!target || typeof target !== 'object' || !TARGET_TYPES.has(target.type)) {
    throw new TypeError('Session target must be global, workspace, or work_item');
  }
  if (target.type === 'global') {
    if (target.id !== undefined && target.id !== null) {
      throw new TypeError('Global session targets do not have an id');
    }
    return Object.freeze({ type: 'global' });
  }
  if (typeof target.id !== 'string' || target.id.length === 0) {
    throw new TypeError(`${target.type} session targets require an id`);
  }
  return Object.freeze({ type: target.type, id: target.id });
}

export function sessionTargetFromRow(row) {
  if (row?.workspace_id) return Object.freeze({ type: 'workspace', id: row.workspace_id });
  if (row?.work_item_id) return Object.freeze({ type: 'work_item', id: row.work_item_id });
  return Object.freeze({ type: 'global' });
}

export function sessionTargetColumns(target) {
  const normalized = normalizeSessionTarget(target);
  return {
    workspaceId: normalized.type === 'workspace' ? normalized.id : null,
    workItemId: normalized.type === 'work_item' ? normalized.id : null,
  };
}

export function sessionTargetWhere(target, alias = '') {
  const normalized = normalizeSessionTarget(target);
  const prefix = alias ? `${alias}.` : '';
  if (normalized.type === 'workspace') {
    return { sql: `${prefix}workspace_id = ?`, params: [normalized.id] };
  }
  if (normalized.type === 'work_item') {
    return { sql: `${prefix}work_item_id = ?`, params: [normalized.id] };
  }
  return { sql: `${prefix}workspace_id IS NULL AND ${prefix}work_item_id IS NULL`, params: [] };
}

export function sessionTargetKey(target) {
  const normalized = normalizeSessionTarget(target);
  return normalized.type === 'global' ? 'global' : `${normalized.type}:${normalized.id}`;
}
