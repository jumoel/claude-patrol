import styles from './Button.module.css';

const SIZE_CLASSES = {
  xs: styles.xs,
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const VARIANT_CLASSES = {
  default: styles.default,
  primary: styles.primary,
  danger: styles.danger,
  success: styles.success,
  warning: styles.warning,
  ghost: styles.ghost,
};

const DARK_VARIANT_CLASSES = {
  default: styles.darkDefault,
  primary: styles.darkPrimary,
  danger: styles.darkDanger,
  success: styles.darkSuccess,
  warning: styles.darkWarning,
  ghost: styles.darkGhost,
};

const FILLED_CLASSES = {
  danger: styles.filledDanger,
  success: styles.filledSuccess,
  primary: styles.filledPrimary,
};

const DARK_FILLED_CLASSES = {
  danger: styles.darkFilledDanger,
  success: styles.darkFilledSuccess,
  primary: styles.darkFilledPrimary,
};

/**
 * Reusable button component.
 * @param {{
 *   size?: 'xs' | 'sm' | 'md' | 'lg',
 *   variant?: 'default' | 'primary' | 'danger' | 'success' | 'warning' | 'ghost',
 *   dark?: boolean,
 *   filled?: boolean,
 *   fullWidth?: boolean,
 *   as?: 'button' | 'a',
 *   className?: string,
 *   children: React.ReactNode,
 *   [key: string]: any,
 * }} props
 */
export function Button({
  size = 'sm',
  variant = 'default',
  dark = false,
  filled = false,
  fullWidth = false,
  as: Tag = 'button',
  className,
  children,
  ...rest
}) {
  const sizeClass = SIZE_CLASSES[size] || SIZE_CLASSES.sm;
  let variantClass;
  if (dark && filled && DARK_FILLED_CLASSES[variant]) {
    variantClass = DARK_FILLED_CLASSES[variant];
  } else if (dark) {
    variantClass = DARK_VARIANT_CLASSES[variant] || DARK_VARIANT_CLASSES.default;
  } else if (filled && FILLED_CLASSES[variant]) {
    variantClass = FILLED_CLASSES[variant];
  } else {
    variantClass = VARIANT_CLASSES[variant] || VARIANT_CLASSES.default;
  }

  const classes = [styles.base, sizeClass, variantClass, fullWidth && styles.fullWidth, className].filter(Boolean).join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
