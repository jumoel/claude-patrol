import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseAppRoute, pullRequestPath, workItemPath } from './routes.js';

test('parses and round trips work-item detail routes', () => {
  const route = parseAppRoute('#/work-item/123e4567-e89b-12d3-a456-426614174000');
  assert.deepEqual(route, { type: 'work_item', id: '123e4567-e89b-12d3-a456-426614174000' });
});

test('selects an attached pull request on its work-item route', () => {
  const path = workItemPath('item-1', 'chainguard-dev/mono#50511');
  assert.equal(path, '/work-item/item-1?pr=chainguard-dev%2Fmono%2350511');
  assert.deepEqual(parseAppRoute(`#${path}`), {
    type: 'work_item',
    id: 'item-1',
    selectedPrId: 'chainguard-dev/mono#50511',
  });
});

test('routes an attached pull request through its work item', () => {
  assert.equal(
    pullRequestPath({ id: 'chainguard-dev/mono#50511', work_item_id: 'item-1' }),
    '/work-item/item-1?pr=chainguard-dev%2Fmono%2350511',
  );
  assert.equal(
    pullRequestPath({ id: 'chainguard-dev/mono#50511', work_item_id: null }),
    '/pr/chainguard-dev%2Fmono%2350511',
  );
});

test('preserves the encoded slash in canonical PR identifiers', () => {
  assert.deepEqual(parseAppRoute('#/pr/chainguard-dev%2Fmono%2350511'), {
    type: 'pr',
    id: 'chainguard-dev/mono#50511',
  });
});

test('opens the direct Work Items settings section', () => {
  assert.deepEqual(parseAppRoute('#/setup?section=work-items'), { type: 'setup', section: 'work_items' });
  assert.deepEqual(parseAppRoute('#/setup'), { type: 'setup', section: 'poll' });
});

test('rejects missing and malformed route identifiers', () => {
  assert.deepEqual(parseAppRoute('#/work-item/'), { type: 'not_found' });
  assert.deepEqual(parseAppRoute('#/workspace/a/b'), { type: 'not_found' });
  assert.deepEqual(parseAppRoute('#/unknown'), { type: 'not_found' });
});
