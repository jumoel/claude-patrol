import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import {
  createSession as apiCreateSession,
  createWorkspace as apiCreateWorkspace,
  killSession as apiKillSession,
  reattachSession as apiReattachSession,
  fetchCheckLogs,
  fetchPR,
  fetchPRComments,
  fetchSessions,
  fetchWorkspaces,
  refreshPR,
  setPRDraft,
} from '../../lib/api.js';
import {
  isMergeReady as checkMergeReady,
  checkToStatus,
  isFailedCheck,
  isPassedCheck,
  isRunningCheck,
  isScheduledCheck,
  statusColorGroup,
} from '../../lib/checks.js';
import { getErrorMessage } from '../../lib/errors.js';
import { sendTerminalCommand, whenWsOpen } from '../../lib/terminal.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { CheckLogViewer } from '../CheckLogViewer/CheckLogViewer.jsx';
import { CommentsList } from '../CommentsList/CommentsList.jsx';
import { PullRequestStatusBadges } from '../PullRequestStatusBadges/PullRequestStatusBadges.jsx';
import { RenderedHtml } from '../RenderedHtml/RenderedHtml.jsx';
import { RuleControls } from '../RuleControls/RuleControls.jsx';
import { SessionHistory } from '../SessionHistory/SessionHistory.jsx';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import workPage from '../WorkPage/WorkPage.module.css';
import { WorkspaceControls } from '../WorkspaceControls/WorkspaceControls.jsx';
import styles from './PRDetail.module.css';

const DOT_STYLES = {
  green: styles.dotPass,
  red: styles.dotFail,
  blue: styles.dotRunning,
  yellow: styles.dotScheduled,
  gray: styles.dotScheduled,
};

/** @type {Record<string, string>} */
const CHECK_STATUS_LABELS = {
  SUCCESS: 'success',
  NEUTRAL: 'neutral',
  SKIPPED: 'skipped',
  FAILURE: 'failure',
  ERROR: 'error',
  TIMED_OUT: 'timed out',
  IN_PROGRESS: 'running',
  QUEUED: 'queued',
  WAITING: 'waiting',
  PENDING: 'pending',
  REQUESTED: 'requested',
  EXPECTED: 'expected',
};

/**
 * PR detail view with workspace and terminal management.
 * @param {{
 *   prId: string,
 *   onBack: () => void,
 *   workspaceStates: Map<string, 'working' | 'idle'>,
 * }} props
 */
