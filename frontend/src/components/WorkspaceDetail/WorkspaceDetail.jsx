import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import { useTargetSession } from '../../hooks/useTargetSession.js';
import { destroyWorkspace as apiDestroyWorkspace, fetchWorkspace } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { pullRequestIdPath, workItemPath } from '../../lib/routes.js';
import { sessionAttentionState } from '../../lib/session-attention.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { SessionHistory } from '../SessionHistory/SessionHistory.jsx';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { SessionStateBadge } from '../ui/SessionStateBadge/SessionStateBadge.jsx';
import workPage from '../WorkPage/WorkPage.module.css';
import styles from './WorkspaceDetail.module.css';

/**
 * Scratch workspace detail view.
 * @param {{
 *   workspaceId: string,
 *   onBack: () => void,
 *   workspaceStates: Map<string, 'working' | 'idle'>,
 *   acknowledgedSessionIds: Set<string>,
 *   onAcknowledgeSession: (sessionId: string) => void,
 * }} props
 */
export function WorkspaceDetail({
  workspaceId,
  onBack,
  workspaceStates,
  acknowledgedSessionIds,
  onAcknowledgeSession,
}) {
  const { provider } = useAgentProvider();
  const [workspace, setWorkspace] = useState(/** @type {import('../../types').Workspace | null} */ (null));
  const {
    session,
    setSession,
    actionError,
    setActionError,
    load: loadSession,
    start: startSession,
    kill: handleKillSession,
    reattach: handleReattach,
    handleExit: handleSessionExit,
  } = useTargetSession({ onAcknowledgeSession });
  const [loading, setLoading] = useState(true);
  const [openingSession, setOpeningSession] = useState(false);
  const [openingError, setOpeningError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [destroying, setDestroying] = useState(false);
  /** Incremented per load so a response for a superseded load is dropped. */
  const loadRequest = useRef(0);

  const loadData = useCallback(async () => {
    const requestId = ++loadRequest.current;
    const stale = () => loadRequest.current !== requestId;
    setLoadError('');
    try {
      const ws = await fetchWorkspace(workspaceId);
      if (stale()) return;
      setWorkspace(ws);
      if (ws.status === 'active') {
        const next = await loadSession({ type: 'workspace', id: ws.id });
        if (stale()) return;
        setSession(next);
      } else {
        setSession(null);
      }
    } catch (err) {
      if (stale()) return;
      setWorkspace(null);
      setLoadError(getErrorMessage(err, 'Failed to load workspace'));
    } finally {
      if (!stale()) setLoading(false);
    }
  }, [loadSession, setSession, workspaceId]);

  useEffect(() => {
    loadData();
    return () => {
      loadRequest.current += 1;
    };
  }, [loadData]);
  useSyncEvents(loadData);

  const handleStartSession = useCallback(async () => {
    if (!workspace) return;
    setOpeningSession(true);
    setOpeningError('');
    try {
      await startSession({ type: 'workspace', id: workspace.id }, provider);
    } catch (err) {
      setOpeningError(getErrorMessage(err, `Failed to start ${provider === 'codex' ? 'Codex' : 'Claude'}`));
    } finally {
      setOpeningSession(false);
    }
  }, [provider, startSession, workspace]);

  const handleDestroy = useCallback(async () => {
    if (!workspace) return;
    setDestroying(true);
    setActionError('');
    try {
      await apiDestroyWorkspace(workspace.id);
      onBack();
    } catch (err) {
      setActionError(getErrorMessage(err, 'Failed to destroy workspace'));
      setDestroying(false);
    }
  }, [workspace, onBack, setActionError]);

  // Auto-redirect to PR detail when a scratch workspace gets adopted
  useEffect(() => {
    if (workspace?.pr_id) {
      window.location.hash = pullRequestIdPath(workspace.pr_id);
    }
  }, [workspace?.pr_id]);

  if (loading) return <LoadingIndicator className={shared.loading}>Loading workspace...</LoadingIndicator>;
  if (!workspace) {
    return (
      <div className={workPage.unavailable} role="alert">
        <span>{loadError || 'Workspace not found'}</span>
        <Button as="a" href="#/" size="sm">
          Back to work
        </Button>
      </div>
    );
  }

  const adopted = Boolean(workspace.pr_id);
  const sessionState = workspaceStates.get(`workspace:${workspace.id}`);
  const attentionState = session ? sessionAttentionState(session, sessionState, acknowledgedSessionIds) : null;
  const headerStatusLabel = workspace.status === 'destroyed' ? 'Destroyed' : 'Active';
  const headerStatusColor =
    headerStatusLabel === 'Destroyed' ? /** @type {const} */ ('red') : /** @type {const} */ ('green');

  return (
    <div className={workPage.page}>
      <header className={workPage.header}>
        <div className={workPage.headerActions}>
          {workspace.status === 'active' && (
            <Button
              variant="danger"
              size="sm"
              onClick={handleDestroy}
              disabled={destroying || Boolean(session)}
              busy={destroying}
              title={session ? 'Stop the active LLM session before deleting this workspace' : undefined}
            >
              {destroying ? 'Destroying...' : 'Destroy'}
            </Button>
          )}
        </div>
        <div className={workPage.kicker}>
          <span>Scratch workspace</span>
          {attentionState ? (
            <SessionStateBadge attentionState={attentionState} className={workPage.detailStatus} />
          ) : (
            <Badge color={headerStatusColor} className={workPage.detailStatus}>
              <span
                className={workPage.detailStatusDot}
                data-state-marker={headerStatusLabel.toLowerCase()}
                aria-hidden="true"
              />
              {headerStatusLabel}
            </Badge>
          )}
        </div>
        <h1 className={workPage.title}>{workspace.name || workspace.bookmark}</h1>
        <div className={workPage.identity}>
          {workspace.repo && <span>{workspace.repo}</span>}
          {workspace.repo && <span aria-hidden="true">·</span>}
          <span>Created {getRelativeTime(workspace.created_at)}</span>
        </div>
        {adopted && (
          <div className={styles.adoptedNotice}>
            Adopted by PR -{' '}
            <a href={`#${pullRequestIdPath(workspace.pr_id || '')}`} className={styles.prLink}>
              View PR
            </a>
          </div>
        )}
      </header>

      {workspace.status === 'active' &&
        (session ? (
          <TerminalCard
            session={session}
            title={`Terminal - ${workspace.bookmark}`}
            onKill={handleKillSession}
            onExit={handleSessionExit}
            onReattach={handleReattach}
            workspaceId={workspace.id}
            prId={workspace.pr_id || undefined}
            attentionState={attentionState ?? 'idle'}
            presentation="work-page"
          />
        ) : (
          <div className={workPage.sessionLauncher}>
            <AgentProviderButton
              variant="primary"
              size="md"
              onClick={handleStartSession}
              disabled={openingSession}
              busy={openingSession}
            >
              {openingSession ? 'Starting session...' : `Start ${provider === 'codex' ? 'Codex' : 'Claude'} session`}
            </AgentProviderButton>
          </div>
        ))}

      {workspace.status === 'destroyed' && (
        <section className={workPage.section} aria-labelledby="scratch-terminal-heading">
          <h2 id="scratch-terminal-heading">Terminal</h2>
          <p className={workPage.sectionHint}>This workspace has been destroyed. Its past sessions remain available.</p>
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

      <section className={`${workPage.section} ${workPage.firstSection}`} aria-labelledby="scratch-overview-heading">
        <h2 id="scratch-overview-heading">Overview</h2>
        <p className={styles.overview}>
          Scratch workspace on <code>{workspace.bookmark}</code>
          {workspace.repo ? (
            <>
              {' '}
              in <code>{workspace.repo}</code>
            </>
          ) : null}
          .
        </p>
      </section>

      <section className={workPage.section} aria-labelledby="scratch-related-work-heading">
        <h2 id="scratch-related-work-heading">Related work</h2>
        {workspace.work_item_id ? (
          <a className={styles.relatedLink} href={`#${workItemPath(workspace.work_item_id)}`}>
            View parent work item
          </a>
        ) : workspace.pr_id ? (
          <a className={styles.relatedLink} href={`#${pullRequestIdPath(workspace.pr_id)}`}>
            View pull request
          </a>
        ) : (
          <div className={styles.relatedEmpty}>
            <strong>This scratch workspace has no related work.</strong>
            <span>No pull request or work item is attached.</span>
          </div>
        )}
      </section>

      <SessionHistory key={workspaceId} target={{ type: 'workspace', id: workspaceId }} />
    </div>
  );
}
