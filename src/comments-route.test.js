import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommentsPayload, resolvedThreadRootIds } from './routes/comments.js';

test('resolved review thread pages expose their root comment node IDs', () => {
  const resolved = resolvedThreadRootIds([
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { isResolved: true, comments: { nodes: [{ id: 'ROOT_resolved' }] } },
                { isResolved: false, comments: { nodes: [{ id: 'ROOT_open' }] } },
              ],
            },
          },
        },
      },
    },
    {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ isResolved: true, comments: { nodes: [{ id: 'ROOT_second_page' }] } }],
            },
          },
        },
      },
    },
  ]);

  assert.deepEqual([...resolved], ['ROOT_resolved', 'ROOT_second_page']);
});

test('comment payload marks every reply in a resolved thread and preserves dismissed reviews', () => {
  const payload = buildCommentsPayload(
    [
      {
        id: 50,
        user: { login: 'reviewer' },
        state: 'DISMISSED',
        body_html: '<p>Old review</p>',
        submitted_at: '2026-09-01T10:00:00Z',
      },
    ],
    [
      {
        id: 10,
        node_id: 'ROOT_resolved',
        pull_request_review_id: 50,
        path: 'src/one.js',
        position: 3,
        body_html: '<p>Root</p>',
        created_at: '2026-09-01T10:01:00Z',
      },
      {
        id: 11,
        node_id: 'REPLY_resolved',
        in_reply_to_id: 10,
        pull_request_review_id: 50,
        path: 'src/one.js',
        position: 3,
        body_html: '<p>Reply</p>',
        created_at: '2026-09-01T10:02:00Z',
      },
      {
        id: 20,
        node_id: 'ROOT_open',
        pull_request_review_id: 50,
        path: 'src/two.js',
        position: 7,
        body_html: '<p>Open</p>',
        created_at: '2026-09-01T10:03:00Z',
      },
    ],
    [],
    new Set(['ROOT_resolved']),
  );

  assert.equal(payload.reviews[0].state, 'DISMISSED');
  assert.deepEqual(
    payload.reviews[0].comments.map((comment) => comment.resolved),
    [true, true, false],
  );
});
