import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeSessionTarget,
  sessionTargetColumns,
  sessionTargetFromRow,
  sessionTargetKey,
  sessionTargetWhere,
} from './session-target.js';

test('normalizeSessionTarget accepts the three target shapes and rejects everything else', () => {
  assert.deepEqual(normalizeSessionTarget({ type: 'global' }), { type: 'global' });
  assert.deepEqual(normalizeSessionTarget({ type: 'workspace', id: 'ws' }), { type: 'workspace', id: 'ws' });
  assert.deepEqual(normalizeSessionTarget({ type: 'work_item', id: 'wi' }), { type: 'work_item', id: 'wi' });
  assert.ok(Object.isFrozen(normalizeSessionTarget({ type: 'global' })));
  assert.throws(() => normalizeSessionTarget(null), /must be global, workspace, or work_item/);
  assert.throws(() => normalizeSessionTarget({ type: 'pr', id: 'x' }), /must be global/);
  assert.throws(() => normalizeSessionTarget({ type: 'global', id: 'x' }), /do not have an id/);
  assert.throws(() => normalizeSessionTarget({ type: 'workspace' }), /require an id/);
  assert.throws(() => normalizeSessionTarget({ type: 'work_item', id: '' }), /require an id/);
});

test('rows, columns, WHERE clauses and keys agree on the target', () => {
  assert.deepEqual(sessionTargetFromRow({ workspace_id: 'ws', work_item_id: null }), { type: 'workspace', id: 'ws' });
  assert.deepEqual(sessionTargetFromRow({ workspace_id: null, work_item_id: 'wi' }), { type: 'work_item', id: 'wi' });
  assert.deepEqual(sessionTargetFromRow({}), { type: 'global' });
  assert.deepEqual(sessionTargetFromRow(undefined), { type: 'global' });

  assert.deepEqual(sessionTargetColumns({ type: 'workspace', id: 'ws' }), { workspaceId: 'ws', workItemId: null });
  assert.deepEqual(sessionTargetColumns({ type: 'work_item', id: 'wi' }), { workspaceId: null, workItemId: 'wi' });
  assert.deepEqual(sessionTargetColumns({ type: 'global' }), { workspaceId: null, workItemId: null });

  assert.deepEqual(sessionTargetWhere({ type: 'workspace', id: 'ws' }), { sql: 'workspace_id = ?', params: ['ws'] });
  assert.deepEqual(sessionTargetWhere({ type: 'work_item', id: 'wi' }, 's'), {
    sql: 's.work_item_id = ?',
    params: ['wi'],
  });
  assert.deepEqual(sessionTargetWhere({ type: 'global' }, 's'), {
    sql: 's.workspace_id IS NULL AND s.work_item_id IS NULL',
    params: [],
  });

  assert.equal(sessionTargetKey({ type: 'global' }), 'global');
  assert.equal(sessionTargetKey({ type: 'workspace', id: 'ws' }), 'workspace:ws');
  assert.equal(sessionTargetKey({ type: 'work_item', id: 'wi' }), 'work_item:wi');
});
