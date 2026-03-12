import { useState, useMemo } from 'react';
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
      result = result.map(e => ({
        ...e,
        content: e.content.filter(b => b.type !== 'thinking'),
      })).filter(e => e.content.length > 0);
    }
    if (search.trim()) {
      const term = search.toLowerCase();
      result = result.filter(e =>
        e.content.some(b => {
          const text = b.text || b.input_summary || b.output_summary || b.name || '';
          return text.toLowerCase().includes(term);
        })
      );
    }
    return result;
  }, [entries, search, showThinking]);

  const toggleTool = (key) => {
    setExpandedTools(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (loading) {
    return <div className={styles.container}><p className={styles.loading}>Loading transcript...</p></div>;
  }

  if (error) {
    return <div className={styles.container}><p className={styles.error}>{error}</p></div>;
  }

  if (!entries || entries.length === 0) {
    return <div className={styles.container}><p className={styles.empty}>No transcript available</p></div>;
  }

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search transcript..."
        />
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={showThinking}
            onChange={(e) => setShowThinking(e.target.checked)}
          />
          Show thinking
        </label>
        {search && (
          <span className={styles.resultCount}>{filtered.length} / {entries.length} messages</span>
        )}
      </div>

      <div className={styles.conversation}>
        {filtered.map((entry, i) => (
          <div key={i} className={`${styles.entry} ${entry.role === 'user' ? styles.entryUser : styles.entryAssistant}`}>
            <div className={styles.entryHeader}>
              <span className={`${styles.roleBadge} ${entry.role === 'user' ? styles.roleUser : styles.roleAssistant}`}>
                {entry.role === 'user' ? 'User' : 'Assistant'}
              </span>
              {entry.timestamp && (
                <span className={styles.timestamp}>
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
              )}
              {entry.model && (
                <span className={styles.model}>{entry.model}</span>
              )}
            </div>
            <div className={styles.entryContent}>
              {entry.content.map((block, j) => {
                const toolKey = `${i}-${j}`;
                if (block.type === 'text') {
                  return <div key={j} className={styles.textBlock}>{block.text}</div>;
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
                      <button className={styles.toolToggle} onClick={() => toggleTool(toolKey)}>
                        <span className={styles.toolIcon}>{expanded ? '\u25BE' : '\u25B8'}</span>
                        Used <strong>{block.name}</strong>
                      </button>
                      {expanded && (
                        <pre className={styles.toolDetail}>{block.input_summary}</pre>
                      )}
                    </div>
                  );
                }
                if (block.type === 'tool_result') {
                  const expanded = expandedTools.has(toolKey);
                  return (
                    <div key={j} className={styles.toolBlock}>
                      <button className={styles.toolToggle} onClick={() => toggleTool(toolKey)}>
                        <span className={styles.toolIcon}>{expanded ? '\u25BE' : '\u25B8'}</span>
                        Result{block.name ? ` from ${block.name}` : ''}
                      </button>
                      {expanded && (
                        <pre className={styles.toolDetail}>{block.output_summary}</pre>
                      )}
                    </div>
                  );
                }
                return null;
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
