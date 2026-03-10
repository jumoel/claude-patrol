import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPR, fetchWorkspaces, fetchSessions, createWorkspace as apiCreateWorkspace, createSession as apiCreateSession } from '../../lib/api.js';
import { WorkspaceControls } from '../WorkspaceControls/WorkspaceControls.jsx';
import { Terminal } from '../Terminal/Terminal.jsx';
import { QuickActions } from '../QuickActions/QuickActions.jsx';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { getRelativeTime } from '../../lib/time.js';
import styles from './PRDetail.module.css';

/**
 * PR detail view with workspace and terminal management.
 * @param {{ prId: string, onBack: () => void }} props
 */
export function PRDetail({ prId, onBack }) {
  const [pr, setPR] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openingClaude, setOpeningClaude] = useState(false);
  const [openingStep, setOpeningStep] = useState('');
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

  if (loading) {
    return <p className={styles.loading}>Loading...</p>;
  }

  if (!pr) {
    return <p className={styles.error}>PR not found</p>;
  }

  return (
    <div className={styles.detail}>
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onBack}>Back</button>
        <h2 className={styles.title}>
          <a href={pr.url} target="_blank" rel="noopener noreferrer">{pr.title}</a>
        </h2>
      </div>

      <div className={styles.meta}>
        <span>{pr.org}/{pr.repo} #{pr.number}</span>
        <StatusBadge status={pr.ci_status} type="ci" />
        <StatusBadge status={pr.review_status} type="review" />
        <span>Branch: {pr.branch}</span>
        <span>Updated {getRelativeTime(pr.updated_at)}</span>
        {pr.draft && <span className={styles.draft}>Draft</span>}
      </div>

      {pr.labels.length > 0 && (
        <div className={styles.labels}>
          {pr.labels.map(l => (
            <span key={l.name} className={styles.label} style={{ borderColor: `#${l.color}` }}>
              {l.name}
            </span>
          ))}
        </div>
      )}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Workspace</h3>
        <WorkspaceControls prId={prId} workspace={workspace} onUpdate={loadData} />
        {!workspace && !session && (
          <button className={styles.openButton} onClick={handleOpenInClaude} disabled={openingClaude}>
            {openingClaude ? openingStep : 'Open in Claude'}
          </button>
        )}
      </div>

      {session && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Terminal</h3>
          <QuickActions wsRef={wsRef} />
          <Terminal wsUrl={`/ws/sessions/${session.id}`} wsRef={wsRef} />
        </div>
      )}

      {pr.checks.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Checks</h3>
          <div className={styles.checksList}>
            {pr.checks.map((c, i) => (
              <div key={i} className={styles.checkRow}>
                <span className={styles.checkName}>{c.name}</span>
                <span className={styles.checkStatus}>{c.conclusion || c.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pr.reviews.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Reviews</h3>
          <div className={styles.checksList}>
            {pr.reviews.map((r, i) => (
              <div key={i} className={styles.checkRow}>
                <span className={styles.checkName}>{r.reviewer}</span>
                <span className={styles.checkStatus}>{r.state}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
