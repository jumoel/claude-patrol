import { useCallback, useState } from 'react';
import { destroyWorkspace } from '../../lib/api.js';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
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
      <Stack gap={3} wrap>
        <Button variant="primary" size="lg" filled onClick={handleCreate} disabled={busy}>
          {busy ? 'Creating workspace...' : 'Create Workspace'}
        </Button>
        {error && <p className={styles.error}>{error}</p>}
      </Stack>
    );
  }

  return (
    <Stack gap={3} wrap>
      <Badge color="green">Workspace active</Badge>
      <span className={styles.path}>{workspace.path}</span>
      {!confirmDestroy ? (
        <Button variant="danger" size="md" onClick={() => setConfirmDestroy(true)} disabled={loading}>
          Destroy
        </Button>
      ) : (
        <Stack gap={2}>
          <span className={styles.confirmText}>Are you sure?</span>
          <Button variant="danger" size="md" filled onClick={handleDestroy} disabled={loading}>
            {loading ? 'Destroying...' : 'Yes, destroy'}
          </Button>
          <Button size="md" onClick={() => setConfirmDestroy(false)}>
            Cancel
          </Button>
        </Stack>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </Stack>
  );
}
