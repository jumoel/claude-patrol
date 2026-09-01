import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { CommentsList } from './CommentsList.jsx';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

const reviews = /** @type {import('../../types').StructuredReview[]} */ ([
  {
    id: 1,
    author: 'dismissed-reviewer',
    state: 'DISMISSED',
    body_html: '<p>Dismissed review body</p>',
    submitted_at: '2026-09-01T10:00:00Z',
    comments: [],
  },
  {
    id: 2,
    author: 'active-reviewer',
    state: 'COMMENTED',
    body_html: '',
    submitted_at: '2026-09-01T11:00:00Z',
    comments: [
      {
        path: 'src/resolved.js',
        diff_position: 3,
        body_html: '<p>Resolved comment body</p>',
        created_at: '2026-09-01T11:01:00Z',
        resolved: true,
      },
      {
        path: 'src/open.js',
        diff_position: 7,
        body_html: '<p>Open comment body</p>',
        created_at: '2026-09-01T11:02:00Z',
        resolved: false,
      },
    ],
  },
]);

test('minimizes dismissed reviews and resolved inline comments by default', () => {
  render(<CommentsList reviews={reviews} conversation={[]} loading={false} />);

  const dismissedDetails = screen.getByText('dismissed-reviewer').closest('details');
  assert.ok(dismissedDetails);
  assert.equal(dismissedDetails.open, false);

  const resolvedDetails = screen.getByText('src/resolved.js').closest('details');
  assert.ok(resolvedDetails);
  assert.equal(resolvedDetails.open, false);

  assert.equal(screen.getByText('src/open.js').closest('details'), null);
  assert.ok(screen.getByText('Open comment body'));
});

test('keeps minimized GitHub history expandable', () => {
  render(<CommentsList reviews={reviews} conversation={[]} loading={false} />);

  const dismissedDetails = screen.getByText('dismissed-reviewer').closest('details');
  const resolvedDetails = screen.getByText('src/resolved.js').closest('details');
  assert.ok(dismissedDetails);
  assert.ok(resolvedDetails);
  const dismissedSummary = dismissedDetails.querySelector('summary');
  const resolvedSummary = resolvedDetails.querySelector('summary');
  assert.ok(dismissedSummary);
  assert.ok(resolvedSummary);

  fireEvent.click(dismissedSummary);
  fireEvent.click(resolvedSummary);

  assert.equal(dismissedDetails.open, true);
  assert.equal(resolvedDetails.open, true);
  assert.ok(screen.getByText('Dismissed review body'));
  assert.ok(screen.getByText('Resolved comment body'));
});
