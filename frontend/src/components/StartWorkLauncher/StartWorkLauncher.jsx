import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { createManualWorkItem, createWorkItem } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { workItemPath } from '../../lib/routes.js';
import { AgentProviderButton } from '../AgentProviderButton/AgentProviderButton.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { RepoCombobox } from '../ui/RepoCombobox/RepoCombobox.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './StartWorkLauncher.module.css';

/** @typedef {'reference' | 'manual'} LauncherMode */

/**
 * @param {{
 *   workItemsConfigured: boolean,
 *   manualWorkConfigured: boolean,
 * }} props
 */
export function StartWorkLauncher({ workItemsConfigured, manualWorkConfigured }) {
  const { provider } = useAgentProvider();
  const triggerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(/** @type {LauncherMode} */ (workItemsConfigured ? 'reference' : 'manual'));
  const [reference, setReference] = useState('');
  const [referenceError, setReferenceError] = useState('');
  const [title, setTitle] = useState('');
  const [bookmark, setBookmark] = useState('');
  const [repositories, setRepositories] = useState(/** @type {string[]} */ ([]));
  const [manualError, setManualError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const closeOnNavigation = () => setOpen(false);
    window.addEventListener('hashchange', closeOnNavigation);
    return () => window.removeEventListener('hashchange', closeOnNavigation);
  }, []);

  const show = useCallback(() => {
    setMode(workItemsConfigured ? 'reference' : 'manual');
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
    if (nextMode === 'reference') setReferenceError('');
    else setManualError('');
  };

  const submitReference = useCallback(async () => {
    const trimmed = reference.trim();
    if (!trimmed) {
      setReferenceError('Enter a project reference.');
      return;
    }
    if (new TextEncoder().encode(trimmed).length > 512) {
      setReferenceError('Reference must be 512 UTF-8 bytes or fewer.');
      return;
    }
    setPending(true);
    setReferenceError('');
    try {
      const { work_item: item } = await createWorkItem(reference, provider);
      setOpen(false);
      setPending(false);
      window.location.hash = workItemPath(item.id);
    } catch (error) {
      setReferenceError(getErrorMessage(error, 'Failed to start work item'));
      setPending(false);
    }
  }, [provider, reference]);

  const submitManual = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setManualError('Enter a title.');
      return;
    }
    if (new TextEncoder().encode(trimmedTitle).length > 512) {
      setManualError('Title must be 512 UTF-8 bytes or fewer.');
      return;
    }
    if (repositories.length === 0) {
      setManualError('Select at least one repository.');
      return;
    }
    setPending(true);
    setManualError('');
    try {
      const { work_item: item } = await createManualWorkItem(trimmedTitle, repositories, bookmark);
      setOpen(false);
      setPending(false);
      window.location.hash = workItemPath(item.id);
    } catch (error) {
      setManualError(getErrorMessage(error, 'Failed to create work item'));
      setPending(false);
    }
  }, [bookmark, repositories, title]);

  const addRepository = useCallback((/** @type {string} */ repository) => {
    setRepositories((current) => (current.includes(repository) ? current : [...current, repository]));
  }, []);

  const removeRepository = useCallback((/** @type {string} */ repository) => {
    setRepositories((current) => current.filter((candidate) => candidate !== repository));
  }, []);

  return (
    <section className={styles.container}>
      <div ref={triggerRef}>
        <Button
          variant="primary"
          size="sm"
          filled
          onClick={open ? cancel : show}
          className={styles.trigger}
          aria-expanded={open}
          aria-controls="start-work-panel"
        >
          + Start work
        </Button>
      </div>
      {open && (
        <Box
          id="start-work-panel"
          role="dialog"
          aria-labelledby="start-work-title"
          p={0}
          border
          bg="white"
          className={styles.card}
        >
          <div className={styles.header}>
            <h2 id="start-work-title" className={styles.title}>
              Start work
            </h2>
            <fieldset className={styles.modeGroup} disabled={pending}>
              <legend className={styles.legend}>Workspace type</legend>
              <Stack gap={2} wrap className={styles.modeOptions}>
                <label className={`${styles.modeOption} ${mode === 'reference' ? styles.modeOptionActive : ''}`}>
                  <input
                    type="radio"
                    name="start-work-mode"
                    value="reference"
                    checked={mode === 'reference'}
                    onChange={() => changeMode('reference')}
                  />
                  <span>Project reference</span>
                </label>
                <label className={`${styles.modeOption} ${mode === 'manual' ? styles.modeOptionActive : ''}`}>
                  <input
                    type="radio"
                    name="start-work-mode"
                    value="manual"
                    checked={mode === 'manual'}
                    onChange={() => changeMode('manual')}
                  />
                  <span>Manual work</span>
                </label>
              </Stack>
            </fieldset>
            <Button size="xs" onClick={cancel} disabled={pending}>
              Cancel
            </Button>
          </div>
          <div className={styles.body}>
            {mode === 'reference' &&
              (workItemsConfigured ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!pending) submitReference();
                  }}
                >
                  <Stack gap={3} wrap align="end" className={styles.fields}>
                    <label className={styles.field}>
                      <span>Reference</span>
                      <input
                        id="start-work-reference"
                        name="work-reference"
                        value={reference}
                        onChange={(event) => setReference(event.target.value)}
                        placeholder="Project reference or URL"
                        maxLength={512}
                        disabled={pending}
                        autoFocus
                      />
                    </label>
                    <AgentProviderButton
                      variant="primary"
                      size="md"
                      onClick={submitReference}
                      disabled={pending || !reference.trim()}
                      providerDisabled={pending}
                      providerDisabledTitle="Provider cannot be changed while the work item is starting"
                      busy={pending}
                    >
                      {pending ? 'Creating work item...' : 'Create work item'}
                    </AgentProviderButton>
                  </Stack>
                  {referenceError && (
                    <p className={styles.error} role="alert">
                      {referenceError}
                    </p>
                  )}
                </form>
              ) : (
                <div className={styles.unconfigured}>
                  <p>Project references are not configured for this Patrol instance</p>
                  <a href="#/setup?section=work-items">Open Work Items settings</a>
                </div>
              ))}
            {mode === 'manual' &&
              (manualWorkConfigured ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!pending) submitManual();
                  }}
                >
                  <Stack gap={3} className={styles.manualFields}>
                    <Stack gap={3} wrap className={styles.fields}>
                      <label className={styles.field}>
                        <span>Title</span>
                        <input
                          name="manual-title"
                          value={title}
                          onChange={(event) => setTitle(event.target.value)}
                          placeholder="Describe the work"
                          maxLength={512}
                          disabled={pending}
                          autoFocus
                        />
                      </label>
                      <label className={styles.field}>
                        <span>Bookmark (optional)</span>
                        <input
                          name="manual-bookmark"
                          value={bookmark}
                          onChange={(event) => setBookmark(event.target.value)}
                          placeholder="Generated when omitted"
                          maxLength={255}
                          disabled={pending}
                        />
                      </label>
                    </Stack>
                    <fieldset className={styles.repositories} disabled={pending}>
                      <legend>Repositories</legend>
                      <div className={styles.repositoryPicker}>
                        <RepoCombobox
                          value=""
                          onChange={addRepository}
                          disabled={pending}
                          ariaLabel="Add repository"
                          excludedValues={repositories}
                        />
                      </div>
                      {repositories.length > 0 && (
                        <ul className={styles.selectedRepositories} aria-label="Selected repositories">
                          {repositories.map((repository) => (
                            <li key={repository} className={styles.selectedRepository}>
                              <span>{repository}</span>
                              <Button
                                type="button"
                                size="xs"
                                onClick={() => removeRepository(repository)}
                                disabled={pending}
                                aria-label={`Remove ${repository}`}
                              >
                                Remove
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </fieldset>
                    <Button
                      type="submit"
                      variant="primary"
                      size="md"
                      filled
                      disabled={pending || !title.trim() || repositories.length === 0}
                      busy={pending}
                      className={styles.manualSubmit}
                    >
                      {pending ? 'Creating work item...' : 'Create work item'}
                    </Button>
                  </Stack>
                  {manualError && (
                    <p className={styles.error} role="alert">
                      {manualError}
                    </p>
                  )}
                </form>
              ) : (
                <div className={styles.unconfigured}>
                  <p>No repositories are configured for manual work</p>
                  <a href="#/setup?section=repositories">Open Repository settings</a>
                </div>
              ))}
          </div>
        </Box>
      )}
    </section>
  );
}
