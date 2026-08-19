import { useLayoutEffect, useRef, useState } from 'react';
import styles from './RenderedHtml.module.css';

const STATUS_VALUE_PATTERN = /^(?:✅|❌|⚠️|⏳|🟢|🟡|🔴|✔️?|✖️?)$/u;

/** @param {HTMLElement} root */
function normalizeTables(root) {
  for (const table of root.querySelectorAll('table')) {
    const headers = [...table.querySelectorAll('thead th')];
    for (const [index, header] of headers.entries()) {
      header.setAttribute('scope', 'col');
      if (header.textContent?.trim()) continue;

      const values = [...table.querySelectorAll('tbody tr')]
        .map((row) => row.children[index]?.textContent?.trim())
        .filter(Boolean);
      if (values.length === 0 || !values.every((value) => STATUS_VALUE_PATTERN.test(value))) continue;

      const label = document.createElement('span');
      label.className = styles.srOnly;
      label.textContent = 'Result';
      header.append(label);
    }
  }
}

/**
 * Render trusted HTML returned by the backend, normalize Markdown table semantics,
 * and optionally collapse long bodies behind an explicit disclosure.
 *
 * @param {{ html: string, className?: string, collapsible?: boolean, collapsedHeight?: number }} props
 */
export function RenderedHtml({ html, className, collapsible = false, collapsedHeight = 288 }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [canCollapse, setCanCollapse] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    // Rerun table normalization and overflow measurement when the HTML changes.
    void html;
    const element = ref.current;
    if (!element) return undefined;

    normalizeTables(element);
    const mutationObserver = new MutationObserver(() => normalizeTables(element));
    mutationObserver.observe(element, { childList: true, subtree: true });

    if (!collapsible) return () => mutationObserver.disconnect();

    const update = () => setCanCollapse(element.scrollHeight > collapsedHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
    };
  }, [html, collapsible, collapsedHeight]);

  return (
    <div className={styles.wrapper}>
      <div
        ref={ref}
        className={`${className || ''} ${canCollapse && !expanded ? styles.clamped : ''}`}
        style={
          /** @type {import('react').CSSProperties & Record<string, string>} */ ({
            '--rendered-html-collapsed-height': `${collapsedHeight}px`,
          })
        }
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {canCollapse && (
        <button className={styles.toggle} type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
