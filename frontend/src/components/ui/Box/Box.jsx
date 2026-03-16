const ROUNDED_CLASSES = {
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  full: 'rounded-full',
  none: 'rounded-none',
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
    p != null ? `p-${p}` : undefined,
    px != null ? `px-${px}` : undefined,
    py != null ? `py-${py}` : undefined,
    pt != null ? `pt-${pt}` : undefined,
    pb != null ? `pb-${pb}` : undefined,
    pl != null ? `pl-${pl}` : undefined,
    pr != null ? `pr-${pr}` : undefined,
    border ? (borderSide ? `border-${borderSide}` : 'border') : undefined,
    border ? `border-${borderColor}` : undefined,
    rounded ? ROUNDED_CLASSES[rounded] : undefined,
    bg ? `bg-${bg}` : undefined,
    className,
  ].filter(Boolean).join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
