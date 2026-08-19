import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

/** @param {ParentNode} root */
function normalizeDetails(root) {
  for (const link of root.querySelectorAll('summary a')) {
    const summary = link.parentElement;
    if (!summary) continue;

    const label = link.textContent?.trim() || 'Linked item';
    const externalLink = document.createElement('a');
    for (const attribute of link.attributes) {
      externalLink.setAttribute(attribute.name, attribute.value);
    }
    externalLink.className = styles.detailsLink;
    externalLink.textContent = 'Open linked item';
    externalLink.setAttribute('aria-label', `Open linked item: ${label}`);

    link.replaceWith(label);
    summary.insertAdjacentElement('afterend', externalLink);
  }
}

/** @param {string} html */
function prepareHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  normalizeDetails(template.content);
  return template.innerHTML;
}

/** @param {HTMLElement} root */
function normalizeContent(root) {
  normalizeTables(root);
  normalizeDetails(root);
}

/**
 * Render trusted HTML returned by the backend, normalize Markdown table semantics,
 * and optionally collapse long bodies behind an explicit disclosure.
 *
 * @param {{ html: string, className?: string, collapsible?: boolean, collapsedHeight?: number }} props
 */
function RenderedHtmlComponent({ html, className, collapsible = false, collapsedHeight = 288 }) {
  const ref = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [canCollapse, setCanCollapse] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const preparedHtml = useMemo(() => prepareHtml(html), [html]);

  useLayoutEffect(() => {
    // Rerun table normalization and overflow measurement when the HTML changes.
    void preparedHtml;
    const element = ref.current;
    if (!element) return undefined;

    normalizeContent(element);
    const mutationObserver = new MutationObserver(() => normalizeContent(element));
    mutationObserver.observe(element, { childList: true, subtree: true });

    // Native disclosures already manage their own height. Measuring them for the
    // outer clamp would rerender the HTML when one opens and reset its state.
    if (!collapsible || element.querySelector('details')) {
      setCanCollapse(false);
      return () => mutationObserver.disconnect();
    }

    const update = () => setCanCollapse(element.scrollHeight > collapsedHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      mutationObserver.disconnect();
      observer.disconnect();
    };
  }, [preparedHtml, collapsible, collapsedHeight]);

  return (
    <div className={styles.wrapper}>
      <div
        ref={ref}
        className={`${styles.content} ${className || ''} ${canCollapse && !expanded ? styles.clamped : ''}`}
        style={
          /** @type {import('react').CSSProperties & Record<string, string>} */ ({
            '--rendered-html-collapsed-height': `${collapsedHeight}px`,
          })
        }
        dangerouslySetInnerHTML={{ __html: preparedHtml }}
      />
      {canCollapse && (
        <button className={styles.toggle} type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export const RenderedHtml = memo(RenderedHtmlComponent);
