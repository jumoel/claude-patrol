import { useEffect, useRef } from 'react';

/**
 * Calls `callback` when a mousedown occurs outside every referenced element.
 * @param {import('react').RefObject<HTMLElement | null> | import('react').RefObject<HTMLElement | null>[]} refs
 * @param {() => void} callback
 */
export function useClickOutside(refs, callback) {
  const refsRef = useRef(refs);
  const callbackRef = useRef(callback);
  refsRef.current = refs;
  callbackRef.current = callback;

  useEffect(() => {
    /** @param {MouseEvent} e */
    const handleClick = (e) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      const currentRefs = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      if (currentRefs.some((ref) => ref.current?.contains(target))) return;
      callbackRef.current();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);
}
