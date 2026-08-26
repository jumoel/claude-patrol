import { useCallback, useEffect, useState } from 'react';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import { fetchPR } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import shared from '../../styles/shared.module.css';
import { PRDetail } from '../PRDetail/PRDetail.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { WorkItemDetail } from '../WorkItemDetail/WorkItemDetail.jsx';

/**
 * A pull request keeps its canonical URL while an owning work item supplies
 * the shared task, repositories, terminal, and session history around it.
 *
 * @param {{prId: string, onBack: () => void, targetStates: Map<string, 'working' | 'idle'>}} props
 */
export function PRRouteDetail({ prId, onBack, targetStates }) {
  const [pr, setPR] = useState(/** @type {import('../../types').PullRequest | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    let active = true;
    setError('');
    fetchPR(prId)
      .then((next) => {
        if (active) setPR(next);
      })
      .catch((nextError) => {
        if (active) setError(getErrorMessage(nextError, 'Pull request not found'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [prId]);

  useEffect(load, [load]);
  useSyncEvents(load);

  if (loading) return <LoadingIndicator className={shared.loading}>Loading pull request...</LoadingIndicator>;
  if (!pr) {
    return (
      <div role="alert">
        <p>{error || 'Pull request not found'}</p>
        <Button as="a" href="#/" size="sm">
          Back to dashboard
        </Button>
      </div>
    );
  }
  if (pr.work_item_id) {
    return (
      <WorkItemDetail
        key={`${pr.work_item_id}:${prId}`}
        workItemId={pr.work_item_id}
        selectedPrId={prId}
        onBack={onBack}
        targetStates={targetStates}
      />
    );
  }
  return <PRDetail prId={prId} onBack={onBack} workspaceStates={targetStates} />;
}
