import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import {
  fetchPR,
  fetchPRComments,
  linkWorkItemPullRequest,
  refreshPR,
  setPRDraft,
  unlinkWorkItemPullRequest,
} from '../../lib/api.js';
import { isFailedCheck, isMergeReady } from '../../lib/checks.js';
import { getErrorMessage } from '../../lib/errors.js';
import { workItemPath } from '../../lib/routes.js';
import { sendTerminalCommand, whenWsOpen } from '../../lib/terminal.js';
import { getRelativeTime } from '../../lib/time.js';
import {
  PullRequestChecks,
  PullRequestComments,
  PullRequestDescription,
  PullRequestReviews,
} from '../PRDetail/PRDetail.jsx';
import { RuleControls } from '../RuleControls/RuleControls.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './LinkedPullRequests.module.css';

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  pass: 'Pass',
  fail: 'Fail',
  pending: 'Pending',
  approved: 'Approved',
  changes_requested: 'Changes',
  MERGEABLE: 'Clean',
  CONFLICTING: 'Conflict',
  UNKNOWN: 'Unknown',
  open: 'Open',
  draft: 'Draft',
};

/** @param {string} status */
function statusTone(status) {
  if (['pass', 'approved', 'MERGEABLE', 'open'].includes(status)) return 'pass';
  if (['fail', 'changes_requested', 'CONFLICTING'].includes(status)) return 'fail';
  if (status === 'pending') return 'pending';
  return 'neutral';
}

/**
 * @param {{pullRequest: Pick<import('../../types').WorkItemPullRequest, 'tracked' | 'ci_status' | 'review_status' | 'mergeable' | 'draft'> | Pick<import('../../types').PullRequest, 'ci_status' | 'review_status' | 'mergeable' | 'draft'>}} props
 */
function PullRequestStatusBadges({ pullRequest }) {
  if ('tracked' in pullRequest && !pullRequest.tracked) {
    return <span className={`${styles.statusBadge} ${styles.neutral}`}>Waiting for sync</span>;
  }
  const statuses = [
    ['CI', pullRequest.ci_status],
    ['Review', pullRequest.review_status],
    ['Merge', pullRequest.mergeable],
    ['PR', pullRequest.draft ? 'draft' : 'open'],
  ];
  return (
    <span className={styles.statusBadges}>
      {statuses.map(([label, status]) => (
        <span
          key={label}
          className={`${styles.statusBadge} ${styles[statusTone(status)]}`}
          aria-label={`${label} ${STATUS_LABELS[status] || status}`}
        >
          <span>{label}</span> {STATUS_LABELS[status] || status}
        </span>
      ))}
    </span>
  );
}

/**
 * @param {{workItem: import('../../types').WorkItemDetail, selectedPrId?: string | null, onWorkItemReload: () => void, ensureSession: () => Promise<import('../../types').Session | null>, wsRef: {current: WebSocket | null}}} props
 */
