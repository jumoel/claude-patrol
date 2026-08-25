import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import { RunStatusBadge } from './RunStatusBadge.jsx';

test('running status includes a spinner', () => {
  render(<RunStatusBadge status="running" />);
  assert.ok(screen.getByText('Running').querySelector('[data-spinner="true"]'));
});
