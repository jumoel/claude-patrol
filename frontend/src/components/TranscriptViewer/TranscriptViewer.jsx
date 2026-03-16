import { useMemo, useState } from 'react';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './TranscriptViewer.module.css';

/**
 * Render a Claude Code JSONL transcript as a conversation view.
 * @param {{ entries: object[] | null, loading: boolean, error: string | null }} props
 */
export function TranscriptViewer({ entries, loading, error }) {
  const [search, setSearch] = useState('');
  const [showThinking, setShowThinking] = useState(false);
  const [expandedTools, setExpandedTools] = useState(new Set());

  const filtered = useMemo(() => {
    if (!entries) return [];
    let result = entries;
    if (!showThinking) {
      result = result
        .map((e) => ({
          ...e,
          content: e.content.filter((b) => b.type !== 'thinking'),
        }))
        .filter((e) => e.content.length > 0);
    }
    if (search.trim()) {
      const term = search.toLowerCase();
      result = result.filter((e) =>
        e.content.some((b) => {
          const text = b.text || b.input_summary || b.output_summary || b.name || '';
          return text.toLowerCase().includes(term);
        }),
      );
    }
    return result;
  }, [entries, search, showThinking]);

  const toggleTool = (key) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (loading) {
    return (
      <div className={styles.container}>
        <p className={styles.loading}>Loading transcript...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <p className={styles.error}>{error}</p>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div className={styles.container}>
        <p className={styles.empty}>No transcript available</p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <Stack gap={3}>
        <input
          className={styles.searchInput}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search transcript..."
        />
        <Stack gap={2} as="label" className={styles.toggleLabel}>
          <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} />
          Show thinking
        </Stack>
        {search && (
          <span className={styles.resultCount}>
            {filtered.length} / {entries.length} messages
          </span>
        )}
      </Stack>

      <div className={styles.conversation}>
        {filtered.map((entry, i) => {
          const isHuman = entry.isHuman;
          const entryClass = isHuman
            ? styles.entryHuman
            : entry.role === 'assistant'
              ? styles.entryAssistant
              : styles.entryTool;
          const badgeClass = isHuman
            ? styles.roleHuman
            : entry.role === 'assistant'
              ? styles.roleAssistant
              : styles.roleTool;
          const hasToolResult =
            entry.role === 'user' && !isHuman && entry.content.every((b) => b.type === 'tool_result');
          const badgeLabel = isHuman
            ? 'You'
            : entry.role === 'assistant'
              ? 'Claude'
              : hasToolResult
                ? 'Tool Result'
                : 'System';

          return (
            <div key={i} className={`${styles.entry} ${entryClass}`}>
              <Stack gap={2} className={styles.entryHeader}>
                <span className={`${styles.roleBadge} ${badgeClass}`}>{badgeLabel}</span>
                {entry.timestamp && (
                  <span className={styles.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                )}
                {entry.model && <span className={styles.model}>{entry.model}</span>}
              </Stack>
              <Stack direction="col" gap={2}>
                {entry.content.map((block, j) => {
                  const toolKey = `${i}-${j}`;
                  if (block.type === 'text') {
                    return (
                      <div key={j} className={styles.textBlock}>
                        {block.text}
                      </div>
                    );
                  }
                  if (block.type === 'thinking') {
                    return (
                      <div key={j} className={styles.thinkingBlock}>
                        <span className={styles.thinkingLabel}>Thinking</span>
                        <pre className={styles.thinkingText}>{block.text}</pre>
                      </div>
                    );
                  }
                  if (block.type === 'tool_use') {
                    const expanded = expandedTools.has(toolKey);
                    return (
                      <div key={j} className={styles.toolBlock}>
                        <Stack gap={1} as="button" className={styles.toolToggle} onClick={() => toggleTool(toolKey)}>
                          <span className={styles.toolIcon}>{expanded ? '\u25BE' : '\u25B8'}</span>
                          Used <strong>{block.name}</strong>
                        </Stack>
                        {expanded && <pre className={styles.toolDetail}>{block.input_summary}</pre>}
                      </div>
                    );
                  }
                  if (block.type === 'tool_result') {
                    const expanded = expandedTools.has(toolKey);
                    return (
                      <div key={j} className={styles.toolBlock}>
                        <Stack gap={1} as="button" className={styles.toolToggle} onClick={() => toggleTool(toolKey)}>
                          <span className={styles.toolIcon}>{expanded ? '\u25BE' : '\u25B8'}</span>
                          Result{block.name ? ` from ${block.name}` : ''}
                        </Stack>
                        {expanded && <pre className={styles.toolDetail}>{block.output_summary}</pre>}
                      </div>
                    );
                  }
                  return null;
                })}
              </Stack>
            </div>
          );
        })}
      </div>
    </div>
  );
}
