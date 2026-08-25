import styles from './Badge.module.css';

/** @typedef {'green' | 'red' | 'blue' | 'yellow' | 'gray' | 'violet' | 'amber' | 'indigo' | 'orange' | 'purple'} BadgeColor */

/** @type {Record<BadgeColor, string>} */
const COLOR_CLASSES = {
  green: styles.green,
  red: styles.red,
  blue: styles.blue,
  yellow: styles.yellow,
  gray: styles.gray,
  violet: styles.violet,
  amber: styles.amber,
  indigo: styles.indigo,
  orange: styles.orange,
  purple: styles.purple,
};

/** @type {Partial<Record<BadgeColor, string>>} */
const NO_BORDER_CLASSES = {
  green: styles.greenNoBorder,
  red: styles.redNoBorder,
  blue: styles.blueNoBorder,
  yellow: styles.yellowNoBorder,
  gray: styles.grayNoBorder,
  violet: styles.violetNoBorder,
  amber: styles.amberNoBorder,
  indigo: styles.indigoNoBorder,
  orange: styles.orangeNoBorder,
  purple: styles.purpleNoBorder,
};

/**
 * Colored pill badge.
 * @typedef {React.HTMLAttributes<HTMLSpanElement> & {
 *   color?: BadgeColor,
 *   border?: boolean,
 *   pulse?: boolean,
 *   className?: string,
 *   title?: string,
 *   children: React.ReactNode,
 * }} BadgeProps
 * @param {BadgeProps} props
 */
export function Badge({ color = 'gray', border = true, pulse = false, className, children, ...rest }) {
  const colorClass = border
    ? COLOR_CLASSES[color] || COLOR_CLASSES.gray
    : NO_BORDER_CLASSES[color] || COLOR_CLASSES[color] || COLOR_CLASSES.gray;

  const classes = [styles.base, colorClass, pulse && styles.pulse, className].filter(Boolean).join(' ');

  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
