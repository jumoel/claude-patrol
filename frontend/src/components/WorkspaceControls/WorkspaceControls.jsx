import { useState, useCallback } from 'react';
import { createWorkspace, destroyWorkspace } from '../../lib/api.js';
import styles from './WorkspaceControls.module.css';

/**
 * Workspace create/destroy controls for a PR.
 * @param {{ prId: string, workspace: object | null, onUpdate: () => void }} props
 */
export function WorkspaceControls({ prId, workspace, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const handleCreate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await createWorkspace(prId);
      onUpdate();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [prId, onUpdate]);

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

  if (!workspace) {
    return (
      <div className={styles.controls}>
        <button className={styles.createButton} onClick={handleCreate} disabled={loading}>
          {loading ? 'Creating...' : 'Create Workspace'}
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    );
  }

  return (
    <div className={styles.controls}>
      <span className={styles.activeBadge}>Workspace active</span>
      <span className={styles.path}>{workspace.path}</span>
      {!confirmDestroy ? (
        <button className={styles.destroyButton} onClick={() => setConfirmDestroy(true)} disabled={loading}>
          Destroy
        </button>
      ) : (
        <div className={styles.confirmRow}>
          <span className={styles.confirmText}>Are you sure?</span>
          <button className={styles.confirmYes} onClick={handleDestroy} disabled={loading}>
            {loading ? 'Destroying...' : 'Yes, destroy'}
          </button>
          <button className={styles.confirmNo} onClick={() => setConfirmDestroy(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
