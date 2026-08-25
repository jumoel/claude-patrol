import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import { LoadingIndicator } from './LoadingIndicator.jsx';

test('loading messages own a spinner and live-region role', () => {
  render(<LoadingIndicator>Loading records...</LoadingIndicator>);
  const indicator = screen.getByRole('status');
  assert.ok(indicator.querySelector('[data-spinner="true"]'));
});
