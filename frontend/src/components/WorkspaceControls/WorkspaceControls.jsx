import { useCallback, useState } from 'react';
import { destroyWorkspace } from '../../lib/api.js';
import { Button } from '../ui/Button/Button.jsx';
import styles from './WorkspaceControls.module.css';

/**
 * Workspace create/destroy controls for a PR.
 * @param {{ prId: string, workspace: object | null, onUpdate: () => void, getOrCreateWorkspace?: () => Promise<object>, claudeWaiting?: boolean }} props
 */
export function WorkspaceControls({ workspace, onUpdate, getOrCreateWorkspace, claudeWaiting }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!getOrCreateWorkspace) return;
    setLoading(true);
    setError(null);
    try {
      await getOrCreateWorkspace();
      onUpdate();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [getOrCreateWorkspace, onUpdate]);

  const handleDestroy = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      await destroyWorkspace(workspace.id);
      setConfirmDestroy(false);
      onUpdate();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [workspace, onUpdate]);

  const busy = loading || claudeWaiting;

  if (!workspace) {
    return (
      <div className={styles.controls}>
        <Button variant="primary" size="lg" filled onClick={handleCreate} disabled={busy}>
          {busy ? 'Creating workspace...' : 'Create Workspace'}
        </Button>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    );
  }

  return (
    <div className={styles.controls}>
      <span className={styles.activeBadge}>Workspace active</span>
      <span className={styles.path}>{workspace.path}</span>
      {!confirmDestroy ? (
        <Button variant="danger" size="md" onClick={() => setConfirmDestroy(true)} disabled={loading}>
          Destroy
        </Button>
      ) : (
        <div className={styles.confirmRow}>
          <span className={styles.confirmText}>Are you sure?</span>
          <Button variant="danger" size="md" filled onClick={handleDestroy} disabled={loading}>
            {loading ? 'Destroying...' : 'Yes, destroy'}
          </Button>
          <Button size="md" onClick={() => setConfirmDestroy(false)}>
            Cancel
          </Button>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
