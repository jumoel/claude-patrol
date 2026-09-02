import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Clipboard write with a short "Copied" acknowledgement that resets itself
 * and never fires setState after unmount.
 *
 * @param {{ resetMs?: number }} [options]
 * @returns {{
 *   status: 'idle' | 'copied' | 'error',
 *   marker: string | null,
 *   copy: (text: string, marker?: string) => Promise<void>,
 * }} `marker` identifies which of several buttons was copied, when a
 *   component renders more than one.
 */
export function useCopyFeedback({ resetMs = 1500 } = {}) {
  const [state, setState] = useState(
    /** @type {{ status: 'idle' | 'copied' | 'error', marker: string | null }} */ ({ status: 'idle', marker: null }),
  );
  const timer = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(
    async (/** @type {string} */ text, /** @type {string} */ marker = text) => {
      if (timer.current) clearTimeout(timer.current);
      try {
        await navigator.clipboard.writeText(text);
        setState({ status: 'copied', marker });
      } catch {
        setState({ status: 'error', marker });
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        setState({ status: 'idle', marker: null });
      }, resetMs);
    },
    [resetMs],
  );

  return { status: state.status, marker: state.marker, copy };
}
