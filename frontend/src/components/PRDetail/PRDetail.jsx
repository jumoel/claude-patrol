import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPR, fetchWorkspaces, fetchSessions, fetchPRComments, fetchCheckLogs, createWorkspace as apiCreateWorkspace, createSession as apiCreateSession, killSession as apiKillSession } from '../../lib/api.js';
import { WorkspaceControls } from '../WorkspaceControls/WorkspaceControls.jsx';
import { Terminal } from '../Terminal/Terminal.jsx';
import { QuickActions } from '../QuickActions/QuickActions.jsx';
import { CommentsList } from '../CommentsList/CommentsList.jsx';
import { CheckLogViewer } from '../CheckLogViewer/CheckLogViewer.jsx';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { getRelativeTime } from '../../lib/time.js';
import { isFailedCheck, isPassedCheck, checkToStatus } from '../../lib/checks.js';
import styles from './PRDetail.module.css';

const DOT_STYLES = {
  pass: styles.dotPass,
  fail: styles.dotFail,
  pending: styles.dotPending,
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
  const wsRef = useRef(null);

  const loadData = useCallback(async () => {
    try {
      const [prData, workspaces] = await Promise.all([
        fetchPR(prId),
        fetchWorkspaces(prId),
      ]);
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
      .catch(err => console.error('Failed to load comments:', err))
      .finally(() => setCommentsLoading(false));
  }, [prId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleOpenInClaude = useCallback(async () => {
    setOpeningClaude(true);
    try {
      let ws = workspace;
      if (!ws) {
        setOpeningStep('Creating workspace...');
        ws = await apiCreateWorkspace(prId);
        setWorkspace(ws);
      }
      let sess = session;
      if (!sess) {
        setOpeningStep('Starting session...');
        sess = await apiCreateSession(ws.id);
        setSession(sess);
      }
      setOpeningStep('Connecting...');
    } catch (err) {
      console.error('Open in Claude failed:', err);
    } finally {
      setOpeningClaude(false);
      setOpeningStep('');
    }
  }, [prId, workspace, session]);

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

  const handleInvestigateFailures = useCallback(async () => {
    if (!pr) return;
    const failedChecks = pr.checks
      .filter(isFailedCheck)
      .map(c => c.name);

    // Ensure workspace + session exist
    let ws = workspace;
    if (!ws) {
      setOpeningClaude(true);
      setOpeningStep('Creating workspace...');
      try {
        ws = await apiCreateWorkspace(prId);
        setWorkspace(ws);
      } catch (err) {
        console.error('Failed to create workspace:', err);
        setOpeningClaude(false);
        setOpeningStep('');
        return;
      }
    }
    let sess = session;
    if (!sess) {
      setOpeningStep('Starting session...');
      try {
        sess = await apiCreateSession(ws.id);
        setSession(sess);
      } catch (err) {
        console.error('Failed to create session:', err);
        setOpeningClaude(false);
        setOpeningStep('');
        return;
      }
    }
    setOpeningClaude(false);
    setOpeningStep('');

    // Send command to the PR terminal
    setTimeout(() => {
      const wsConn = wsRef.current;
      if (wsConn && wsConn.readyState === WebSocket.OPEN) {
        const command = `Investigate the failed CI checks on this PR (${pr.org}/${pr.repo}#${pr.number}, branch: ${pr.branch}). The following checks failed: ${failedChecks.join(', ')}. Look at the CI logs and determine root causes.\r`;
        wsConn.send(JSON.stringify({ type: 'input', data: command }));
      }
    }, 500);
  }, [pr, prId, workspace, session]);

  if (loading) {
    return <p className={styles.loading}>Loading...</p>;
  }

  if (!pr) {
    return <p className={styles.error}>PR not found</p>;
  }

  const failedChecks = pr.checks.filter(isFailedCheck);
  const passedChecks = pr.checks.filter(isPassedCheck);
  const pendingChecks = pr.checks.filter(c => !isFailedCheck(c) && !isPassedCheck(c));

  return (
    <div className={styles.detail}>
      {/* Header */}
      <div className={styles.headerCard}>
        <div className={styles.headerTop}>
          <button className={styles.backButton} onClick={onBack}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M7.78 12.53a.75.75 0 01-1.06 0L2.47 8.28a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 1.06L4.81 7h7.44a.75.75 0 010 1.5H4.81l2.97 2.97a.75.75 0 010 1.06z"/></svg>
            Back
          </button>
          <a href={pr.url} target="_blank" rel="noopener noreferrer" className={styles.ghButton} title="View on GitHub">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
        </div>

        <h2 className={styles.title}>{pr.title}</h2>

        <div className={styles.identityRow}>
          <span className={styles.repoTag}>{pr.org}/{pr.repo} #{pr.number}</span>
          <span className={styles.separator}>·</span>
          <span className={styles.branchTag}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path fillRule="evenodd" d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"/></svg>
            {pr.branch}
          </span>
          <span className={styles.separator}>·</span>
          <span className={styles.updatedText}>Updated {getRelativeTime(pr.updated_at)}</span>
        </div>

        <div className={styles.statusRow}>
          <div className={styles.statusItem}>
            <span className={styles.statusLabel}>CI</span>
            <StatusBadge status={pr.ci_status} type="ci" />
          </div>
          <div className={styles.statusItem}>
            <span className={styles.statusLabel}>Review</span>
            <StatusBadge status={pr.review_status} type="review" />
          </div>
          <div className={styles.statusItem}>
            <span className={styles.statusLabel}>Merge</span>
            <StatusBadge status={pr.mergeable} type="merge" />
          </div>
          {pr.draft && (
            <div className={styles.statusItem}>
              <span className={styles.statusLabel}>PR</span>
              <span className={styles.draftBadge}>Draft</span>
            </div>
          )}
        </div>

        {pr.labels.length > 0 && (
          <div className={styles.labels}>
            {pr.labels.map(l => (
              <span key={l.name} className={styles.label} style={{ backgroundColor: `#${l.color}20`, borderColor: `#${l.color}`, color: `#${l.color}` }}>
                {l.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Actions row */}
      <div className={styles.actionsRow}>
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Workspace</h3>
          <WorkspaceControls prId={prId} workspace={workspace} onUpdate={loadData} />
          {!session && (
            <button className={styles.openButton} onClick={handleOpenInClaude} disabled={openingClaude}>
              {openingClaude ? openingStep : 'Open in Claude'}
            </button>
          )}
        </div>
      </div>

      {session && (
        <div className={styles.card}>
          <div className={styles.terminalHeader}>
            <h3 className={styles.sectionTitle}>Terminal</h3>
            <button className={styles.killSessionButton} onClick={handleKillSession}>
              Kill session
            </button>
          </div>
          <QuickActions wsRef={wsRef} />
          <Terminal wsUrl={`/ws/sessions/${session.id}`} wsRef={wsRef} />
        </div>
      )}

      {/* Checks */}
      {pr.checks.length > 0 && (
        <div className={styles.card}>
          <div className={styles.checksHeader}>
            <h3 className={styles.sectionTitle}>
              Checks
              <span className={styles.checksSummary}>
                {passedChecks.length > 0 && <span className={styles.summaryPass}>{passedChecks.length} passed</span>}
                {failedChecks.length > 0 && <span className={styles.summaryFail}>{failedChecks.length} failed</span>}
                {pendingChecks.length > 0 && <span className={styles.summaryPending}>{pendingChecks.length} pending</span>}
              </span>
            </h3>
            {failedChecks.length > 0 && (
              <div className={styles.checksActions}>
                <button className={styles.retriggerButton} onClick={handleRetriggerFailed} disabled={retriggering}>
                  {retriggering ? 'Retriggering...' : 'Retrigger failed'}
                </button>
                <button className={styles.investigateButton} onClick={handleInvestigateFailures}>
                  Investigate failures
                </button>
              </div>
            )}
          </div>

          {/* Failed checks first */}
          {failedChecks.length > 0 && (
            <div className={styles.checkGroup}>
              {failedChecks.map((c, i) => (
                <CheckRow key={`fail-${i}`} check={c} prId={prId} />
              ))}
            </div>
          )}

          {/* Pending checks */}
          {pendingChecks.length > 0 && (
            <div className={styles.checkGroup}>
              {pendingChecks.map((c, i) => (
                <CheckRow key={`pending-${i}`} check={c} />
              ))}
            </div>
          )}

          {/* Passed checks - collapsed by default if there are many */}
          {passedChecks.length > 0 && (
            <PassedChecksGroup checks={passedChecks} />
          )}
        </div>
      )}

      {/* Reviews */}
      {pr.reviews.length > 0 && (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>Reviews</h3>
          <div className={styles.reviewsList}>
            {pr.reviews.map((r, i) => (
              <div key={i} className={styles.reviewRow}>
                <span className={styles.reviewerName}>{r.reviewer}</span>
                <span className={`${styles.reviewState} ${r.state === 'APPROVED' ? styles.reviewApproved : r.state === 'CHANGES_REQUESTED' ? styles.reviewChanges : styles.reviewComment}`}>
                  {r.state.toLowerCase().replace('_', ' ')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Review Comments & Conversation */}
      {(commentsLoading || comments) && (
        <div className={styles.card}>
          <h3 className={styles.sectionTitle}>Comments</h3>
          <CommentsList
            reviews={comments?.reviews}
            conversation={comments?.conversation}
            loading={commentsLoading}
          />
        </div>
      )}
    </div>
  );
}

function CheckRow({ check, prId }) {
  const status = checkToStatus(check);
  const dotClass = DOT_STYLES[status] || styles.dotPending;
  const isFailed = isFailedCheck(check);
  const [logData, setLogData] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState(null);
  const [showLog, setShowLog] = useState(false);

  const handleViewLog = useCallback(async () => {
    setShowLog(prev => {
      if (prev) return false; // toggle off
      return true;
    });
  }, []);

  // Fetch log data when first shown
  useEffect(() => {
    if (!showLog || logData || logLoading || logError) return;

    const match = check.url?.match(/\/actions\/runs\/(\d+)/);
    if (!match) { setLogError('No run ID found in check URL'); return; }

    setLogLoading(true);
    fetchCheckLogs(prId, match[1])
      .then(data => {
        const jobLog = data.logs?.[0];
        if (jobLog?.error) setLogError(jobLog.error);
        else if (jobLog) setLogData(jobLog);
        else setLogError('No log data returned');
      })
      .catch(err => setLogError(err.message))
      .finally(() => setLogLoading(false));
  }, [showLog, logData, logLoading, logError, check.url, prId]);

  return (
    <div>
      <div className={styles.checkRow}>
        <div className={styles.checkInfo}>
          <span className={`${styles.checkDot} ${dotClass}`} />
          {check.url ? (
            <a href={check.url} target="_blank" rel="noopener noreferrer" className={styles.checkName}>
              {check.name}
            </a>
          ) : (
            <span className={styles.checkNamePlain}>{check.name}</span>
          )}
        </div>
        <div className={styles.checkActions}>
          {isFailed && prId && (
            <button className={styles.viewLogButton} onClick={handleViewLog}>
              {showLog ? 'Hide log' : 'View log'}
            </button>
          )}
          <StatusBadge status={status} type="ci" />
        </div>
      </div>
      {showLog && (
        <CheckLogViewer
          log={logData?.log}
          truncated={logData?.truncated}
          loading={logLoading}
          error={logError}
        />
      )}
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
      {expanded && checks.map((c, i) => (
        <CheckRow key={`pass-${i}`} check={c} />
      ))}
    </div>
  );
}
