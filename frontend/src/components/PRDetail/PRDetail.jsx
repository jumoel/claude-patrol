import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import {
  createSession as apiCreateSession,
  createWorkspace as apiCreateWorkspace,
  killSession as apiKillSession,
  reattachSession as apiReattachSession,
  fetchCheckLogs,
  fetchPR,
  fetchPRComments,
  fetchSessionHistory,
  fetchSessions,
  fetchSessionTranscript,
  fetchWorkspaces,
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
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import { CheckLogViewer } from '../CheckLogViewer/CheckLogViewer.jsx';
import { CommentsList } from '../CommentsList/CommentsList.jsx';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { TranscriptViewer } from '../TranscriptViewer/TranscriptViewer.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import { WorkspaceControls } from '../WorkspaceControls/WorkspaceControls.jsx';
import styles from './PRDetail.module.css';

const DOT_STYLES = {
  green: styles.dotPass,
  red: styles.dotFail,
  blue: styles.dotRunning,
  yellow: styles.dotScheduled,
  gray: styles.dotScheduled,
};

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
 * @param {{ prId: string, onBack: () => void }} props
 */
export function PRDetail({ prId, onBack }) {
  const [pr, setPR] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [session, setSession] = useState(null);
  const [comments, setComments] = useState(null);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [openingClaude, setOpeningClaude] = useState(false);
  const [openingStep, setOpeningStep] = useState('');
  const [retriggering, setRetriggering] = useState(false);
  const [copiedBranch, setCopiedBranch] = useState(false);
  const [togglingDraft, setTogglingDraft] = useState(false);
  const wsRef = useRef(null);

  /** Deduped workspace creation promise so both buttons share a single in-flight request. */
  const workspacePromiseRef = useRef(null);

  const loadData = useCallback(async () => {
    try {
      const [prData, workspaces] = await Promise.all([fetchPR(prId), fetchWorkspaces(prId)]);
      setPR(prData);
      const active = workspaces[0] || null;
      setWorkspace(active);
      if (active) {
        const sessions = await fetchSessions(active.id);
        setSession(sessions[0] || null);
      } else {
        setSession(null);
      }
    } catch (err) {
      console.error('Failed to load PR data:', err);
    } finally {
      setLoading(false);
    }
    // Fetch comments in parallel (non-blocking)
    setCommentsLoading(true);
    fetchPRComments(prId)
      .then(setComments)
      .catch((err) => console.error('Failed to load comments:', err))
      .finally(() => setCommentsLoading(false));
  }, [prId]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useSyncEvents(loadData);

  /**
   * Get or create a workspace, deduping concurrent requests.
   * Both "Create Workspace" and "Open in Claude" share this so clicking
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
    setOpeningClaude(true);
    try {
      setOpeningStep('Creating workspace...');
      const ws = await getOrCreateWorkspace();
      let sess = session;
      if (!sess) {
        setOpeningStep('Starting session...');
        sess = await apiCreateSession(ws.id);
        setSession(sess);
      }
      setOpeningStep('Connecting...');
      return { ws, sess };
    } catch (err) {
      console.error('Failed to set up workspace/session:', err);
      return null;
    } finally {
      setOpeningClaude(false);
      setOpeningStep('');
    }
  }, [getOrCreateWorkspace, session]);

  const handleOpenInClaude = useCallback(async () => {
    await ensureWorkspaceAndSession();
  }, [ensureWorkspaceAndSession]);

  const handleRetriggerFailed = useCallback(async () => {
    if (!pr) return;
    setRetriggering(true);
    try {
      const res = await fetch('/api/checks/retrigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pr_id: prId }),
      });
      if (!res.ok) throw new Error('Retrigger failed');
    } catch (err) {
      console.error('Retrigger failed:', err);
    } finally {
      setRetriggering(false);
    }
  }, [pr, prId]);

  const handleKillSession = useCallback(async () => {
    if (!session) return;
    try {
      await apiKillSession(session.id);
      setSession(null);
    } catch (err) {
      console.error('Failed to kill session:', err);
    }
  }, [session]);

  const handleSessionExit = useCallback(() => {
    setSession(null);
  }, []);

  const handlePopOut = useCallback(async () => {
    if (!session) return;
    try {
      await fetch(`/api/sessions/${session.id}/popout`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to pop out session:', err);
    }
  }, [session]);

  const handleReattach = useCallback(async () => {
    if (!session) return;
    try {
      const updated = await apiReattachSession(session.id);
      setSession(updated);
    } catch (err) {
      console.error('Failed to reattach session:', err);
    }
  }, [session]);

  const handleOpenTerminal = useCallback(async () => {
    if (!workspace) return;
    try {
      await fetch(`/api/workspaces/${workspace.id}/terminal`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to open terminal:', err);
    }
  }, [workspace]);

  const handleToggleDraft = useCallback(async () => {
    if (!pr) return;
    setTogglingDraft(true);
    try {
      const { draft } = await setPRDraft(prId, !pr.draft);
      setPR((prev) => ({ ...prev, draft }));
    } catch (err) {
      console.error('Failed to toggle draft:', err);
      alert(`Failed to toggle draft: ${err.message}`);
    } finally {
      setTogglingDraft(false);
    }
  }, [pr, prId]);

  const handleInvestigateFailures = useCallback(async () => {
    if (!pr) return;
    const failedCheckNames = pr.checks.filter(isFailedCheck).map((c) => c.name);

    const result = await ensureWorkspaceAndSession();
    if (!result) return;

    // Send command to the PR terminal
    setTimeout(() => {
      const wsConn = wsRef.current;
      if (wsConn && wsConn.readyState === WebSocket.OPEN) {
        const command = `Investigate the failed CI checks on this PR (${pr.org}/${pr.repo}#${pr.number}, branch: ${pr.branch}). The following checks failed: ${failedCheckNames.join(', ')}. Look at the CI logs and determine root causes.\r`;
        wsConn.send(JSON.stringify({ type: 'input', data: command }));
      }
    }, 500);
  }, [pr, ensureWorkspaceAndSession]);

  if (loading) {
    return <p className={shared.loading}>Loading...</p>;
  }

  if (!pr) {
    return <p className={shared.error}>PR not found</p>;
  }

  const failedChecks = pr.checks.filter(isFailedCheck);
  const passedChecks = pr.checks.filter(isPassedCheck);
  const runningChecks = pr.checks.filter(isRunningCheck);
  const scheduledChecks = pr.checks.filter(isScheduledCheck);
  const isMergeReady = checkMergeReady(pr);

  return (
    <Box pb={16}>
      <Stack direction="col" gap={4}>
        {/* Header */}
        <Box p={5} border rounded="lg" bg="white">
          <Stack direction="col" gap={3}>
            <Stack justify="between">
              <Button size="md" onClick={onBack}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L4.81 7h7.44a.75.75 0 010 1.5H4.81l2.97 2.97a.75.75 0 010 1.06z"
                  />
                </svg>
                Back
              </Button>
              <Stack gap={2}>
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
                  onClick={handleToggleDraft}
                  disabled={togglingDraft}
                  type="button"
                >
                  {togglingDraft ? '...' : pr.draft ? 'Mark ready' : 'Mark draft'}
                </Button>
                <Button as="a" size="sm" href={`${pr.url}/files`} target="_blank" rel="noopener noreferrer">
                  View diff
                </Button>
                {workspace && (
                  <Button size="sm" onClick={handleOpenTerminal} type="button">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <rect x="1" y="2" width="14" height="12" rx="2" />
                      <polyline points="5,6 7.5,8.5 5,11" />
                      <line x1="9" y1="11" x2="12" y2="11" />
                    </svg>
                    Terminal
                  </Button>
                )}
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.ghButton}
                  title="View on GitHub"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                </a>
              </Stack>
            </Stack>

            <h2 className={styles.title}>{pr.title}</h2>

            <Stack gap={2} wrap className={shared.identityRow}>
              <span className={shared.repoTag}>
                {pr.org}/{pr.repo} #{pr.number}
              </span>
              <span className={shared.separator}>·</span>
              <button
                className={shared.branchTag}
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
              <span className={shared.separator}>·</span>
              <span className={shared.updatedText}>Updated {getRelativeTime(pr.updated_at)}</span>
            </Stack>

            {pr.is_stacked && <StackInfo pr={pr} />}

            <Stack gap={4}>
              <Stack gap={2}>
                <span className={styles.statusLabel}>CI</span>
                <StatusBadge status={pr.ci_status} type="ci" />
              </Stack>
              <Stack gap={2}>
                <span className={styles.statusLabel}>Review</span>
                <StatusBadge status={pr.review_status} type="review" />
              </Stack>
              <Stack gap={2}>
                <span className={styles.statusLabel}>Merge</span>
                <StatusBadge status={pr.mergeable} type="merge" />
              </Stack>
              <Stack gap={2}>
                <span className={styles.statusLabel}>PR</span>
                <StatusBadge status={pr.draft ? 'draft' : 'open'} type="status" />
              </Stack>
            </Stack>

            {pr.labels.length > 0 && (
              <Stack gap={2} wrap className={styles.labels}>
                {pr.labels.map((l) => (
                  <span
                    key={l.name}
                    className={styles.label}
                    style={{ backgroundColor: `#${l.color}20`, borderColor: `#${l.color}`, color: `#${l.color}` }}
                  >
                    {l.name}
                  </span>
                ))}
              </Stack>
            )}

            {pr.body_html && <PRDescription bodyHtml={pr.body_html} />}
          </Stack>
        </Box>

        {/* Actions row */}
        <Box p={5} border rounded="lg" bg="white">
          <Stack direction="col" gap={3}>
            <h3 className={shared.sectionTitle}>Workspace</h3>
            <WorkspaceControls
              prId={prId}
              workspace={workspace}
              onUpdate={loadData}
              getOrCreateWorkspace={getOrCreateWorkspace}
              claudeWaiting={openingClaude && !workspace}
            />
            {!session && (
              <Button
                variant="primary"
                size="lg"
                className={styles.openButtonSpaced}
                onClick={handleOpenInClaude}
                disabled={openingClaude}
              >
                {openingClaude ? openingStep : 'Open in Claude'}
              </Button>
            )}
          </Stack>
        </Box>

        {session && (
          <TerminalCard
            session={session}
            title={`Terminal - ${pr.org}/${pr.repo} #${pr.number}`}
            onKill={handleKillSession}
            onExit={handleSessionExit}
            onPopOut={handlePopOut}
            onReattach={handleReattach}
            wsRef={wsRef}
          />
        )}

        {/* Past Sessions */}
        {workspace && <SessionHistory workspaceId={workspace.id} />}

        {/* Checks */}
        {pr.checks.length > 0 && (
          <Box p={5} border rounded="lg" bg="white">
            <Stack direction="col" gap={3}>
              <Stack justify="between" wrap gap={3}>
                <Stack gap={3} as="h3" className={shared.sectionTitle}>
                  Checks
                  <Stack gap={2} as="span">
                    {passedChecks.length > 0 && (
                      <span className={styles.summaryPass}>{passedChecks.length} passed</span>
                    )}
                    {failedChecks.length > 0 && (
                      <span className={styles.summaryFail}>{failedChecks.length} failed</span>
                    )}
                    {runningChecks.length > 0 && (
                      <span className={styles.summaryRunning}>{runningChecks.length} running</span>
                    )}
                    {scheduledChecks.length > 0 && (
                      <span className={styles.summaryScheduled}>{scheduledChecks.length} queued</span>
                    )}
                  </Stack>
                </Stack>
                {failedChecks.length > 0 && (
                  <Stack gap={2}>
                    <Button variant="warning" size="sm" onClick={handleRetriggerFailed} disabled={retriggering}>
                      {retriggering ? 'Retriggering...' : 'Retrigger failed'}
                    </Button>
                    <Button variant="primary" size="sm" onClick={handleInvestigateFailures}>
                      Investigate failures
                    </Button>
                  </Stack>
                )}
              </Stack>

              {/* Failed checks first */}
              {failedChecks.length > 0 && (
                <div className={styles.checkGroup}>
                  {failedChecks.map((c, i) => (
                    <CheckRow key={`fail-${i}`} check={c} prId={prId} />
                  ))}
                </div>
              )}

              {/* Running checks */}
              {runningChecks.length > 0 && (
                <div className={styles.checkGroup}>
                  {runningChecks.map((c, i) => (
                    <CheckRow key={`running-${i}`} check={c} />
                  ))}
                </div>
              )}

              {/* Scheduled checks */}
              {scheduledChecks.length > 0 && (
                <div className={styles.checkGroup}>
                  {scheduledChecks.map((c, i) => (
                    <CheckRow key={`scheduled-${i}`} check={c} />
                  ))}
                </div>
              )}

              {/* Passed checks - collapsed by default if there are many */}
              {passedChecks.length > 0 && <PassedChecksGroup checks={passedChecks} />}
            </Stack>
          </Box>
        )}

        {/* Reviews */}
        {pr.reviews.length > 0 && (
          <Box p={5} border rounded="lg" bg="white">
            <Stack direction="col" gap={3}>
              <h3 className={shared.sectionTitle}>Reviews</h3>
              <div className={styles.reviewsList}>
                {pr.reviews.map((r, i) => (
                  <div key={i} className={styles.reviewRow}>
                    <span className={styles.reviewerName}>{r.reviewer}</span>
                    <span
                      className={`${styles.reviewState} ${r.state === 'APPROVED' ? styles.reviewApproved : r.state === 'CHANGES_REQUESTED' ? styles.reviewChanges : styles.reviewComment}`}
                    >
                      {r.state.toLowerCase().replace('_', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            </Stack>
          </Box>
        )}

        {/* Review Comments & Conversation */}
        {(commentsLoading || comments) && (
          <Box p={5} border rounded="lg" bg="white">
            <Stack direction="col" gap={3}>
              <h3 className={shared.sectionTitle}>Comments</h3>
              <CommentsList
                reviews={comments?.reviews}
                conversation={comments?.conversation}
                loading={commentsLoading}
              />
            </Stack>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

function CheckRow({ check, prId }) {
  const status = checkToStatus(check);
  const colorGroup = statusColorGroup(status);
  const dotClass = DOT_STYLES[colorGroup] || styles.dotScheduled;
  const isFailed = isFailedCheck(check);
  const [jobLogs, setJobLogs] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState(null);
  const [showLog, setShowLog] = useState(false);

  const handleViewLog = useCallback(async () => {
    setShowLog((prev) => !prev);
  }, []);

  // Fetch log data when first shown
  useEffect(() => {
    if (!showLog || jobLogs || logLoading || logError) return;

    const match = check.url?.match(/\/actions\/runs\/(\d+)/);
    if (!match) {
      setLogError('No run ID found in check URL');
      return;
    }

    setLogLoading(true);
    fetchCheckLogs(prId, match[1])
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
            {jobLogs.length > 1 && <div className={styles.jobLogLabel}>{job.job || `Job ${i + 1}`}</div>}
            <CheckLogViewer log={job.log} truncated={job.truncated} loading={false} error={null} />
          </div>
        ))}
      {showLog && !jobLogs && <CheckLogViewer log={null} truncated={false} loading={logLoading} error={logError} />}
    </div>
  );
}

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

function StackInfo({ pr }) {
  const parentId = pr.stack_parent;
  const childIds = pr.stack_children || [];
  const { stack_position: pos, stack_size: size } = pr;

  /** Extract display label from PR id (e.g. "org/repo#123" -> "#123") */
  const prLabel = (id) => {
    const match = id.match(/#(\d+)$/);
    return match ? `#${match[1]}` : id;
  };

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

function PRDescription({ bodyHtml }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={styles.description}>
      <button className={styles.descriptionToggle} onClick={() => setExpanded(!expanded)}>
        <span className={styles.descriptionLabel}>Description</span>
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ''}`}>&#x25B8;</span>
      </button>
      {expanded && <div className={styles.descriptionBody} dangerouslySetInnerHTML={{ __html: bodyHtml }} />}
    </div>
  );
}

function SessionHistory({ workspaceId }) {
  const [history, setHistory] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [transcripts, setTranscripts] = useState({});
  const [transcriptLoading, setTranscriptLoading] = useState({});
  const [transcriptErrors, setTranscriptErrors] = useState({});

  useEffect(() => {
    if (!expanded || history) return;
    setLoading(true);
    fetchSessionHistory(workspaceId)
      .then(setHistory)
      .catch((err) => console.error('Failed to load session history:', err))
      .finally(() => setLoading(false));
  }, [expanded, history, workspaceId]);

  const handleViewTranscript = useCallback(
    (sessionId) => {
      if (transcripts[sessionId]) {
        setTranscripts((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        return;
      }
      setTranscriptLoading((prev) => ({ ...prev, [sessionId]: true }));
      fetchSessionTranscript(sessionId)
        .then((entries) => setTranscripts((prev) => ({ ...prev, [sessionId]: entries })))
        .catch((err) => setTranscriptErrors((prev) => ({ ...prev, [sessionId]: err.message })))
        .finally(() => setTranscriptLoading((prev) => ({ ...prev, [sessionId]: false })));
    },
    [transcripts],
  );

  const formatDuration = (start, end) => {
    if (!start || !end) return '';
    const ms = new Date(end) - new Date(start);
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  return (
    <Box p={5} border rounded="lg" bg="white">
      <Stack direction="col" gap={3}>
        <button className={styles.toggleButton} onClick={() => setExpanded(!expanded)} style={{ padding: '0' }}>
          {expanded ? 'Hide' : 'Show'} past sessions
        </button>
        {expanded && loading && <p className={shared.loading}>Loading...</p>}
        {expanded && history && history.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: '14px', marginTop: '8px' }}>No past sessions</p>
        )}
        {expanded && history && history.length > 0 && (
          <div className={styles.reviewsList}>
            {history.map((sess) => (
              <div key={sess.id}>
                <button className={styles.checkRow} onClick={() => handleViewTranscript(sess.id)}>
                  <Stack gap={2} className={styles.checkInfo}>
                    <span style={{ fontSize: '14px', color: '#6b7280' }}>
                      {new Date(sess.started_at).toLocaleString()}
                    </span>
                    <span style={{ fontSize: '13px', color: '#9ca3af' }}>
                      {formatDuration(sess.started_at, sess.ended_at)}
                    </span>
                  </Stack>
                  <span className={`${styles.chevron} ${transcripts[sess.id] ? styles.chevronOpen : ''}`}>
                    &#x25B8;
                  </span>
                </button>
                {(transcripts[sess.id] || transcriptLoading[sess.id] || transcriptErrors[sess.id]) && (
                  <TranscriptViewer
                    entries={transcripts[sess.id] || null}
                    loading={!!transcriptLoading[sess.id]}
                    error={transcriptErrors[sess.id] || null}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Stack>
    </Box>
  );
}
