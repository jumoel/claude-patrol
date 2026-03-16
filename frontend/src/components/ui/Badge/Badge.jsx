import styles from './Badge.module.css';

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

const NO_BORDER_CLASSES = {
  green: styles.greenNoBorder,
  red: styles.redNoBorder,
  blue: styles.blueNoBorder,
  yellow: styles.yellowNoBorder,
  gray: styles.grayNoBorder,
};

/**
 * Colored pill badge.
 * @param {{
 *   color?: 'green' | 'red' | 'blue' | 'yellow' | 'gray' | 'violet' | 'amber' | 'indigo' | 'orange' | 'purple',
 *   border?: boolean,
 *   pulse?: boolean,
 *   className?: string,
 *   children: React.ReactNode,
 * }} props
 */
export function Badge({ color = 'gray', border = true, pulse = false, className, children, ...rest }) {
  const colorClass = border
    ? (COLOR_CLASSES[color] || COLOR_CLASSES.gray)
    : (NO_BORDER_CLASSES[color] || COLOR_CLASSES[color] || COLOR_CLASSES.gray);

  const classes = [styles.base, colorClass, pulse && styles.pulse, className].filter(Boolean).join(' ');

  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
