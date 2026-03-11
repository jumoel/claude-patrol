import { useState, useCallback, useRef } from 'react';

/**
 * Pointer-based drag resize logic. Returns state and event handlers.
 *
 * @param {{ initial: number, min: number, max: number, direction: 'up' | 'down', onPersist?: (height: number) => void }} opts
 *   - direction 'up': dragging up increases height (bottom-anchored drawer)
 *   - direction 'down': dragging down increases height (top-anchored container)
 */
export function useResizeHandle({ initial, min, max, direction = 'down', onPersist }) {
  const [height, setHeight] = useState(initial);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef(null);

  const onPointerDown = useCallback((e) => {
    e.preventDefault();
    dragStartRef.current = { y: e.clientY, height };
    setDragging(true);
    e.target.setPointerCapture(e.pointerId);
  }, [height]);

  const onPointerMove = useCallback((e) => {
    if (!dragStartRef.current) return;
    const rawDelta = e.clientY - dragStartRef.current.y;
    const delta = direction === 'up' ? -rawDelta : rawDelta;
    const newHeight = Math.min(max, Math.max(min, dragStartRef.current.height + delta));
    setHeight(newHeight);
  }, [min, max, direction]);

  const onPointerUp = useCallback(() => {
    if (!dragStartRef.current) return;
    dragStartRef.current = null;
    setDragging(false);
    if (onPersist) {
      setHeight(h => { onPersist(h); return h; });
    }
  }, [onPersist]);

  const handleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  return { height, setHeight, dragging, handleProps };
}
