import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWorkspace, fetchSessions, createSession as apiCreateSession, killSession as apiKillSession, destroyWorkspace as apiDestroyWorkspace } from '../../lib/api.js';
import { Terminal } from '../Terminal/Terminal.jsx';
import { QuickActions } from '../QuickActions/QuickActions.jsx';
import { getRelativeTime } from '../../lib/time.js';
import styles from './WorkspaceDetail.module.css';

/**
 * Scratch workspace detail view.
 * @param {{ workspaceId: string, onBack: () => void }} props
 */
export function WorkspaceDetail({ workspaceId, onBack }) {
  const [workspace, setWorkspace] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openingSession, setOpeningSession] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const wsRef = useRef(null);

  const loadData = useCallback(async () => {
    try {
      const ws = await fetchWorkspace(workspaceId);
      setWorkspace(ws);
      if (ws.status === 'active') {
        const sessions = await fetchSessions(ws.id);
        setSession(sessions[0] || null);
      } else {
        setSession(null);
      }
    } catch (err) {
      console.error('Failed to load workspace:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Listen for SSE sync events to detect PR adoption
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('sync', () => loadData());
    return () => es.close();
  }, [loadData]);

  const handleStartSession = useCallback(async () => {
    if (!workspace) return;
    setOpeningSession(true);
    try {
      const sess = await apiCreateSession(workspace.id);
      setSession(sess);
    } catch (err) {
      console.error('Failed to create session:', err);
    } finally {
      setOpeningSession(false);
    }
  }, [workspace]);

  const handleKillSession = useCallback(async () => {
    if (!session) return;
    try {
      await apiKillSession(session.id);
      setSession(null);
    } catch (err) {
      console.error('Failed to kill session:', err);
    }
  }, [session]);

  const handleDestroy = useCallback(async () => {
    if (!workspace) return;
    setDestroying(true);
    try {
      await apiDestroyWorkspace(workspace.id);
      onBack();
    } catch (err) {
      console.error('Failed to destroy workspace:', err);
      setDestroying(false);
    }
  }, [workspace, onBack]);

  const handleSendCommand = useCallback((command) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'input', data: command + '\r' }));
    }
  }, []);

  if (loading) return <div className={styles.loading}>Loading workspace...</div>;
  if (!workspace) return <div className={styles.error}>Workspace not found</div>;

  const [org, repo] = (workspace.repo || '').split('/');
  const adopted = workspace.pr_id && !workspace.repo;

  return (
    <div className={styles.detail}>
      {/* Header */}
      <div className={styles.headerCard}>
        <div className={styles.headerTop}>
          <button className={styles.backButton} onClick={onBack}>
            &larr; Back
          </button>
          <div className={styles.headerActions}>
            {workspace.status === 'active' && (
              <button
                className={styles.destroyButton}
                onClick={handleDestroy}
                disabled={destroying}
              >
                {destroying ? 'Destroying...' : 'Destroy'}
              </button>
            )}
          </div>
        </div>
        <div className={styles.title}>
          {workspace.bookmark}
        </div>
        <div className={styles.identityRow}>
          {workspace.repo && <span className={styles.repoTag}>{workspace.repo}</span>}
          <span className={styles.branchTag}>{workspace.bookmark}</span>
          <span className={styles.separator}>-</span>
          <span className={styles.updatedText}>Created {getRelativeTime(workspace.created_at)}</span>
          {workspace.status === 'destroyed' && (
            <span className={styles.destroyedBadge}>Destroyed</span>
          )}
        </div>
        {adopted && (
          <div className={styles.adoptedNotice}>
            Adopted by PR - <a href={`#/pr/${encodeURIComponent(workspace.pr_id)}`} className={styles.prLink}>View PR</a>
          </div>
        )}
      </div>

      {/* Terminal */}
      {workspace.status === 'active' && (
        <div className={styles.card}>
          <div className={styles.section}>
            <div className={styles.terminalHeader}>
              <h3 className={styles.sectionTitle}>Terminal</h3>
              <div className={styles.terminalActions}>
                {session && (
                  <button className={styles.killSessionButton} onClick={handleKillSession}>
                    Kill Session
                  </button>
                )}
              </div>
            </div>
            {session ? (
              <>
                <Terminal sessionId={session.id} wsRef={wsRef} />
                <QuickActions onSend={handleSendCommand} />
              </>
            ) : (
              <button
                className={styles.openButton}
                onClick={handleStartSession}
                disabled={openingSession}
              >
                {openingSession ? 'Starting session...' : 'Start Terminal Session'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