export function PRDetail({ prId, onBack, workspaceStates }) {
  const { provider } = useAgentProvider();
  const [pr, setPR] = useState(/** @type {import('../../types').PullRequest | null} */ (null));
  const [workspace, setWorkspace] = useState(/** @type {import('../../types').Workspace | null} */ (null));
  const [session, setSession] = useState(/** @type {import('../../types').Session | null} */ (null));
  const [comments, setComments] = useState(
    /** @type {import('../../types').PullRequestCommentsResponse | null} */ (null),
  );
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [commentsError, setCommentsError] = useState('');
  const [actionError, setActionError] = useState('');
  const [openingSession, setOpeningSession] = useState(false);
  const [openingStep, setOpeningStep] = useState('');
  const [openingError, setOpeningError] = useState('');
  const [retriggering, setRetriggering] = useState(false);
  const [copiedBranch, setCopiedBranch] = useState(false);
  const [togglingDraft, setTogglingDraft] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const wsRef = useRef(/** @type {WebSocket | null} */ (null));

  /** Deduped workspace creation promise so both buttons share a single in-flight request. */
  const workspacePromiseRef = useRef(/** @type {Promise<import('../../types').Workspace> | null} */ (null));

  const loadData = useCallback(async () => {
    setLoadError('');
    try {
      const [prData, workspaces] = await Promise.all([fetchPR(prId), fetchWorkspaces(prId)]);
      setPR(prData);
      const active = workspaces[0] || null;
      setWorkspace(active);
      if (active) {
        const sessions = await fetchSessions({ type: 'workspace', id: active.id });
        setSession(sessions[0] || null);
      } else {
        setSession(null);
      }
    } catch (err) {
      setPR(null);
      setLoadError(getErrorMessage(err, 'Failed to load pull request'));
    } finally {
      setLoading(false);
    }
    // Fetch comments in parallel (non-blocking)
    setCommentsLoading(true);
    setCommentsError('');
    fetchPRComments(prId)
      .then(setComments)
      .catch((err) => {
        setComments(null);
        setCommentsError(getErrorMessage(err, 'Failed to load comments'));
      })
      .finally(() => setCommentsLoading(false));
  }, [prId]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useSyncEvents(loadData);

  /**
   * Get or create a workspace, deduping concurrent requests.
   * Workspace creation and agent launch share this so clicking
   * either one while the other is in-flight reuses the same promise.
   */
  const getOrCreateWorkspace = useCallback(async () => {
    if (workspace) return workspace;
    if (workspacePromiseRef.current) return workspacePromiseRef.current;
    const promise = apiCreateWorkspace(prId)
      .then((ws) => {
        setWorkspace(ws);
        workspacePromiseRef.current = null;
        return ws;
      })
      .catch((err) => {
        workspacePromiseRef.current = null;
        throw err;
      });
    workspacePromiseRef.current = promise;
    return promise;
  }, [prId, workspace]);

  /** Ensure workspace + session exist, creating them if needed. Returns { ws, sess } or null on failure. */
  const ensureWorkspaceAndSession = useCallback(async () => {
    setOpeningSession(true);
    setOpeningError('');
    try {
      setOpeningStep('Creating workspace...');
      const ws = await getOrCreateWorkspace();
      let sess = session;
      if (!sess) {
        setOpeningStep('Starting session...');
        sess = await apiCreateSession({ type: 'workspace', id: ws.id }, provider);
        setSession(sess);
      }
      setOpeningStep('Connecting...');
      return { ws, sess };
    } catch (err) {
      setOpeningError(getErrorMessage(err, `Failed to start ${provider === 'codex' ? 'Codex' : 'Claude'}`));
      return null;
    } finally {
      setOpeningSession(false);
      setOpeningStep('');
    }
  }, [getOrCreateWorkspace, provider, session]);

  const handleOpenInAgent = useCallback(async () => {
    await ensureWorkspaceAndSession();
  }, [ensureWorkspaceAndSession]);

  const handleRetriggerFailed = useCallback(async () => {
    if (!pr) return;
    setRetriggering(true);
    setActionError('');
    try {
      const res = await fetch('/api/checks/retrigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_id: prId }),
      });
      if (!res.ok) throw new Error('Retrigger failed');
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to retrigger checks'));
    } finally {
      setRetriggering(false);
    }
  }, [pr, prId]);

  const handleKillSession = useCallback(async () => {
    if (!session) return;
    setActionError('');
    try {
      await apiKillSession(session.id);
      setSession(null);
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to stop terminal'));
    }
  }, [session]);

  const handleSessionExit = useCallback(() => {
    setSession(null);
  }, []);

  const handleReattach = useCallback(async () => {
    if (!session) return;
    setActionError('');
    try {
      const updated = await apiReattachSession(session.id);
      setSession(updated);
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to reattach terminal'));
    }
  }, [session]);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setActionError('');
    try {
      const fresh = await refreshPR(prId);
      // Server tore down the row because the PR is merged/closed. Surface
      // that and go back to the dashboard - there's nothing left to view.
      if ('removed' in fresh) {
        alert(`This PR is ${fresh.state.toLowerCase()}; it's been removed from the dashboard.`);
        onBack();
        return;
      }
      setPR(fresh);
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to refresh pull request'));
    } finally {
      setRefreshing(false);
    }
  }, [prId, refreshing, onBack]);

  const handleToggleDraft = useCallback(async () => {
    if (!pr) return;
    setTogglingDraft(true);
    setActionError('');
    try {
      const { draft } = await setPRDraft(prId, !pr.draft);
      setPR((prev) => (prev ? { ...prev, draft } : prev));
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to update draft status'));
    } finally {
      setTogglingDraft(false);
    }
  }, [pr, prId]);

  const handleInvestigateFailures = useCallback(async () => {
    if (!pr) return;
    setActionError('');
    const failedCheckNames = pr.checks.filter(isFailedCheck).map((c) => c.name);

    const result = await ensureWorkspaceAndSession();
    if (!result) return;

    // Wait for the Terminal component to mount and finish its WS handshake
    // before sending. Previously a hopeful 500ms setTimeout that silently
    // dropped commands when the handshake took longer (slow tab, slow tmux).
    const ws = await whenWsOpen(wsRef);
    if (!ws) {
      setActionError('The PR terminal did not connect. Refresh and try again.');
      return;
    }

    const command = `Investigate the failed CI checks on this PR (${pr.org}/${pr.repo}#${pr.number}, branch: ${pr.branch}). The following checks failed: ${failedCheckNames.join(', ')}. Look at the CI logs and determine root causes.`;
    sendTerminalCommand(ws, command);
  }, [pr, ensureWorkspaceAndSession]);

  if (loading) {
    return <LoadingIndicator className={shared.loading}>Loading pull request...</LoadingIndicator>;
  }

  if (!pr) {
    return (
      <div className={workPage.unavailable} role="alert">
        <span>{loadError || 'Pull request not found'}</span>
        <Button as="a" href="#/" size="sm">
          Back to work
        </Button>
      </div>
    );
  }

  const isMergeReady = checkMergeReady(pr);

  return (
    <div className={workPage.page}>
      <header className={workPage.header}>
        <div className={workPage.headerActions}>
          <Button size="sm" onClick={onBack}>
            &larr; Work
          </Button>
          <Stack gap={2} wrap className={styles.actionBar}>
            {isMergeReady && (
              <Button
                as="a"
                variant="success"
                size="sm"
                filled
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.mergeButton}
                onClick={(e) => e.stopPropagation()}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M5 3.254V3.25v.005a.75.75 0 110-.005v.004zm.45 1.9a2.25 2.25 0 10-1.95.218v5.256a2.25 2.25 0 101.5 0V7.123A5.735 5.735 0 009.25 9h1.378a2.251 2.251 0 100-1.5H9.25a4.25 4.25 0 01-3.8-2.346zM12.75 9a.75.75 0 100-1.5.75.75 0 000 1.5zm-8.5 4.5a.75.75 0 100-1.5.75.75 0 000 1.5z"
                  />
                </svg>
                Merge on GitHub
              </Button>
            )}
            <Button
              variant={pr.draft ? 'success' : 'default'}
              size="sm"
              filled={pr.draft}
              onClick={handleToggleDraft}
              disabled={togglingDraft}
              busy={togglingDraft}
              type="button"
            >
              {togglingDraft ? 'Updating draft...' : pr.draft ? 'Mark ready' : 'Mark draft'}
            </Button>
            <Button
              size="sm"
              onClick={handleRefresh}
              disabled={refreshing}
              busy={refreshing}
              type="button"
              title="Refetch this PR from GitHub now"
            >
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </Button>
            <Button as="a" size="sm" href={`${pr.url}/files`} target="_blank" rel="noopener noreferrer">
              View diff
            </Button>
            <Button as="a" size="sm" href={pr.url} target="_blank" rel="noopener noreferrer">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              GitHub
            </Button>
          </Stack>
        </div>
        <div className={workPage.kicker}>
          <a href={pr.url} target="_blank" rel="noopener noreferrer">
            {pr.org}/{pr.repo} #{pr.number}
          </a>
        </div>
        <h1 className={workPage.title}>{pr.title}</h1>
        <div className={workPage.identity}>
          <button
            title="Copy branch name"
            onClick={() => {
              navigator.clipboard.writeText(pr.branch);
              setCopiedBranch(true);
              setTimeout(() => setCopiedBranch(false), 1500);
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"
              />
            </svg>
            {pr.branch}
            {copiedBranch && <span className={styles.copiedToast}>Copied!</span>}
          </button>
          <span>Updated {getRelativeTime(pr.updated_at)}</span>
        </div>
        <div className={workPage.statusRow}>
          <PullRequestStatusBadges pullRequest={pr} />
        </div>
        {pr.is_stacked && <StackInfo pr={pr} />}
        {pr.labels.length > 0 && (
          <Stack gap={2} wrap className={styles.labels}>
            {pr.labels.map((label) => (
              <span
                key={label.name}
                className={styles.label}
                style={{
                  backgroundColor: `#${label.color}20`,
                  borderColor: `#${label.color}`,
                  color: `#${label.color}`,
                }}
              >
                {label.name}
              </span>
            ))}
          </Stack>
        )}
      </header>

      {session ? (
        <TerminalCard
          session={session}
          title={`Terminal - ${pr.org}/${pr.repo} #${pr.number}`}
          onKill={handleKillSession}
          onExit={handleSessionExit}
          onReattach={handleReattach}
          wsRef={wsRef}
          baseBranch={pr.base_branch}
          workspaceId={workspace?.id}
          prId={pr.id}
          sessionState={workspace ? workspaceStates.get(`workspace:${workspace.id}`) : undefined}
          presentation="work-page"
        />
      ) : (
        <section className={workPage.terminalLauncher} aria-labelledby="pr-terminal-heading">
          <h2 id="pr-terminal-heading">Terminal</h2>
          <p className={workPage.launcherCopy}>Start an agent here, or prepare the workspace without a session.</p>
          <Stack gap={2} wrap>
            <AgentProviderButton
              variant="primary"
              size="lg"
              onClick={handleOpenInAgent}
              disabled={openingSession}
              busy={openingSession}
            >
              {openingSession ? openingStep : `Open in ${provider === 'codex' ? 'Codex' : 'Claude'}`}
            </AgentProviderButton>
            <WorkspaceControls
              prId={prId}
              workspace={workspace}
              onUpdate={loadData}
              getOrCreateWorkspace={getOrCreateWorkspace}
              sessionWaiting={openingSession && !workspace}
            />
          </Stack>
        </section>
      )}

      {workspace && session && (
        <section className={workPage.sectionHeader} aria-labelledby="pr-workspace-heading">
          <h2 id="pr-workspace-heading">Workspace</h2>
          <WorkspaceControls
            prId={prId}
            workspace={workspace}
            onUpdate={loadData}
            getOrCreateWorkspace={getOrCreateWorkspace}
          />
        </section>
      )}

      {openingError && (
        <p className={workPage.error} role="alert">
          {openingError}
        </p>
      )}
      {actionError && (
        <p className={workPage.error} role="alert">
          {actionError}
        </p>
      )}

      <PullRequestChecks
        pr={pr}
        retriggering={retriggering}
        onRetriggerFailed={handleRetriggerFailed}
        onInvestigateFailures={handleInvestigateFailures}
      />

      <section className={styles.ruleControls} aria-label="Rules">
        <RuleControls prId={prId} />
      </section>

      {pr.body_html && (
        <section className={workPage.section} aria-label="Pull request description">
          <PullRequestDescription bodyHtml={pr.body_html} />
        </section>
      )}

      {workspace && <SessionHistory key={workspace.id} target={{ type: 'workspace', id: workspace.id }} />}
      <PullRequestReviews reviews={pr.reviews} />
      <PullRequestComments comments={comments} loading={commentsLoading} />
      {commentsError && (
        <p className={workPage.error} role="alert">
          {commentsError}
        </p>
      )}
    </div>
  );
}

