import { useEffect } from 'react';

/**
 * Calls `callback` when a mousedown occurs outside the element referenced by `ref`.
 * @param {import('react').RefObject<HTMLElement>} ref
 * @param {() => void} callback
 */
export function useClickOutside(ref, callback) {
  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) callback();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [ref, callback]);
}
