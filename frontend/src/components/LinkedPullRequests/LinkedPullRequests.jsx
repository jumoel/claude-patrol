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
import { sendTerminalCommand, whenWsOpen } from '../../lib/terminal.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import {
  PullRequestChecks,
  PullRequestComments,
  PullRequestDescription,
  PullRequestReviews,
} from '../PRDetail/PRDetail.jsx';
import { RuleControls } from '../RuleControls/RuleControls.jsx';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './LinkedPullRequests.module.css';

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
        if (linked.tracked) window.location.hash = `/pr/${encodeURIComponent(linked.id)}`;
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
      window.location.hash = `/work-item/${workItem.id}`;
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
    <Stack direction="col" gap={4}>
      <Box p={4} border rounded="lg" bg="white" className={shared.sectionCard}>
        <Stack direction="col" gap={3}>
          <Stack justify="between" gap={3} wrap>
            <Stack direction="col" gap={1}>
              <h3 className={shared.sectionTitle}>Pull requests</h3>
              <p className={styles.ownerNote}>Owned by {workItem.reference} and using its shared terminal.</p>
            </Stack>
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
          </Stack>
          {links.length > 0 ? (
            <nav className={styles.prTabs} aria-label="Work item pull requests">
              {links.map((link) => (
                <a
                  key={link.id}
                  href={`#/pr/${encodeURIComponent(link.id)}`}
                  className={`${styles.prTab} ${link.id === selectedLink?.id ? styles.prTabActive : ''}`}
                  aria-current={link.id === selectedLink?.id ? 'page' : undefined}
                >
                  <span>
                    {link.repository} #{link.number}
                  </span>
                  {link.tracked ? <StatusBadge status={link.ci_status} type="ci" /> : <span>Waiting for sync</span>}
                </a>
              ))}
            </nav>
          ) : (
            <p className={styles.empty}>No pull requests are attached yet.</p>
          )}
          {actionError && <p className={styles.error}>{actionError}</p>}
        </Stack>
      </Box>

      {selectedLink && !selectedLink.tracked && (
        <Box p={5} border rounded="lg" bg="white">
          <Stack justify="between" gap={3} wrap>
            <div>
              <h3 className={shared.sectionTitle}>{selectedLink.id}</h3>
              <p className={styles.ownerNote}>Attached. Waiting for the next GitHub sync.</p>
            </div>
            <Stack gap={2}>
              <Button as="a" size="sm" href={selectedLink.url} target="_blank" rel="noopener noreferrer">
                GitHub
              </Button>
              <Button size="sm" variant="danger" onClick={handleDetach}>
                Detach
              </Button>
            </Stack>
          </Stack>
        </Box>
      )}

      {loading && <LoadingIndicator>Loading pull request...</LoadingIndicator>}
      {loadError && <p className={styles.error}>{loadError}</p>}
      {pr && (
        <>
          <Box p={5} border rounded="lg" bg="white" className={shared.sectionCard}>
            <Stack direction="col" gap={3}>
              <Stack justify="between" gap={3} wrap>
                <div>
                  <p className={styles.eyebrow}>Pull request</p>
                  <h3 className={styles.prTitle}>{pr.title}</h3>
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
              </Stack>
              <Stack gap={2} wrap className={styles.identity}>
                <span className={styles.repo}>
                  {pr.org}/{pr.repo} #{pr.number}
                </span>
                <span>{pr.branch}</span>
                <span>Updated {getRelativeTime(pr.updated_at)}</span>
              </Stack>
              <Stack gap={4} wrap>
                <StatusFact label="CI" status={pr.ci_status} type="ci" />
                <StatusFact label="Review" status={pr.review_status} type="review" />
                <StatusFact label="Merge" status={pr.mergeable} type="merge" />
                <StatusFact label="PR" status={pr.draft ? 'draft' : 'open'} type="status" />
              </Stack>
              {pr.body_html && <PullRequestDescription bodyHtml={pr.body_html} />}
            </Stack>
          </Box>
          <Box p={0} border rounded="lg" bg="white" className={shared.sectionCard}>
            <RuleControls prId={pr.id} />
          </Box>
          <PullRequestChecks
            pr={pr}
            retriggering={retriggering}
            onRetriggerFailed={handleRetriggerFailed}
            onInvestigateFailures={handleInvestigateFailures}
          />
          <PullRequestReviews reviews={pr.reviews} />
          <PullRequestComments comments={comments} loading={commentsLoading} />
          {commentsError && <p className={styles.error}>{commentsError}</p>}
        </>
      )}
    </Stack>
  );
}

/** @param {{label: string, status: string, type: 'ci' | 'review' | 'merge' | 'status'}} props */
function StatusFact({ label, status, type }) {
  return (
    <Stack gap={2}>
      <span className={styles.statusLabel}>{label}</span>
      <StatusBadge status={status} type={type} />
    </Stack>
  );
}