/**
 * @param {{pr: import('../../types').PullRequest, retriggering?: boolean, onRetriggerFailed?: () => void, onInvestigateFailures?: () => void}} props
 */
export function PullRequestChecks({ pr, retriggering, onRetriggerFailed, onInvestigateFailures }) {
  const failedChecks = pr.checks.filter(isFailedCheck);
  const passedChecks = pr.checks.filter(isPassedCheck);
  const runningChecks = pr.checks.filter(isRunningCheck);
  const scheduledChecks = pr.checks.filter(isScheduledCheck);
  if (pr.checks.length === 0) return null;
  return (
    <section className={shared.sectionCard} aria-label="Checks">
      <Stack justify="between" wrap gap={3} className={shared.sectionHeader}>
        <Stack gap={3} as="h3" className={shared.sectionHeaderTitle}>
          Checks
          <Stack gap={2} as="span">
            {passedChecks.length > 0 && <span className={styles.summaryPass}>{passedChecks.length} passed</span>}
            {failedChecks.length > 0 && <span className={styles.summaryFail}>{failedChecks.length} failed</span>}
            {runningChecks.length > 0 && <span className={styles.summaryRunning}>{runningChecks.length} running</span>}
            {scheduledChecks.length > 0 && (
              <span className={styles.summaryScheduled}>{scheduledChecks.length} queued</span>
            )}
          </Stack>
        </Stack>
        {failedChecks.length > 0 && (onRetriggerFailed || onInvestigateFailures) && (
          <Stack gap={2}>
            {onRetriggerFailed && (
              <Button
                variant="warning"
                size="sm"
                onClick={onRetriggerFailed}
                disabled={retriggering}
                busy={retriggering}
              >
                {retriggering ? 'Retriggering...' : 'Retrigger failed'}
              </Button>
            )}
            {onInvestigateFailures && (
              <Button variant="primary" size="sm" onClick={onInvestigateFailures}>
                Investigate failures
              </Button>
            )}
          </Stack>
        )}
      </Stack>
      <div className={shared.sectionBody}>
        <Stack direction="col" gap={3}>
          {failedChecks.length > 0 && (
            <div className={styles.checkGroup}>
              {failedChecks.map((check, index) => (
                <CheckRow key={`fail-${index}`} check={check} prId={pr.id} />
              ))}
            </div>
          )}
          {runningChecks.length > 0 && (
            <div className={styles.checkGroup}>
              {runningChecks.map((check, index) => (
                <CheckRow key={`running-${index}`} check={check} />
              ))}
            </div>
          )}
          {scheduledChecks.length > 0 && (
            <div className={styles.checkGroup}>
              {scheduledChecks.map((check, index) => (
                <CheckRow key={`scheduled-${index}`} check={check} />
              ))}
            </div>
          )}
          {passedChecks.length > 0 && <PassedChecksGroup checks={passedChecks} />}
        </Stack>
      </div>
    </section>
  );
}