export function LinkedPullRequests({ workItem, selectedPrId, onWorkItemReload, ensureSession, wsRef }) {
  const links = workItem.pull_requests;
  const selectedLink = useMemo(
    () => links.find((link) => link.id === selectedPrId) ?? links[0] ?? null,
    [links, selectedPrId],
  );
  const [pr, setPR] = useState(/** @type {import('../../types').PullRequest | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [comments, setComments] = useState(
    /** @type {import('../../types').PullRequestCommentsResponse | null} */ (null),
  );
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [togglingDraft, setTogglingDraft] = useState(false);
  const [retriggering, setRetriggering] = useState(false);
  const [actionError, setActionError] = useState('');
  const [attachValue, setAttachValue] = useState('');
  const [attaching, setAttaching] = useState(false);

  const loadSelected = useCallback(() => {
    if (!selectedLink?.tracked) {
      setPR(null);
      setLoading(false);
      setLoadError('');
      setComments(null);
      setCommentsLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setLoadError('');
    setPR(null);
    setComments(null);
    fetchPR(selectedLink.id)
      .then((next) => {
        if (active) setPR(next);
      })
      .catch((error) => {
        if (active) setLoadError(getErrorMessage(error, 'Failed to load pull request'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    setCommentsLoading(true);
    setCommentsError('');
    fetchPRComments(selectedLink.id)
      .then((next) => {
        if (active) setComments(next);
      })
      .catch((error) => {
        if (active) setCommentsError(getErrorMessage(error, 'Failed to load comments'));
      })
      .finally(() => {
        if (active) setCommentsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedLink?.id, selectedLink?.tracked]);

  useEffect(() => loadSelected(), [loadSelected]);
  useSyncEvents(loadSelected);

  const handleAttach = useCallback(
    async (/** @type {React.FormEvent<HTMLElement>} */ event) => {
      event.preventDefault();
      if (!attachValue.trim()) return;
      setAttaching(true);
      setActionError('');
      try {
        const { pull_request: linked } = await linkWorkItemPullRequest(workItem.id, attachValue.trim());
        setAttachValue('');
        onWorkItemReload();
        if (linked.tracked) window.location.hash = workItemPath(workItem.id, linked.id);
      } catch (error) {
        setActionError(getErrorMessage(error, 'Failed to attach pull request'));
      } finally {
        setAttaching(false);
      }
    },
    [attachValue, onWorkItemReload, workItem.id],
  );

  const handleDetach = useCallback(async () => {
    if (!selectedLink) return;
    if (
      !window.confirm(`Detach ${selectedLink.id} from ${workItem.reference}? The pull request will not be changed.`)
    ) {
      return;
    }
    setActionError('');
    try {
      await unlinkWorkItemPullRequest(workItem.id, selectedLink.id);
      onWorkItemReload();
      window.location.hash = workItemPath(workItem.id);
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to detach pull request'));
    }
  }, [onWorkItemReload, selectedLink, workItem.id, workItem.reference]);

  const handleRefresh = useCallback(async () => {
    if (!pr) return;
    setRefreshing(true);
    setActionError('');
    try {
      const next = await refreshPR(pr.id);
      if ('removed' in next) {
        setPR(null);
        onWorkItemReload();
      } else {
        setPR(next);
      }
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to refresh pull request'));
    } finally {
      setRefreshing(false);
    }
  }, [onWorkItemReload, pr]);

  const handleToggleDraft = useCallback(async () => {
    if (!pr) return;
    setTogglingDraft(true);
    setActionError('');
    try {
      const { draft } = await setPRDraft(pr.id, !pr.draft);
      setPR((current) => (current ? { ...current, draft } : current));
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to update draft status'));
    } finally {
      setTogglingDraft(false);
    }
  }, [pr]);

  const handleRetriggerFailed = useCallback(async () => {
    if (!pr) return;
    setRetriggering(true);
    setActionError('');
    try {
      const response = await fetch('/api/checks/retrigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_id: pr.id }),
      });
      if (!response.ok) throw new Error('Retrigger request failed');
    } catch (error) {
      setActionError(getErrorMessage(error, 'Failed to retrigger checks'));
    } finally {
      setRetriggering(false);
    }
  }, [pr]);

  const handleInvestigateFailures = useCallback(async () => {
    if (!pr) return;
    setActionError('');
    const session = await ensureSession();
    if (!session) return;
    const ws = await whenWsOpen(wsRef);
    if (!ws) {
      setActionError('The work-item terminal did not connect. Refresh and try again.');
      return;
    }
    const names = pr.checks.filter(isFailedCheck).map((check) => check.name);
    sendTerminalCommand(
      ws,
      `Investigate the failed CI checks on ${pr.id}, branch ${pr.branch}. Failed checks: ${names.join(', ')}. Read the logs and determine the root causes.`,
    );
  }, [ensureSession, pr, wsRef]);

  return (
    <div className={styles.pullRequestArea}>
      <section className={styles.relatedWork} aria-labelledby="related-work-heading">
        <div className={styles.relatedHeader}>
          <h2 id="related-work-heading">
            Related work{' '}
            <span>
              {links.length} pull request{links.length === 1 ? '' : 's'}
            </span>
          </h2>
          <details className={styles.attachDetails}>
            <summary>Attach existing PR</summary>
            <Stack as="form" gap={2} wrap className={styles.attachForm} onSubmit={handleAttach}>
              <label className={styles.attachLabel}>
                <span>PR URL or ID</span>
                <input
                  name="pull-request-reference"
                  value={attachValue}
                  onChange={(event) => setAttachValue(event.target.value)}
                  placeholder="owner/repo#123"
                  disabled={attaching}
                />
              </label>
              <Button size="sm" variant="primary" type="submit" disabled={attaching || !attachValue.trim()}>
                {attaching ? 'Attaching...' : 'Attach'}
              </Button>
            </Stack>
          </details>
        </div>
        {links.length > 0 ? (
          <ul className={styles.prList} aria-label="Work item pull requests">
            {links.map((link) => {
              const selected = link.id === selectedLink?.id;
              const statusSource = pr?.id === link.id ? pr : link;
              const title = pr?.id === link.id ? pr.title : link.title;
              return (
                <li key={link.id}>
                  <a
                    href={`#${workItemPath(workItem.id, link.id)}`}
                    className={selected ? styles.prRowSelected : styles.prRow}
                    aria-current={selected ? 'page' : undefined}
                  >
                    <span className={styles.prRowIdentity}>
                      <span className={styles.prNumber}>#{link.number}</span>
                      <span className={styles.prRowTitle}>{title || link.repository}</span>
                      <span className={styles.prRepository}>{link.repository}</span>
                    </span>
                    <PullRequestStatusBadges pullRequest={statusSource} />
                    {selected && <span className={styles.viewing}>Viewing</span>}
                  </a>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className={styles.empty}>No pull requests are attached yet.</p>
        )}
        {actionError && <p className={styles.error}>{actionError}</p>}
      </section>

      {selectedLink && !selectedLink.tracked && (
        <section className={styles.selectedInspector} aria-labelledby="selected-pr-heading">
          <div className={styles.inspectorHeader}>
            <div>
              <p className={styles.eyebrow}>Selected PR status</p>
              <h2 id="selected-pr-heading" className={styles.prTitle}>
                <a href={selectedLink.url} target="_blank" rel="noopener noreferrer">
                  #{selectedLink.number} {selectedLink.title || selectedLink.repository}
                </a>
              </h2>
              <p className={styles.identity}>{selectedLink.repository}</p>
            </div>
            <Stack gap={2} wrap className={styles.actions}>
              <Button as="a" size="sm" href={selectedLink.url} target="_blank" rel="noopener noreferrer">
                GitHub
              </Button>
              <Button size="sm" variant="danger" onClick={handleDetach}>
                Detach
              </Button>
            </Stack>
          </div>
          <div className={styles.inspectorStatuses}>
            <PullRequestStatusBadges pullRequest={selectedLink} />
            <span className={styles.waitingNote}>Attached. Status will appear after the next GitHub sync.</span>
          </div>
        </section>
      )}

      {loading && <LoadingIndicator>Loading pull request...</LoadingIndicator>}
      {loadError && <p className={styles.error}>{loadError}</p>}
      {pr && (
        <div className={styles.selectedDetails}>
          <section className={styles.selectedInspector} aria-labelledby="selected-pr-heading">
            <div className={styles.inspectorHeader}>
              <div>
                <p className={styles.eyebrow}>Selected PR status</p>
                <h2 id="selected-pr-heading" className={styles.prTitle}>
                  <a href={pr.url} target="_blank" rel="noopener noreferrer">
                    #{pr.number} {pr.title}
                  </a>
                </h2>
                <p className={styles.identity}>
                  <span className={styles.repo}>
                    {pr.org}/{pr.repo}
                  </span>
                  <span>{pr.branch}</span>
                  <span>Updated {getRelativeTime(pr.updated_at)}</span>
                </p>
              </div>
              <Stack gap={2} wrap className={styles.actions}>
                {isMergeReady(pr) && (
                  <Button
                    as="a"
                    variant="success"
                    filled
                    size="sm"
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Merge on GitHub
                  </Button>
                )}
                <Button size="sm" onClick={handleToggleDraft} disabled={togglingDraft} busy={togglingDraft}>
                  {togglingDraft ? 'Updating...' : pr.draft ? 'Mark ready' : 'Mark draft'}
                </Button>
                <Button size="sm" onClick={handleRefresh} disabled={refreshing} busy={refreshing}>
                  {refreshing ? 'Refreshing...' : 'Refresh'}
                </Button>
                <Button as="a" size="sm" href={`${pr.url}/files`} target="_blank" rel="noopener noreferrer">
                  View diff
                </Button>
                <Button as="a" size="sm" href={pr.url} target="_blank" rel="noopener noreferrer">
                  GitHub
                </Button>
                <Button size="sm" variant="danger" onClick={handleDetach}>
                  Detach
                </Button>
              </Stack>
            </div>
            <div className={styles.inspectorStatuses}>
              <PullRequestStatusBadges pullRequest={pr} />
            </div>
            {pr.body_html && <PullRequestDescription bodyHtml={pr.body_html} />}
          </section>
          <PullRequestChecks
            pr={pr}
            retriggering={retriggering}
            onRetriggerFailed={handleRetriggerFailed}
            onInvestigateFailures={handleInvestigateFailures}
          />
          <Box p={0} border bg="white" className={styles.ruleControls}>
            <RuleControls prId={pr.id} />
          </Box>
          <PullRequestReviews reviews={pr.reviews} />
          <PullRequestComments comments={comments} loading={commentsLoading} />
          {commentsError && <p className={styles.error}>{commentsError}</p>}
        </div>
      )}
    </div>
  );
}
