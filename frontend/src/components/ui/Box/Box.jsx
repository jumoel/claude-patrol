const PADDING = /* @__PURE__ */ Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16].map((n) => [n, String(n)]),
);

const P_PREFIX = { p: 'p', px: 'px', py: 'py', pt: 'pt', pb: 'pb', pl: 'pl', pr: 'pr' };

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

function pad(prefix, value) {
  if (value == null || !PADDING[value]) return undefined;
  return `${prefix}-${PADDING[value]}`;
}

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
    pad('p', p),
    pad('px', px),
    pad('py', py),
    pad('pt', pt),
    pad('pb', pb),
    pad('pl', pl),
    pad('pr', pr),
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
