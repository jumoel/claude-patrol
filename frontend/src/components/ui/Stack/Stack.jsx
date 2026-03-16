const GAP_CLASSES = {
  1: 'gap-1',
  2: 'gap-2',
  3: 'gap-3',
  4: 'gap-4',
  5: 'gap-5',
  6: 'gap-6',
};

const ALIGN_CLASSES = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  baseline: 'items-baseline',
  stretch: 'items-stretch',
};

const JUSTIFY_CLASSES = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
};

/**
 * Flex layout component for horizontal and vertical stacking.
 * @param {{
 *   gap: 1 | 2 | 3 | 4 | 5 | 6,
 *   direction?: 'row' | 'col',
 *   align?: 'start' | 'center' | 'end' | 'baseline' | 'stretch',
 *   justify?: 'start' | 'center' | 'end' | 'between',
 *   wrap?: boolean,
 *   as?: string,
 *   className?: string,
 *   children: React.ReactNode,
 *   [key: string]: any,
 * }} props
 */
export function Stack({
  gap,
  direction = 'row',
  align,
  justify,
  wrap = false,
  as: Tag = 'div',
  className,
  children,
  ...rest
}) {
  const defaultAlign = direction === 'row' ? 'center' : 'stretch';
  const resolvedAlign = align || defaultAlign;

  const classes = [
    'flex',
    direction === 'col' ? 'flex-col' : undefined,
    GAP_CLASSES[gap],
    ALIGN_CLASSES[resolvedAlign],
    justify ? JUSTIFY_CLASSES[justify] : undefined,
    wrap ? 'flex-wrap' : undefined,
    className,
  ].filter(Boolean).join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
