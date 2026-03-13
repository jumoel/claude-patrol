import { useEffect } from 'react';

/**
 * Calls `callback` when Escape is pressed, only while `active` is true.
 * @param {boolean} active
 * @param {() => void} callback
 */
export function useEscapeKey(active, callback) {
  useEffect(() => {
    if (!active) return;
    const handler = (e) => { if (e.key === 'Escape') callback(e); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [active, callback]);
}
