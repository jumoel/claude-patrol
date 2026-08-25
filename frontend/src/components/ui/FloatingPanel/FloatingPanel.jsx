import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './FloatingPanel.module.css';

const VIEWPORT_MARGIN = 8;

/**
 * Render anchored floating content at the document root so layout overflow and
 * stacking contexts cannot clip it.
 *
 * @param {{
 *   anchorRef: React.RefObject<HTMLElement | null>,
 *   layerRef?: React.RefObject<HTMLDivElement | null>,
 *   align?: 'start' | 'end',
 *   gap?: number,
 *   matchAnchorWidth?: boolean,
 *   className?: string,
 *   children: React.ReactNode,
 * } & React.HTMLAttributes<HTMLDivElement>} props
 */
export function FloatingPanel({
  anchorRef,
  layerRef: externalLayerRef,
  align = 'start',
  gap = 4,
  matchAnchorWidth = false,
  className = '',
  children,
  ...rest
}) {
  const internalLayerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const layerRef = externalLayerRef ?? internalLayerRef;
  const [position, setPosition] = useState(
    /** @type {{top: number, left: number, maxHeight: number, minWidth?: number} | null} */ (null),
  );

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const layer = layerRef.current;
    if (!anchor || !layer) return;

    const anchorRect = anchor.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    const availableBelow = window.innerHeight - anchorRect.bottom - gap - VIEWPORT_MARGIN;
    const availableAbove = anchorRect.top - gap - VIEWPORT_MARGIN;
    const openAbove = layerRect.height > availableBelow && availableAbove > availableBelow;
    const maxHeight = Math.max(0, openAbove ? availableAbove : availableBelow);
    const effectiveHeight = Math.min(layerRect.height, maxHeight);
    const top = openAbove ? anchorRect.top - gap - effectiveHeight : anchorRect.bottom + gap;
    const minWidth = matchAnchorWidth ? anchorRect.width : undefined;
    const effectiveWidth = Math.max(minWidth ?? 0, Math.min(layerRect.width, window.innerWidth - VIEWPORT_MARGIN * 2));
    const preferredLeft = align === 'end' ? anchorRect.right - effectiveWidth : anchorRect.left;
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(preferredLeft, window.innerWidth - VIEWPORT_MARGIN - effectiveWidth),
    );
    const next = { top: Math.max(VIEWPORT_MARGIN, top), left, maxHeight, minWidth };

    setPosition((current) =>
      current &&
      current.top === next.top &&
      current.left === next.left &&
      current.maxHeight === next.maxHeight &&
      current.minWidth === next.minWidth
        ? current
        : next,
    );
  }, [align, anchorRef, gap, layerRef, matchAnchorWidth]);

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (layerRef.current) observer?.observe(layerRef.current);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      observer?.disconnect();
    };
  }, [anchorRef, layerRef, updatePosition]);

  return createPortal(
    <div
      ref={layerRef}
      className={styles.layer}
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        maxHeight: position?.maxHeight,
        minWidth: position?.minWidth,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      <div className={`${styles.content} ${className}`} {...rest}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
