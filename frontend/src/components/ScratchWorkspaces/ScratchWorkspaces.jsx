import { useCallback, useEffect, useState } from 'react';
import { createScratchWorkspace, fetchScratchWorkspaces } from '../../lib/api.js';
import { getRelativeTime } from '../../lib/time.js';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { RepoCombobox } from '../ui/RepoCombobox/RepoCombobox.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './ScratchWorkspaces.module.css';

export function ScratchWorkspaces({ workspaceStates, dismissedIdle, localChangeCount }) {
  const [scratchWorkspaces, setScratchWorkspaces] = useState([]);
  const [showNewWork, setShowNewWork] = useState(false);
  const [newWorkRepo, setNewWorkRepo] = useState('');
  const [newWorkBranch, setNewWorkBranch] = useState('');
  const [newWorkSubmitting, setNewWorkSubmitting] = useState(false);

  useEffect(() => {
    fetchScratchWorkspaces()
      .then((ws) => setScratchWorkspaces(ws))
      .catch(() => {});
  }, [localChangeCount]);

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
      <Stack justify="between" className={styles.header}>
        <h3 className={styles.title}>
          Scratch Workspaces {scratchWorkspaces.length > 0 && `(${scratchWorkspaces.length})`}
        </h3>
        <Button variant="primary" size="sm" onClick={() => setShowNewWork(!showNewWork)}>
          + New Work
        </Button>
      </Stack>
      {showNewWork && (
        <Box p={4} border rounded="lg" bg="white" className={styles.form}><Stack gap={2} wrap align="end">
          <Stack direction="col">
            <label className={styles.label}>Repo</label>
            <RepoCombobox value={newWorkRepo} onChange={setNewWorkRepo} disabled={newWorkSubmitting} />
          </Stack>
          <Stack direction="col" className={styles.fieldGroupFlex}>
            <label className={styles.label}>Branch</label>
            <input
              className={styles.input}
              type="text"
              value={newWorkBranch}
              onChange={(e) => setNewWorkBranch(e.target.value)}
              placeholder="feat/my-feature"
              onKeyDown={(e) => e.key === 'Enter' && handleNewWork()}
            />
          </Stack>
          <Button
            variant="primary"
            size="sm"
            onClick={handleNewWork}
            disabled={newWorkSubmitting || !newWorkRepo || !newWorkBranch}
          >
            {newWorkSubmitting ? 'Creating...' : 'Create'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setShowNewWork(false);
              setNewWorkBranch('');
            }}
            disabled={newWorkSubmitting}
            type="button"
          >
            Cancel
          </Button>
        </Stack></Box>
      )}
      {scratchWorkspaces.length > 0 ? (
        <table className={styles.table}>
          <colgroup>
            <col className={styles.colName} />
            <col className={styles.colRepo} />
            <col className={styles.colSession} />
            <col className={styles.colCreated} />
          </colgroup>
          <thead>
            <tr>
              <th className={styles.th}>Name</th>
              <th className={styles.th}>Repo</th>
              <th className={`${styles.th} ${styles.thCenter}`}>Session</th>
              <th className={`${styles.th} ${styles.thRight}`}>Created</th>
            </tr>
          </thead>
          <tbody>
            {scratchWorkspaces.map((ws) => {
              const wsState = workspaceStates?.get(ws.id);
              const isDismissed = dismissedIdle?.has(ws.id);
              return (
                <tr
                  key={ws.id}
                  className={styles.row}
                  onClick={() => { window.location.hash = `/workspace/${ws.id}`; }}
                >
                  <td className={styles.cell}>
                    <span className={styles.bookmark}>{ws.bookmark}</span>
                    {ws.summary && (
                      <div className={styles.summaryPreview}>
                        {ws.summary.split('\n').find(l => l.trim() && !l.startsWith('#'))?.slice(0, 120) || ws.summary.slice(0, 120)}
                        {ws.summary.length > 120 ? '...' : ''}
                      </div>
                    )}
                  </td>
                  <td className={styles.cell}>
                    {ws.repo && <span className={styles.repoTag}>{ws.repo}</span>}
                  </td>
                  <td className={`${styles.cell} ${styles.cellCenter}`}>
                    <SessionBadge state={wsState} dismissed={isDismissed} />
                  </td>
                  <td className={`${styles.cell} ${styles.cellRight}`}>
                    <span className={styles.timeLabel}>{getRelativeTime(ws.created_at)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        !showNewWork && <p className={styles.emptyText}>No scratch workspaces. Click "New Work" to start.</p>
      )}
    </div>
  );
}

function SessionBadge({ state, dismissed }) {
  if (state === 'working')
    return (
      <Badge color="violet" title="Claude is actively working">
        <span className={styles.spinner} />
        Working
      </Badge>
    );
  if (state === 'idle' && !dismissed)
    return (
      <Badge color="amber" pulse title="Session waiting for input - needs attention">
        Waiting
      </Badge>
    );
  if (state === 'idle' && dismissed)
    return (
      <Badge color="gray" title="Session idle (already seen)">
        Idle
      </Badge>
    );
  return null;
}
