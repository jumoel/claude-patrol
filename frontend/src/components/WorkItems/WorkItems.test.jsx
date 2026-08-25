import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';
import { ScratchWorkspaces } from '../ScratchWorkspaces/ScratchWorkspaces.jsx';
import { WorkItems, workItemStatus } from './WorkItems.jsx';

/** @type {import('../../types').WorkItemListItem} */
const base = {
  id: 'item-1',
  reference: 'ECO-3632',
  title: 'Repair JavaScript CVEs',
  work_provider: 'codex',
  resolver_provider: 'codex',
  state: 'ready',
  stage: 'complete',
  progress: { current: 0, total: 0 },
  repositories: ['chainguard-dev/mono'],
  updated_at: '2026-08-22T00:00:00.000Z',
  has_session_history: false,
  session: null,
  error: null,
};

test('maps every ready session state without relying on color', () => {
  assert.equal(workItemStatus(base), 'Ready');
  assert.equal(workItemStatus({ ...base, has_session_history: true }), 'Stopped');
  assert.equal(workItemStatus({ ...base, session: { id: 's', status: 'active', activity_state: null } }), 'Running');
  /** @type {Map<string, 'working' | 'idle'>} */
  const working = new Map([['work-item:item-1', 'working']]);
  /** @type {Map<string, 'working' | 'idle'>} */
  const idle = new Map([['work-item:item-1', 'idle']]);
  assert.equal(
    workItemStatus({ ...base, session: { id: 's', status: 'active', activity_state: null } }, working),
    'Working',
  );
  assert.equal(
    workItemStatus({ ...base, session: { id: 's', status: 'active', activity_state: null } }, idle),
    'Waiting',
  );
  assert.equal(
    workItemStatus(
      { ...base, session: { id: 's', status: 'active', activity_state: null } },
      idle,
      new Set(['work-item:item-1']),
    ),
    'Idle',
  );
  assert.equal(workItemStatus({ ...base, state: 'preparing' }), 'Preparing');
});

test('working work items show a spinner', () => {
  render(
    <WorkItems
      workItems={[{ ...base, session: { id: 's', status: 'active', activity_state: null } }]}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      targetStates={new Map([['work-item:item-1', 'working']])}
    />,
  );

  const badge = screen.getByText('Working');
  assert.ok(badge.querySelector('[aria-hidden="true"]'));
});

test('work-item and scratch lists contain no creation action and escape resolver text', () => {
  render(
    <>
      <WorkItems
        workItems={[{ ...base, title: '<img src=x onerror=alert(1)>' }]}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />
      <ScratchWorkspaces scratchWorkspaces={[]} />
    </>,
  );
  assert.ok(screen.getByText('<img src=x onerror=alert(1)>'));
  assert.equal(document.querySelector('img[src="x"]'), null);
  assert.ok(screen.getByText('No scratch workspaces'));
  assert.equal(screen.queryByRole('button', { name: /new|create|start/i }), null);
});
