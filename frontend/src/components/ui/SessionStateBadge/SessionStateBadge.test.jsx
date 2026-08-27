import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import { SessionStateBadge } from './SessionStateBadge.jsx';

test('owns every reported session activity state', () => {
  const { rerender } = render(<SessionStateBadge state="working" />);
  assert.ok(screen.getByText('Working').querySelector('[data-spinner="true"]'));

  rerender(<SessionStateBadge state="idle" />);
  assert.ok(screen.getByText('Waiting'));

  rerender(<SessionStateBadge state="idle" dismissed />);
  assert.ok(screen.getByText('Idle'));
});

test('renders resolved attention states for detail-page headers', () => {
  const { rerender } = render(<SessionStateBadge attentionState="working" className="detail-status" />);
  assert.ok(screen.getByText('Working').classList.contains('detail-status'));

  rerender(<SessionStateBadge attentionState="waiting" className="detail-status" />);
  assert.equal(screen.getByText('Waiting').getAttribute('title'), 'Session waiting for input - needs attention');
  assert.ok(screen.getByText('Waiting').classList.contains('detail-status'));

  rerender(<SessionStateBadge attentionState="idle" className="detail-status" />);
  assert.equal(screen.getByText('Idle').getAttribute('title'), 'Session idle (already seen)');
  assert.ok(screen.getByText('Idle').classList.contains('detail-status'));
});
