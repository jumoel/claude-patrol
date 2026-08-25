import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import { WorkItemStatusBadge } from './WorkItemStatusBadge.jsx';

test.each(['Working', 'Resolving', 'Preparing', 'Destroying'])('%s status includes a spinner', (status) => {
  render(<WorkItemStatusBadge status={status} />);
  assert.ok(screen.getByText(status).querySelector('[data-spinner="true"]'));
});

test.each(['Ready', 'Stopped', 'Waiting', 'Idle', 'Failed', 'Destroyed'])('%s status stays static', (status) => {
  render(<WorkItemStatusBadge status={status} />);
  assert.equal(screen.getByText(status).querySelector('[data-spinner="true"]'), null);
});
