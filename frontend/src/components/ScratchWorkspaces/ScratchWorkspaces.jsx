import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchScratchWorkspaces, createScratchWorkspace, fetchConfig } from '../../lib/api.js';
import { getRelativeTime } from '../../lib/time.js';
import styles from './ScratchWorkspaces.module.css';

export function ScratchWorkspaces({ prs, syncedAt }) {
  const [scratchWorkspaces, setScratchWorkspaces] = useState([]);
  const [showNewWork, setShowNewWork] = useState(false);
  const [newWorkRepo, setNewWorkRepo] = useState('');
  const [newWorkBranch, setNewWorkBranch] = useState('');
  const [newWorkSubmitting, setNewWorkSubmitting] = useState(false);
  const [repos, setRepos] = useState([]);
  const configRef = useRef(null);

  useEffect(() => {
    fetchScratchWorkspaces()
      .then(ws => setScratchWorkspaces(ws))
      .catch(() => {});
  }, [syncedAt]);

  useEffect(() => {
    if (!configRef.current) {
      fetchConfig().then(cfg => { configRef.current = cfg; }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const prRepos = [...new Set(prs.map(pr => `${pr.org}/${pr.repo}`))];
    const cfg = configRef.current;
    const configRepos = cfg?.poll?.repos || [];
    const configOrgs = (cfg?.poll?.orgs || []).map(o => `${o}/*`);
    const all = [...new Set([...prRepos, ...configRepos, ...configOrgs])].sort();
    setRepos(all);
    if (!newWorkRepo && all.length > 0) {
      const first = all.find(r => !r.endsWith('/*')) || '';
      setNewWorkRepo(first);
    }
  }, [prs]);

  const handleNewWork = useCallback(async () => {
    if (!newWorkRepo || !newWorkBranch) return;
    setNewWorkSubmitting(true);
    try {
      const ws = await createScratchWorkspace(newWorkRepo, newWorkBranch);
      setShowNewWork(false);
      setNewWorkBranch('');
      window.location.hash = `/workspace/${ws.id}`;
    } catch (err) {
      alert(err.message);
    } finally {
      setNewWorkSubmitting(false);
    }
  }, [newWorkRepo, newWorkBranch]);

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h3 className={styles.title}>
          Scratch Workspaces {scratchWorkspaces.length > 0 && `(${scratchWorkspaces.length})`}
        </h3>
        <button className={styles.newWorkBtn} onClick={() => setShowNewWork(!showNewWork)}>
          + New Work
        </button>
      </div>
      {showNewWork && (
        <div className={styles.form}>
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Repo</label>
            <select className={styles.select} value={newWorkRepo} onChange={e => setNewWorkRepo(e.target.value)}>
              {repos.filter(r => !r.endsWith('/*')).map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className={styles.fieldGroupFlex}>
            <label className={styles.label}>Branch</label>
            <input
              className={styles.input}
              type="text"
              value={newWorkBranch}
              onChange={e => setNewWorkBranch(e.target.value)}
              placeholder="feat/my-feature"
              onKeyDown={e => e.key === 'Enter' && handleNewWork()}
            />
          </div>
          <button
            className={styles.submitBtn}
            onClick={handleNewWork}
            disabled={newWorkSubmitting || !newWorkRepo || !newWorkBranch}
          >
            {newWorkSubmitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      )}
      {scratchWorkspaces.length > 0 ? (
        <div className={styles.list}>
          {scratchWorkspaces.map(ws => (
            <div
              key={ws.id}
              className={styles.row}
              onClick={() => { window.location.hash = `/workspace/${ws.id}`; }}
            >
              <div className={styles.rowLeft}>
                <span className={styles.bookmark}>{ws.bookmark}</span>
                {ws.repo && <span className={styles.repoTag}>{ws.repo}</span>}
              </div>
              <span className={styles.timeLabel}>{getRelativeTime(ws.created_at)}</span>
            </div>
          ))}
        </div>
      ) : !showNewWork && (
        <p className={styles.emptyText}>No scratch workspaces. Click "New Work" to start.</p>
      )}
    </div>
  );
}
