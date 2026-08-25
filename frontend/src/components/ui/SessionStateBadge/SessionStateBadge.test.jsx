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
