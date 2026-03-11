import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchWorkspace, fetchSessions, createSession as apiCreateSession, killSession as apiKillSession, destroyWorkspace as apiDestroyWorkspace } from '../../lib/api.js';
import { Terminal } from '../Terminal/Terminal.jsx';
import { QuickActions } from '../QuickActions/QuickActions.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { useResizeHandle } from '../../hooks/useResizeHandle.js';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
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
  const [maximized, setMaximized] = useState(false);
  const wsRef = useRef(null);

  const { height: termHeight, dragging, handleProps } = useResizeHandle({
    initial: 600,
    min: 200,
    max: 1200,
    direction: 'down',
  });

  useEscapeKey(maximized, useCallback(() => setMaximized(false), []));

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
  useSyncEvents(loadData);

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

  if (loading) return <div className={shared.loading}>Loading workspace...</div>;
  if (!workspace) return <div className={shared.error}>Workspace not found</div>;

  const adopted = workspace.pr_id && !workspace.repo;

  return (
    <div className={shared.detail}>
      {/* Header */}
      <div className={shared.headerCard}>
        <div className={shared.headerTop}>
          <button className={shared.backButton} onClick={onBack}>
            &larr; Back
          </button>
          <div className={styles.headerActions}>
            {workspace.status === 'active' && (
              <button
                className={shared.destroyButton}
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
        <div className={shared.identityRow}>
          {workspace.repo && <span className={shared.repoTag}>{workspace.repo}</span>}
          <span className={shared.branchTag}>{workspace.bookmark}</span>
          <span className={shared.separator}>-</span>
          <span className={shared.updatedText}>Created {getRelativeTime(workspace.created_at)}</span>
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
        <>
          {maximized && session && (
            <div className={shared.terminalOverlay}>
              <div className={shared.overlayHeader}>
                <span className={shared.overlayTitle}>Terminal - {workspace.bookmark}</span>
                <div className={shared.terminalActions}>
                  <button className={shared.maximizeButton} onClick={() => setMaximized(false)}>
                    Restore
                  </button>
                  <button className={shared.killSessionButton} onClick={() => { setMaximized(false); handleKillSession(); }}>
                    Kill Session
                  </button>
                </div>
              </div>
              <div className={shared.overlayContent}>
                <Terminal wsUrl={`/ws/sessions/${session.id}`} wsRef={wsRef} />
              </div>
              <QuickActions onSend={handleSendCommand} />
            </div>
          )}
          {!maximized && (
            <div className={shared.card}>
              <div className={shared.section}>
                <div className={shared.terminalHeader}>
                  <h3 className={shared.sectionTitle}>Terminal</h3>
                  <div className={shared.terminalActions}>
                    {session && (
                      <>
                        <button className={shared.maximizeButton} onClick={() => setMaximized(true)}>
                          Maximize
                        </button>
                        <button className={shared.killSessionButton} onClick={handleKillSession}>
                          Kill Session
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {session ? (
                  <>
                    {dragging && <div className={shared.dragOverlay} />}
                    <div style={{ height: termHeight }}>
                      <Terminal wsUrl={`/ws/sessions/${session.id}`} wsRef={wsRef} />
                    </div>
                    <div className={shared.resizeHandle} {...handleProps}>
                      <div className={shared.resizeGrip} />
                    </div>
                    <QuickActions onSend={handleSendCommand} />
                  </>
                ) : (
                  <button
                    className={shared.openButton}
                    onClick={handleStartSession}
                    disabled={openingSession}
                  >
                    {openingSession ? 'Starting session...' : 'Start Terminal Session'}
                  </button>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
