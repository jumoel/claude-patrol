import { useCallback, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { createScratchWorkspace, createWorkItem } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { RepoCombobox } from '../ui/RepoCombobox/RepoCombobox.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './StartWorkLauncher.module.css';

/** @typedef {'project' | 'scratch'} LauncherMode */

/** @param {{workItemsConfigured: boolean}} props */
export function StartWorkLauncher({ workItemsConfigured }) {
  const { provider } = useAgentProvider();
  const triggerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(/** @type {LauncherMode} */ (workItemsConfigured ? 'project' : 'scratch'));
  const [reference, setReference] = useState('');
  const [projectError, setProjectError] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('');
  const [scratchError, setScratchError] = useState('');
  const [pending, setPending] = useState(false);

  const show = useCallback(() => {
    setMode(workItemsConfigured ? 'project' : 'scratch');
    setOpen(true);
  }, [workItemsConfigured]);

  const cancel = useCallback(() => {
    if (pending) return;
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.querySelector('button')?.focus());
  }, [pending]);

  /** @param {LauncherMode} nextMode */
  const changeMode = (nextMode) => {
    if (pending) return;
    setMode(nextMode);
    if (nextMode === 'project') setProjectError('');
    else setScratchError('');
  };

  const submitProject = useCallback(async () => {
    const trimmed = reference.trim();
    if (!trimmed) {
      setProjectError('Enter a project reference.');
      return;
    }
    if (new TextEncoder().encode(trimmed).length > 512) {
      setProjectError('Reference must be 512 UTF-8 bytes or fewer.');
      return;
    }
    setPending(true);
    setProjectError('');
    try {
      const { work_item: item } = await createWorkItem(reference, provider);
      window.location.hash = `/work-item/${item.id}`;
    } catch (error) {
      setProjectError(getErrorMessage(error, 'Failed to start work item'));
      setPending(false);
    }
  }, [provider, reference]);

  const submitScratch = useCallback(async () => {
    if (!repo || !branch.trim()) {
      setScratchError('Select a repository and enter a branch.');
      return;
    }
    setPending(true);
    setScratchError('');
    try {
      const workspace = await createScratchWorkspace(repo, branch.trim());
      window.location.hash = `/workspace/${workspace.id}`;
    } catch (error) {
      setScratchError(getErrorMessage(error, 'Failed to create scratch workspace'));
      setPending(false);
    }
  }, [branch, repo]);

  return (
    <section className={styles.container}>
      {!open ? (
        <div ref={triggerRef}>
          <Button variant="primary" size="md" filled onClick={show}>
            + Start work
          </Button>
        </div>
      ) : (
        <Box p={5} border rounded="lg" bg="white" className={styles.card}>
          <Stack direction="col" gap={4}>
            <Stack justify="between" wrap className={styles.header}>
              <div>
                <h2 className={styles.title}>Start work</h2>
                <p className={styles.subtitle}>Choose the kind of isolated workspace to create.</p>
              </div>
              <Button size="sm" onClick={cancel} disabled={pending}>
                Cancel
              </Button>
            </Stack>
            <fieldset className={styles.modeGroup} disabled={pending}>
              <legend className={styles.legend}>Workspace type</legend>
              <Stack gap={2} wrap className={styles.modeOptions}>
                <label className={`${styles.modeOption} ${mode === 'project' ? styles.modeOptionActive : ''}`}>
                  <input
                    type="radio"
                    name="start-work-mode"
                    value="project"
                    checked={mode === 'project'}
                    onChange={() => changeMode('project')}
                  />
                  <span>
                    <strong>Project reference</strong>
                    <small>Resolve one reference into one or more repositories.</small>
                  </span>
                </label>
                <label className={`${styles.modeOption} ${mode === 'scratch' ? styles.modeOptionActive : ''}`}>
                  <input
                    type="radio"
                    name="start-work-mode"
                    value="scratch"
                    checked={mode === 'scratch'}
                    onChange={() => changeMode('scratch')}
                  />
                  <span>
                    <strong>Scratch repository</strong>
                    <small>Create one checkout and start an agent later.</small>
                  </span>
                </label>
              </Stack>
            </fieldset>
            {mode === 'project' &&
              (workItemsConfigured ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!pending) submitProject();
                  }}
                >
                  <Stack direction="col" gap={3}>
                    <label className={styles.field}>
                      <span>Reference</span>
                      <input
                        id="start-work-reference"
                        name="work-reference"
                        value={reference}
                        onChange={(event) => setReference(event.target.value)}
                        placeholder="ECO-3632 or another project reference"
                        maxLength={512}
                        disabled={pending}
                        autoFocus
                      />
                    </label>
                    <p className={styles.helper}>
                      Your configured resolver finds the work item and chooses its repositories.
                    </p>
                    {projectError && (
                      <p className={styles.error} role="alert">
                        {projectError}
                      </p>
                    )}
                    <AgentProviderButton
                      variant="primary"
                      size="md"
                      onClick={submitProject}
                      disabled={pending || !reference.trim()}
                      providerDisabled={pending}
                      providerDisabledTitle="Provider cannot be changed while the work item is starting"
                      busy={pending}
                    >
                      {pending ? 'Starting work item...' : 'Start work item'}
                    </AgentProviderButton>
                  </Stack>
                </form>
              ) : (
                <div className={styles.unconfigured}>
                  <p>Project references are not configured for this Patrol instance</p>
                  <a href="#/setup?section=work-items">Open Work Items settings</a>
                </div>
              ))}
            {mode === 'scratch' && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!pending) submitScratch();
                }}
              >
                <Stack gap={3} wrap align="end" className={styles.fields}>
                  <div className={styles.field}>
                    <span id="start-work-repository-label">Repository</span>
                    <RepoCombobox
                      value={repo}
                      onChange={setRepo}
                      disabled={pending}
                      ariaLabelledBy="start-work-repository-label"
                    />
                  </div>
                  <label className={`${styles.field} ${styles.branchField}`}>
                    <span>Branch</span>
                    <input
                      id="start-work-branch"
                      name="scratch-branch"
                      value={branch}
                      onChange={(event) => setBranch(event.target.value)}
                      placeholder="feat/my-feature"
                      disabled={pending}
                      autoFocus
                    />
                  </label>
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    filled
                    disabled={pending || !repo || !branch.trim()}
                  >
                    {pending ? 'Creating...' : 'Create scratch workspace'}
                  </Button>
                </Stack>
                {scratchError && (
                  <p className={styles.error} role="alert">
                    {scratchError}
                  </p>
                )}
              </form>
            )}
          </Stack>
        </Box>
      )}
    </section>
  );
}
