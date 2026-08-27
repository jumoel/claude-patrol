import { useCallback, useEffect, useState } from 'react';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import { fetchPR } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { workItemPath } from '../../lib/routes.js';
import shared from '../../styles/shared.module.css';
import { PRDetail } from '../PRDetail/PRDetail.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';

/**
 * @param {{
 *   prId: string,
 *   onBack: () => void,
 *   targetStates: Map<string, 'working' | 'idle'>,
 *   acknowledgedSessionIds: Set<string>,
 *   onAcknowledgeSession: (sessionId: string) => void,
 * }} props
 */
export function PRRouteDetail({ prId, onBack, targetStates, acknowledgedSessionIds, onAcknowledgeSession }) {
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

  useEffect(() => {
    if (pr?.work_item_id) window.location.replace(`#${workItemPath(pr.work_item_id, prId)}`);
  }, [pr?.work_item_id, prId]);

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
    return <LoadingIndicator className={shared.loading}>Opening work item...</LoadingIndicator>;
  }
  return (
    <PRDetail
      prId={prId}
      onBack={onBack}
      workspaceStates={targetStates}
      acknowledgedSessionIds={acknowledgedSessionIds}
      onAcknowledgeSession={onAcknowledgeSession}
    />
  );
}
