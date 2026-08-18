import { useCallback, useEffect, useState } from 'react';
import { useSyncEvents } from '../../hooks/useSyncEvents.js';
import {
  createSession as apiCreateSession,
  destroyWorkspace as apiDestroyWorkspace,
  killSession as apiKillSession,
  reattachSession as apiReattachSession,
  fetchSessionHistory,
  fetchSessions,
  fetchSessionTranscript,
  fetchWorkspace,
} from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { getRelativeTime } from '../../lib/time.js';
import shared from '../../styles/shared.module.css';
import { TerminalCard } from '../TerminalCard/TerminalCard.jsx';
import { TranscriptViewer } from '../TranscriptViewer/TranscriptViewer.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { Button } from '../ui/Button/Button.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './WorkspaceDetail.module.css';

/**
 * Scratch workspace detail view.
 * @param {{
 *   workspaceId: string,
 *   onBack: () => void,
 *   workspaceStates: Map<string, 'working' | 'idle'>,
 *   codexReviewCapability: import('../../types').CodexReviewCapability,
 * }} props
 */
export function WorkspaceDetail({ workspaceId, onBack, workspaceStates, codexReviewCapability }) {
  const [workspace, setWorkspace] = useState(/** @type {import('../../types').Workspace | null} */ (null));
  const [session, setSession] = useState(/** @type {import('../../types').Session | null} */ (null));
  const [loading, setLoading] = useState(true);
  const [openingSession, setOpeningSession] = useState(false);
  const [openingError, setOpeningError] = useState('');

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

  useEffect(() => {
    loadData();
  }, [loadData]);
  useSyncEvents(loadData);

  const handleStartSession = useCallback(async () => {
    if (!workspace) return;
    setOpeningSession(true);
    setOpeningError('');
    try {
      const sess = await apiCreateSession(workspace.id);
      setSession(sess);
    } catch (err) {
      console.error('Failed to create session:', err);
      setOpeningError(getErrorMessage(err, 'Failed to start Claude'));
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

  const handleSessionExit = useCallback(() => {
    setSession(null);
  }, []);

  const handleReattach = useCallback(async () => {
    if (!session) return;
    try {
      const updated = await apiReattachSession(session.id);
      setSession(updated);
    } catch (err) {
      console.error('Failed to reattach session:', err);
    }
  }, [session]);

  const handleDestroy = useCallback(() => {
    if (!workspace) return;
    // Navigate back immediately — destroy runs in the background
    onBack();
    apiDestroyWorkspace(workspace.id).catch((err) => {
      console.error('Failed to destroy workspace:', err);
    });
  }, [workspace, onBack]);

  // Auto-redirect to PR detail when a scratch workspace gets adopted
  useEffect(() => {
    if (workspace?.pr_id && !workspace.repo) {
      window.location.hash = `/pr/${encodeURIComponent(workspace.pr_id)}`;
    }
  }, [workspace?.pr_id, workspace?.repo]);

  if (loading) return <div className={shared.loading}>Loading workspace...</div>;
  if (!workspace) return <div className={shared.error}>Workspace not found</div>;

  const adopted = workspace.pr_id && !workspace.repo;

  return (
    <Box pb={16}>
      <Stack direction="col" gap={4}>
        {/* Header */}
        <Box p={5} border rounded="lg" bg="white">
          <Stack direction="col" gap={3}>
            <Stack justify="between">
              <Button size="md" onClick={onBack}>
                &larr; Back
              </Button>
              <Stack gap={2}>
                {workspace.status === 'active' && (
                  <Button variant="danger" size="sm" onClick={handleDestroy}>
                    Destroy
                  </Button>
                )}
              </Stack>
            </Stack>
            <div className={styles.title}>{workspace.bookmark}</div>
            <Stack gap={2} wrap className={shared.identityRow}>
              {workspace.repo && <span className={shared.repoTag}>{workspace.repo}</span>}
              <span className={shared.branchTag}>{workspace.bookmark}</span>
              <span className={shared.separator}>-</span>
              <span className={shared.updatedText}>Created {getRelativeTime(workspace.created_at)}</span>
              {workspace.status === 'destroyed' && <Badge color="red">Destroyed</Badge>}
            </Stack>
            {adopted && (
              <div className={styles.adoptedNotice}>
                Adopted by PR -{' '}
                <a href={`#/pr/${encodeURIComponent(workspace.pr_id || '')}`} className={styles.prLink}>
                  View PR
                </a>
              </div>
            )}
          </Stack>
        </Box>

        {/* Terminal */}
        {workspace.status === 'active' &&
          (session ? (
            <TerminalCard
              session={session}
              title={`Terminal - ${workspace.bookmark}`}
              onKill={handleKillSession}
              onExit={handleSessionExit}
              onReattach={handleReattach}
              workspaceId={workspace.id}
              prId={workspace.pr_id || undefined}
              sessionState={workspaceStates.get(workspace.id)}
              codexReviewCapability={codexReviewCapability}
            />
          ) : (
            <Box p={5} border rounded="lg" bg="white">
              <Stack direction="col" gap={3}>
                <Stack justify="between">
                  <h3 className={shared.sectionTitle}>Terminal</h3>
                </Stack>
                <Button
                  variant="primary"
                  size="lg"
                  onClick={handleStartSession}
                  disabled={openingSession}
                  aria-busy={openingSession}
                >
                  {openingSession && <span className={styles.spinner} aria-hidden="true" />}
                  {openingSession ? 'Starting session...' : 'Start Terminal Session'}
                </Button>
                {openingError && (
                  <p className={styles.launchError} role="alert">
                    {openingError}
                  </p>
                )}
              </Stack>
            </Box>
          ))}

        {/* Past Sessions */}
        <SessionHistory workspaceId={workspaceId} />
      </Stack>
    </Box>
  );
}

/** @param {{workspaceId: string}} props */
function SessionHistory({ workspaceId }) {
  const [history, setHistory] = useState(/** @type {import('../../types').Session[] | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [transcripts, setTranscripts] = useState(
    /** @type {Record<string, import('../../types').TranscriptEntry[]>} */ ({}),
  );
  const [transcriptLoading, setTranscriptLoading] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [transcriptErrors, setTranscriptErrors] = useState(/** @type {Record<string, string>} */ ({}));

  useEffect(() => {
    if (!expanded || history) return;
    setLoading(true);
    fetchSessionHistory(workspaceId)
      .then(setHistory)
      .catch((err) => console.error('Failed to load session history:', err))
      .finally(() => setLoading(false));
  }, [expanded, history, workspaceId]);

  const handleViewTranscript = useCallback(
    /** @param {string} sessionId */
    (sessionId) => {
      if (transcripts[sessionId]) {
        setTranscripts((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
        return;
      }
      setTranscriptLoading((prev) => ({ ...prev, [sessionId]: true }));
      fetchSessionTranscript(sessionId)
        .then((entries) => setTranscripts((prev) => ({ ...prev, [sessionId]: entries })))
        .catch((err) => setTranscriptErrors((prev) => ({ ...prev, [sessionId]: err.message })))
        .finally(() => setTranscriptLoading((prev) => ({ ...prev, [sessionId]: false })));
    },
    [transcripts],
  );

  /** @param {string | null} start @param {string | null} end */
  const formatDuration = (start, end) => {
    if (!start || !end) return '';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return '<1m';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  };

  return (
    <Box p={5} border rounded="lg" bg="white">
      <button
        onClick={() => setExpanded(!expanded)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: '#6b7280',
          fontSize: '14px',
          padding: 0,
        }}
      >
        {expanded ? 'Hide' : 'Show'} past sessions
      </button>
      {expanded && loading && <p className={shared.loading}>Loading...</p>}
      {expanded && history && history.length === 0 && (
        <p style={{ color: '#9ca3af', fontSize: '14px', marginTop: '8px' }}>No past sessions</p>
      )}
      {expanded && history && history.length > 0 && (
        <div style={{ marginTop: '8px' }}>
          {history.map((sess) => (
            <div key={sess.id}>
              <button className={styles.sessionRow} onClick={() => handleViewTranscript(sess.id)}>
                <Stack gap={3}>
                  <span style={{ fontSize: '14px', color: '#6b7280' }}>
                    {new Date(sess.started_at).toLocaleString()}
                  </span>
                  <span style={{ fontSize: '13px', color: '#9ca3af' }}>
                    {formatDuration(sess.started_at, sess.ended_at)}
                  </span>
                </Stack>
                <span className={`${styles.chevron} ${transcripts[sess.id] ? styles.chevronOpen : ''}`}>&#x25B8;</span>
              </button>
              {(transcripts[sess.id] || transcriptLoading[sess.id] || transcriptErrors[sess.id]) && (
                <TranscriptViewer
                  entries={transcripts[sess.id] || null}
                  loading={!!transcriptLoading[sess.id]}
                  error={transcriptErrors[sess.id] || null}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Box>
  );
}
