import { useCallback, useEffect, useRef, useState } from 'react';
import { useAgentProvider } from '../../context/AgentProviderContext.jsx';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { Button } from '../ui/Button/Button.jsx';
import styles from './AgentProviderButton.module.css';

const SIZE_CLASSES = {
  xs: styles.xs,
  sm: styles.sm,
  md: styles.md,
  lg: styles.lg,
};

const VARIANT_CLASSES = {
  default: styles.default,
  primary: styles.primary,
};

const PROVIDERS = [
  { id: 'claude', name: 'Claude', detail: 'Claude Code', markClass: styles.claudeMark },
  { id: 'codex', name: 'Codex', detail: 'Codex CLI', markClass: styles.codexMark },
];

/**
 * A split action button. The main segment performs the action and the chevron
 * opens the provider menu without making the provider label compete with the
 * action label.
 *
 * @param {{
 *   children: React.ReactNode,
 *   onClick: () => void,
 *   disabled?: boolean,
 *   providerDisabled?: boolean,
 *   value?: import('../../types').AgentProvider,
 *   dark?: boolean,
 *   active?: boolean,
 *   busy?: boolean,
 *   size?: 'xs' | 'sm' | 'md' | 'lg',
 *   variant?: 'default' | 'primary',
 *   className?: string,
 *   actionClassName?: string,
 * }} props
 */
export function AgentProviderButton({
  children,
  onClick,
  disabled = false,
  providerDisabled = disabled,
  value,
  dark = false,
  active = false,
  busy = false,
  size = 'sm',
  variant = 'primary',
  className = '',
  actionClassName = '',
}) {
  const { provider, setProvider } = useAgentProvider();
  const [menuOpen, setMenuOpen] = useState(false);
  const groupRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const triggerRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const optionRefs = useRef(/** @type {(HTMLButtonElement | null)[]} */ ([]));
  const selectedProvider = value ?? provider;
  const providerName = selectedProvider === 'codex' ? 'Codex' : 'Claude';
  const pickerClasses = [
    styles.picker,
    SIZE_CLASSES[size],
    VARIANT_CLASSES[variant],
    dark && styles.dark,
    active && styles.active,
    providerDisabled && styles.disabled,
  ]
    .filter(Boolean)
    .join(' ');

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useClickOutside(groupRef, closeMenu);
  useEscapeKey(
    menuOpen,
    useCallback(() => {
      setMenuOpen(false);
      triggerRef.current?.focus();
    }, []),
  );

  useEffect(() => {
    if (providerDisabled) setMenuOpen(false);
  }, [providerDisabled]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const selectedIndex = PROVIDERS.findIndex(({ id }) => id === selectedProvider);
    const frame = requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [menuOpen, selectedProvider]);

  /** @param {import('../../types').AgentProvider} nextProvider */
  const chooseProvider = (nextProvider) => {
    setProvider(nextProvider);
    setMenuOpen(false);
    triggerRef.current?.focus();
  };

  /** @param {React.KeyboardEvent<HTMLButtonElement>} event @param {number} index */
  const handleOptionKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % PROVIDERS.length;
    else if (event.key === 'ArrowUp') nextIndex = (index - 1 + PROVIDERS.length) % PROVIDERS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = PROVIDERS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    optionRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      ref={groupRef}
      className={`${styles.group} ${className}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
      }}
    >
      <Button
        size={size}
        variant={variant}
        dark={dark}
        className={`${styles.action} ${actionClassName}`}
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy}
      >
        {children}
      </Button>
      <button
        ref={triggerRef}
        type="button"
        className={pickerClasses}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Choose agent provider, currently ${providerName}`}
        title={providerDisabled ? 'Kill the current session before changing its provider' : 'Choose agent provider'}
        disabled={providerDisabled}
        onClick={() => setMenuOpen((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setMenuOpen(true);
          }
        }}
      >
        <svg
          className={`${styles.chevron} ${menuOpen ? styles.chevronOpen : ''}`}
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="3.5,5 7,8.5 10.5,5" />
        </svg>
      </button>
      {menuOpen && (
        <div className={`${styles.menu} ${dark ? styles.menuDark : ''}`} role="menu" aria-label="Agent provider">
          {PROVIDERS.map((option, index) => {
            const selected = option.id === selectedProvider;
            return (
              <button
                key={option.id}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`${styles.option} ${selected ? styles.optionSelected : ''}`}
                onClick={() => chooseProvider(/** @type {import('../../types').AgentProvider} */ (option.id))}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
              >
                <span className={`${styles.providerMark} ${option.markClass}`} aria-hidden="true">
                  {option.name.slice(0, 1)}
                </span>
                <span className={styles.optionCopy}>
                  <span className={styles.optionName}>{option.name}</span>
                  <span className={styles.optionDetail}>{option.detail}</span>
                </span>
                {selected && (
                  <svg
                    className={styles.check}
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="3,8.5 6.5,12 13,5" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
