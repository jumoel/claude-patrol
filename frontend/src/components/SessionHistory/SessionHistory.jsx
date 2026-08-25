import { useCallback, useEffect, useState } from 'react';
import { fetchSessionHistory, fetchSessionTranscript } from '../../lib/api.js';
import { getErrorMessage } from '../../lib/errors.js';
import { TranscriptViewer } from '../TranscriptViewer/TranscriptViewer.jsx';
import { Box } from '../ui/Box/Box.jsx';
import { LoadingIndicator } from '../ui/LoadingIndicator/LoadingIndicator.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './SessionHistory.module.css';

/** @param {string | null} start @param {string | null} end */
function formatSessionDuration(start, end) {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** @param {{target: import('../../types').SessionTarget}} props */
export function SessionHistory({ target }) {
  const targetType = target.type;
  const targetId = target.type === 'global' ? null : target.id;
  const [history, setHistory] = useState(/** @type {import('../../types').Session[] | null} */ (null));
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [openTranscripts, setOpenTranscripts] = useState(/** @type {Set<string>} */ (new Set()));
  const [transcripts, setTranscripts] = useState(
    /** @type {Record<string, import('../../types').TranscriptEntry[]>} */ ({}),
  );
  const [transcriptLoading, setTranscriptLoading] = useState(/** @type {Record<string, boolean>} */ ({}));
  const [transcriptErrors, setTranscriptErrors] = useState(/** @type {Record<string, string>} */ ({}));

  useEffect(() => {
    if (!expanded || history) return;
    setLoading(true);
    setHistoryError('');
    const stableTarget =
      targetType === 'global' ? { type: /** @type {'global'} */ ('global') } : { type: targetType, id: targetId || '' };
    fetchSessionHistory(stableTarget)
      .then(setHistory)
      .catch((error) => setHistoryError(getErrorMessage(error, 'Failed to load past sessions')))
      .finally(() => setLoading(false));
  }, [expanded, history, targetType, targetId]);

  const handleViewTranscript = useCallback(
    /** @param {string} sessionId */
    (sessionId) => {
      if (openTranscripts.has(sessionId)) {
        setOpenTranscripts((previous) => {
          const next = new Set(previous);
          next.delete(sessionId);
          return next;
        });
        return;
      }

      setOpenTranscripts((previous) => new Set(previous).add(sessionId));
      if (transcripts[sessionId] || transcriptLoading[sessionId]) return;

      setTranscriptLoading((previous) => ({ ...previous, [sessionId]: true }));
      setTranscriptErrors((previous) => {
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
      fetchSessionTranscript(sessionId)
        .then((entries) => setTranscripts((previous) => ({ ...previous, [sessionId]: entries })))
        .catch((error) =>
          setTranscriptErrors((previous) => ({
            ...previous,
            [sessionId]: getErrorMessage(error, 'Failed to load transcript'),
          })),
        )
        .finally(() => setTranscriptLoading((previous) => ({ ...previous, [sessionId]: false })));
    },
    [openTranscripts, transcriptLoading, transcripts],
  );

  return (
    <Box p={5} border rounded="lg" bg="white">
      <Stack direction="col" gap={3}>
        <button className={styles.toggleButton} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Hide' : 'Show'} past sessions
        </button>
        {expanded && loading && (
          <LoadingIndicator className={styles.loading}>Loading past sessions...</LoadingIndicator>
        )}
        {expanded && historyError && (
          <p className={styles.error} role="alert">
            {historyError}
          </p>
        )}
        {expanded && history?.length === 0 && <p className={styles.empty}>No past sessions</p>}
        {expanded && history && history.length > 0 && (
          <div className={styles.list}>
            {history.map((session) => {
              const transcriptOpen = openTranscripts.has(session.id);
              const transcriptAvailable = session.provider === 'claude';
              const sessionInfo = (
                <Stack gap={2} className={styles.sessionInfo}>
                  <span className={styles.provider}>{session.provider === 'codex' ? 'Codex' : 'Claude'}</span>
                  <span className={styles.startedAt}>{new Date(session.started_at).toLocaleString()}</span>
                  <span className={styles.duration}>{formatSessionDuration(session.started_at, session.ended_at)}</span>
                </Stack>
              );
              return (
                <div key={session.id}>
                  {transcriptAvailable ? (
                    <button className={styles.sessionRow} onClick={() => handleViewTranscript(session.id)}>
                      {sessionInfo}
                      <span className={`${styles.chevron} ${transcriptOpen ? styles.chevronOpen : ''}`}>&#x25B8;</span>
                    </button>
                  ) : (
                    <div className={`${styles.sessionRow} ${styles.sessionRowUnavailable}`}>
                      {sessionInfo}
                      <span className={styles.unavailable}>Transcript unavailable</span>
                    </div>
                  )}
                  {transcriptOpen && (
                    <TranscriptViewer
                      entries={transcripts[session.id] || null}
                      loading={!!transcriptLoading[session.id]}
                      error={transcriptErrors[session.id] || null}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Stack>
    </Box>
  );
}
