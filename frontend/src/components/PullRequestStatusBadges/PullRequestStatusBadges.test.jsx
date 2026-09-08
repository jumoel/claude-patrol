import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';
import { PullRequestStatusBadges } from './PullRequestStatusBadges.jsx';

for (const state of /** @type {const} */ (['MERGED', 'CLOSED'])) {
  test(`${state} replaces stale health badges in the inspector, list and compact dashboard`, () => {
    const pullRequest = {
      tracked: true,
      github_state: state,
      ci_status: /** @type {const} */ ('pending'),
      review_status: /** @type {const} */ ('pending'),
      mergeable: /** @type {const} */ ('UNKNOWN'),
      draft: false,
    };
    render(
      <>
        <PullRequestStatusBadges pullRequest={pullRequest} />
        <PullRequestStatusBadges pullRequest={pullRequest} includePrState={false} />
        <PullRequestStatusBadges pullRequest={pullRequest} compact />
      </>,
    );
    assert.equal(screen.getAllByLabelText(state === 'MERGED' ? 'PR Merged' : 'PR Closed').length, 3);
    assert.equal(screen.queryByLabelText('PR Open'), null);
    assert.equal(screen.queryByLabelText('CI Pending'), null);
    assert.equal(screen.queryByLabelText('Review Pending'), null);
    assert.equal(screen.queryByLabelText('Merge Unknown'), null);
  });
}
