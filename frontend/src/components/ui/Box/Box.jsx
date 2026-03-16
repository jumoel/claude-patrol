const P_CLASSES = {
  0: 'p-0', 1: 'p-1', 2: 'p-2', 3: 'p-3', 4: 'p-4', 5: 'p-5', 6: 'p-6',
  7: 'p-7', 8: 'p-8', 9: 'p-9', 10: 'p-10', 11: 'p-11', 12: 'p-12', 14: 'p-14', 16: 'p-16',
};

const PX_CLASSES = {
  0: 'px-0', 1: 'px-1', 2: 'px-2', 3: 'px-3', 4: 'px-4', 5: 'px-5', 6: 'px-6',
  7: 'px-7', 8: 'px-8', 9: 'px-9', 10: 'px-10', 11: 'px-11', 12: 'px-12', 14: 'px-14', 16: 'px-16',
};

const PY_CLASSES = {
  0: 'py-0', 1: 'py-1', 2: 'py-2', 3: 'py-3', 4: 'py-4', 5: 'py-5', 6: 'py-6',
  7: 'py-7', 8: 'py-8', 9: 'py-9', 10: 'py-10', 11: 'py-11', 12: 'py-12', 14: 'py-14', 16: 'py-16',
};

const PT_CLASSES = {
  0: 'pt-0', 1: 'pt-1', 2: 'pt-2', 3: 'pt-3', 4: 'pt-4', 5: 'pt-5', 6: 'pt-6',
  7: 'pt-7', 8: 'pt-8', 9: 'pt-9', 10: 'pt-10', 11: 'pt-11', 12: 'pt-12', 14: 'pt-14', 16: 'pt-16',
};

const PB_CLASSES = {
  0: 'pb-0', 1: 'pb-1', 2: 'pb-2', 3: 'pb-3', 4: 'pb-4', 5: 'pb-5', 6: 'pb-6',
  7: 'pb-7', 8: 'pb-8', 9: 'pb-9', 10: 'pb-10', 11: 'pb-11', 12: 'pb-12', 14: 'pb-14', 16: 'pb-16',
};

const PL_CLASSES = {
  0: 'pl-0', 1: 'pl-1', 2: 'pl-2', 3: 'pl-3', 4: 'pl-4', 5: 'pl-5', 6: 'pl-6',
  7: 'pl-7', 8: 'pl-8', 9: 'pl-9', 10: 'pl-10', 11: 'pl-11', 12: 'pl-12', 14: 'pl-14', 16: 'pl-16',
};

const PR_CLASSES = {
  0: 'pr-0', 1: 'pr-1', 2: 'pr-2', 3: 'pr-3', 4: 'pr-4', 5: 'pr-5', 6: 'pr-6',
  7: 'pr-7', 8: 'pr-8', 9: 'pr-9', 10: 'pr-10', 11: 'pr-11', 12: 'pr-12', 14: 'pr-14', 16: 'pr-16',
};

const ROUNDED_CLASSES = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  full: 'rounded-full',
  none: 'rounded-none',
};

const BORDER_SIDE_CLASSES = {
  t: 'border-t',
  b: 'border-b',
  l: 'border-l',
  r: 'border-r',
};

const BORDER_COLOR_CLASSES = {
  'gray-100': 'border-gray-100',
  'gray-200': 'border-gray-200',
  'gray-700': 'border-gray-700',
  'red-200': 'border-red-200',
};

const BG_CLASSES = {
  white: 'bg-white',
  'gray-900': 'bg-gray-900',
};

/**
 * Container component for padding, borders, and backgrounds.
 * @param {{
 *   p?: number,
 *   px?: number,
 *   py?: number,
 *   pt?: number,
 *   pb?: number,
 *   pl?: number,
 *   pr?: number,
 *   border?: boolean,
 *   borderColor?: string,
 *   borderSide?: 't' | 'b' | 'l' | 'r',
 *   rounded?: 'sm' | 'md' | 'lg' | 'xl' | 'full' | 'none',
 *   bg?: string,
 *   as?: string,
 *   className?: string,
 *   children: React.ReactNode,
 *   [key: string]: any,
 * }} props
 */
export function Box({
  p,
  px,
  py,
  pt,
  pb,
  pl,
  pr,
  border = false,
  borderColor = 'gray-200',
  borderSide,
  rounded,
  bg,
  as: Tag = 'div',
  className,
  children,
  ...rest
}) {
  const classes = [
    p != null ? P_CLASSES[p] : undefined,
    px != null ? PX_CLASSES[px] : undefined,
    py != null ? PY_CLASSES[py] : undefined,
    pt != null ? PT_CLASSES[pt] : undefined,
    pb != null ? PB_CLASSES[pb] : undefined,
    pl != null ? PL_CLASSES[pl] : undefined,
    pr != null ? PR_CLASSES[pr] : undefined,
    border ? (borderSide ? BORDER_SIDE_CLASSES[borderSide] : 'border') : undefined,
    border ? BORDER_COLOR_CLASSES[borderColor] : undefined,
    rounded ? ROUNDED_CLASSES[rounded] : undefined,
    bg ? BG_CLASSES[bg] : undefined,
    className,
  ].filter(Boolean).join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
