import { useEffect, useRef } from 'react';

const IDLE_THRESHOLD_MS = 5000;
const POLL_INTERVAL_MS = 1000;

/**
 * Fires a browser notification when a terminal session goes idle
 * (no output for IDLE_THRESHOLD_MS after activity). Only notifies
 * when the page is hidden and permission is granted.
 *
 * @param {string} sessionId
 * @param {import('react').MutableRefObject<number>} lastOutputRef - ref updated to Date.now() on each output
 */
export function useIdleNotification(sessionId, lastOutputRef) {
  const notifiedRef = useRef(false);

  useEffect(() => {
    if (!sessionId) return;

    const interval = setInterval(() => {
      const lastOutput = lastOutputRef.current;
      if (!lastOutput) return; // no output yet

      const elapsed = Date.now() - lastOutput;

      if (elapsed >= IDLE_THRESHOLD_MS && !notifiedRef.current && document.hidden) {
        if (Notification.permission === 'granted') {
          new Notification('Claude is waiting', {
            body: 'A terminal session needs your attention.',
            tag: `patrol-idle-${sessionId}`, // deduplicates
          });
        }
        notifiedRef.current = true;
      }

      // Reset notification flag once activity resumes
      if (elapsed < IDLE_THRESHOLD_MS) {
        notifiedRef.current = false;
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [sessionId]);
}