/** @param {{reviews: import('../../types').PullRequestReview[]}} props */
export function PullRequestReviews({ reviews }) {
  if (reviews.length === 0) return null;
  return (
    <section className={shared.sectionCard} aria-label="Reviews">
      <div className={shared.sectionHeader}>
        <h3 className={shared.sectionHeaderTitle}>
          Reviews <span className={shared.sectionHeaderMeta}>{reviews.length}</span>
        </h3>
      </div>
      <div className={shared.sectionBody}>
        <div className={styles.reviewsList}>
          {reviews.map((review, index) => (
            <div key={`${review.reviewer}:${index}`} className={styles.reviewRow}>
              <span className={styles.reviewerName}>{review.reviewer}</span>
              <span
                className={`${styles.reviewState} ${review.state === 'APPROVED' ? styles.reviewApproved : review.state === 'CHANGES_REQUESTED' ? styles.reviewChanges : styles.reviewComment}`}
              >
                {review.state.toLowerCase().replace('_', ' ')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** @param {{comments: import('../../types').PullRequestCommentsResponse | null, loading: boolean}} props */
export function PullRequestComments({ comments, loading }) {
  if (!loading && !comments) return null;
  return (
    <section className={shared.sectionCard} aria-label="Comments">
      <div className={shared.sectionHeader}>
        <h3 className={shared.sectionHeaderTitle}>Comments</h3>
      </div>
      <div className={shared.sectionBody}>
        <CommentsList reviews={comments?.reviews} conversation={comments?.conversation} loading={loading} />
      </div>
    </section>
  );
}

/** @param {{ check: import('../../types').Check, prId?: string }} props */
function CheckRow({ check, prId }) {
  const status = checkToStatus(check);
  const colorGroup = statusColorGroup(status);
  const dotClass = DOT_STYLES[colorGroup] || styles.dotScheduled;
  const isFailed = isFailedCheck(check);
  const [jobLogs, setJobLogs] = useState(/** @type {import('../../types').CheckLog[] | null} */ (null));
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState(/** @type {string | null} */ (null));
  const [showLog, setShowLog] = useState(false);

  const handleViewLog = useCallback(async () => {
    setShowLog((prev) => !prev);
  }, []);

  // Fetch log data when first shown
  useEffect(() => {
    if (!showLog || jobLogs || logLoading || logError) return;

    const match = check.url?.match(/\/actions\/runs\/(\d+)/);
    const runId = match?.[1];
    if (!prId || !runId) {
      setLogError(!prId ? 'No PR ID available' : 'No run ID found in check URL');
      return;
    }

    setLogLoading(true);
    fetchCheckLogs(prId, runId)
      .then((data) => {
        const validLogs = data.logs?.filter((l) => !l.error) ?? [];
        const errors = data.logs?.filter((l) => l.error).map((l) => l.error) ?? [];
        if (validLogs.length > 0) setJobLogs(validLogs);
        else if (errors.length > 0) setLogError(errors.join('; '));
        else setLogError('No log data returned');
      })
      .catch((err) => setLogError(err.message))
      .finally(() => setLogLoading(false));
  }, [showLog, jobLogs, logLoading, logError, check.url, prId]);

  return (
    <div>
      <div className={styles.checkRow}>
        <Stack gap={2} className={styles.checkInfo}>
          <span className={`${styles.checkDot} ${dotClass}`} />
          {check.url ? (
            <a href={check.url} target="_blank" rel="noopener noreferrer" className={styles.checkName}>
              {check.name}
            </a>
          ) : (
            <span className={styles.checkNamePlain}>{check.name}</span>
          )}
        </Stack>
        <Stack gap={2}>
          {isFailed && prId && (
            <Button size="xs" onClick={handleViewLog}>
              {showLog ? 'Hide log' : 'View log'}
            </Button>
          )}
          <Badge color={colorGroup} border={false}>
            {CHECK_STATUS_LABELS[status] || status.toLowerCase()}
          </Badge>
        </Stack>
      </div>
      {showLog &&
        jobLogs?.map((job, i) => (
          <div key={i}>
            {jobLogs.length > 1 && <div className={styles.jobLogLabel}>{job.job_name || `Job ${i + 1}`}</div>}
            <CheckLogViewer log={job.log ?? null} truncated={job.truncated ?? false} loading={false} error={null} />
          </div>
        ))}
      {showLog && !jobLogs && <CheckLogViewer log={null} truncated={false} loading={logLoading} error={logError} />}
    </div>
  );
}

/** @param {{checks: import('../../types').Check[]}} props */
function PassedChecksGroup({ checks }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.checkGroup}>
      <button className={styles.toggleButton} onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Hide' : 'Show'} {checks.length} passed checks
      </button>
      {expanded && checks.map((c, i) => <CheckRow key={`pass-${i}`} check={c} />)}
    </div>
  );
}

/** @param {{pr: import('../../types').PullRequest}} props */
function StackInfo({ pr }) {
  const parentId = pr.stack_parent;
  const childIds = pr.stack_children || [];
  const { stack_position: pos, stack_size: size } = pr;

  /** Extract display label from PR id (e.g. "org/repo#123" -> "#123") */
  /** @param {string} id */
  const prLabel = (id) => {
    const match = id.match(/#(\d+)$/);
    return match ? `#${match[1]}` : id;
  };

  /** @param {string} id */
  const navigateTo = (id) => {
    window.location.hash = `/pr/${encodeURIComponent(id)}`;
  };

  return (
    <div className={styles.stackInfoBar}>
      <span className={styles.stackInfoNode}>{pos}</span>
      <span className={styles.stackInfoLabel}>
        {pos} of {size} in stack
      </span>
      {parentId && (
        <span className={styles.stackInfoItem}>
          Based on{' '}
          <button className={styles.stackLink} onClick={() => navigateTo(parentId)}>
            {prLabel(parentId)}
          </button>
        </span>
      )}
      {!parentId && <span className={styles.stackInfoItem}>Base: {pr.base_branch}</span>}
      {childIds.length > 0 && (
        <span className={styles.stackInfoItem}>
          Parent of{' '}
          {childIds.map((id, i) => (
            <span key={id}>
              {i > 0 && ', '}
              <button className={styles.stackLink} onClick={() => navigateTo(id)}>
                {prLabel(id)}
              </button>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** @param {{bodyHtml: string}} props */
export function PullRequestDescription({ bodyHtml }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.description}>
      <button className={styles.descriptionToggle} onClick={() => setExpanded(!expanded)}>
        <span className={styles.descriptionLabel}>Description</span>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}>&#x25B8;</span>
      </button>
      {expanded && <RenderedHtml html={bodyHtml} className={styles.descriptionBody} />}
    </div>
  );
}
