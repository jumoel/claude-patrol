import { useCallback, useState } from 'react';
import { destroyWorkspace } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './WorkspaceControls.module.css';

/**
 * Workspace destroy controls for a PR.
 * @param {{ workspace: import('../../types').Workspace, onUpdate: () => void }} props
 */
export function WorkspaceControls({ workspace, onUpdate }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [confirmDestroy, setConfirmDestroy] = useState(false);

  const handleDestroy = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);
    try {
      await destroyWorkspace(workspace.id);
      setConfirmDestroy(false);
      onUpdate();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [workspace, onUpdate]);

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
          <Button variant="danger" size="md" filled onClick={handleDestroy} disabled={loading} busy={loading}>
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
