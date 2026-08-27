import { useCallback, useEffect, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import {
  createSession as apiCreateSession,
  destroyWorkspace as apiDestroyWorkspace,
  killSession as apiKillSession,
  reattachSession as apiReattachSession,
  fetchSessions,
  fetchWorkspace,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { SessionHistory } from '../SessionHistory/SessionHistory.jsx';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { WorkingBadge } from '../ui/WorkingBadge/WorkingBadge.jsx';
import workPage from '../WorkPage/WorkPage.module.css';
import styles from './WorkspaceDetail.module.css';

/**
 * Scratch workspace detail view.
 * @param {{
 *   workspaceId: string,
 *   onBack: () => void,
 *   workspaceStates: Map<string, 'working' | 'idle'>,
 * }} props
 */
export function WorkspaceDetail({ workspaceId, onBack, workspaceStates }) {
  const { provider } = useAgentProvider();
  const [workspace, setWorkspace] = useState(/** @type {import('../../types').Workspace | null} */ (null));
  const [session, setSession] = useState(/** @type {import('../../types').Session | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [openingSession, setOpeningSession] = useState(false);
  const [openingError, setOpeningError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [destroying, setDestroying] = useState(false);

  const loadData = useCallback(async () => {
    setLoadError('');
    try {
      const ws = await fetchWorkspace(workspaceId);
      setWorkspace(ws);
      if (ws.status === 'active') {
        const sessions = await fetchSessions({ type: 'workspace', id: ws.id });
        setSession(sessions[0] || null);
      } else {
        setSession(null);
      }
    } catch (err) {
      setWorkspace(null);
      setLoadError(getErrorMessage(err, 'Failed to load workspace'));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    loadData();
  }, [loadData]);
  useSyncEvents(loadData);

  const handleStartSession = useCallback(async () => {
    if (!workspace) return;
    setOpeningSession(true);
    setOpeningError('');
    try {
      const sess = await apiCreateSession({ type: 'workspace', id: workspace.id }, provider);
      setSession(sess);
    } catch (err) {
      setOpeningError(getErrorMessage(err, `Failed to start ${provider === 'codex' ? 'Codex' : 'Claude'}`));
    } finally {
      setOpeningSession(false);
    }
  }, [provider, workspace]);

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
  }, [workspace, onBack]);

  // Auto-redirect to PR detail when a scratch workspace gets adopted
  useEffect(() => {
    if (workspace?.pr_id && !workspace.repo) {
      window.location.hash = `/pr/${encodeURIComponent(workspace.pr_id)}`;
    }
  }, [workspace?.pr_id, workspace?.repo]);

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

  const adopted = workspace.pr_id && !workspace.repo;
  const sessionState = workspaceStates.get(`workspace:${workspace.id}`);
  const headerIsWorking = !!session && sessionState === 'working';
  const headerStatusLabel =
    session && sessionState === 'idle'
      ? 'Waiting'
      : session
        ? 'Live'
        : workspace.status === 'destroyed'
          ? 'Destroyed'
          : 'Active';
  const headerStatusColor =
    headerStatusLabel === 'Waiting'
      ? /** @type {const} */ ('amber')
      : headerStatusLabel === 'Destroyed'
        ? /** @type {const} */ ('red')
        : headerStatusLabel === 'Live'
          ? /** @type {const} */ ('gray')
          : /** @type {const} */ ('green');

  return (
    <div className={workPage.page}>
      <header className={workPage.header}>
        <div className={workPage.headerActions}>
          {workspace.status === 'active' && (
            <Button variant="danger" size="sm" onClick={handleDestroy} disabled={destroying} busy={destroying}>
              {destroying ? 'Destroying...' : 'Destroy'}
            </Button>
          )}
        </div>
        <div className={workPage.kicker}>
          <span>Scratch workspace</span>
          {headerIsWorking ? (
            <WorkingBadge indicator="dot" className={workPage.detailStatus} />
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
            <a href={`#/pr/${encodeURIComponent(workspace.pr_id || '')}`} className={styles.prLink}>
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
            sessionState={sessionState}
            presentation="work-page"
          />
        ) : (
          <section className={workPage.terminalLauncher} aria-labelledby="scratch-terminal-heading">
            <h2 id="scratch-terminal-heading">
              <span className={workPage.terminalInactive} data-state-marker="inactive" aria-hidden="true" />
              <span>{workspace.bookmark} · no session</span>
              <span className={workPage.terminalState}>Not started</span>
            </h2>
            <div className={workPage.terminalEmpty}>
              <strong>No LLM session is attached to this workspace.</strong>
              <p className={workPage.launcherCopy}>Start a session in this scratch workspace.</p>
              <AgentProviderButton
                variant="primary"
                size="lg"
                onClick={handleStartSession}
                disabled={openingSession}
                busy={openingSession}
                className={workPage.terminalProvider}
                actionClassName={workPage.terminalAction}
              >
                {openingSession ? 'Starting session...' : `Start ${provider === 'codex' ? 'Codex' : 'Claude'} session`}
              </AgentProviderButton>
            </div>
          </section>
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
          <a className={styles.relatedLink} href={`#/work-item/${workspace.work_item_id}`}>
            View parent work item
          </a>
        ) : workspace.pr_id ? (
          <a className={styles.relatedLink} href={`#/pr/${encodeURIComponent(workspace.pr_id)}`}>
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
