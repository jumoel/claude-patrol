import assert from 'node:assert/strict';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { PRRouteDetail } from './PRRouteDetail.jsx';

const api = vi.hoisted(() => ({ fetchPR: vi.fn() }));

vi.mock('../../lib/api.js', () => api);
vi.mock('../../hooks/useSyncEvents.js', () => ({ useSyncEvents: () => {} }));

beforeEach(() => {
  api.fetchPR.mockReset();
  window.location.hash = '';
});

test('replaces an attached pull-request route with its owning work-item route', async () => {
  api.fetchPR.mockResolvedValue({ id: 'acme/widgets#42', work_item_id: 'item-1' });
  window.location.hash = '#/pr/acme%2Fwidgets%2342';

  render(
    <PRRouteDetail
      prId="acme/widgets#42"
      onBack={vi.fn()}
      targetStates={new Map()}
      acknowledgedSessionIds={new Set()}
      onAcknowledgeSession={vi.fn()}
    />,
  );

  await waitFor(() => assert.equal(window.location.hash, '#/work-item/item-1?pr=acme%2Fwidgets%2342'));
});
