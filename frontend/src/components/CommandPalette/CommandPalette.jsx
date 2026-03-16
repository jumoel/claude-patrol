import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useClickOutside } from '../../hooks/useClickOutside.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { StatusBadge } from '../StatusBadge/StatusBadge.jsx';
import { Badge } from '../ui/Badge/Badge.jsx';
import { Stack } from '../ui/Stack/Stack.jsx';
import styles from './CommandPalette.module.css';

function fuzzyMatchPR(query, pr) {
  if (!query) return { match: true, score: 0 };
  const primary = `${pr.title} ${pr.org}/${pr.repo} #${pr.number} ${pr.branch}`.toLowerCase();
  const body = (pr.body || '').toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    const inPrimary = primary.includes(token);
    const inBody = body.includes(token);
    if (!inPrimary && !inBody) return { match: false, score: 0 };
    score += inPrimary ? 2 : 1;
  }
  return { match: true, score };
}

function fuzzyMatchWorkspace(query, ws) {
  if (!query) return { match: true, score: 0 };
  const haystack = `${ws.bookmark} ${ws.repo || ''} scratch workspace`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);

  let score = 0;
  for (const token of tokens) {
    if (!haystack.includes(token)) return { match: false, score: 0 };
    score += 1;
  }
  return { match: true, score };
}

export function CommandPalette({
  prs,
  scratchWorkspaces,
  workspaceStates,
  dismissedIdle,
  hasGlobalSession,
  onNavigate,
  onNavigateWorkspace,
  onOpenGlobalTerminal,
  onCloseGlobalTerminal,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const resultsRef = useRef(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  // Global Cmd+K / Ctrl+K listener
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (prev) {
            setQuery('');
            setSelectedIndex(0);
            return false;
          }
          return true;
        });
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Autofocus input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEscapeKey(open, close);
  useClickOutside(dialogRef, open ? close : () => {});

  const filtered = useMemo(() => {
    const prItems = query
      ? prs.map((pr) => ({ ...fuzzyMatchPR(query, pr), type: 'pr', item: pr })).filter((r) => r.match)
      : prs.map((pr) => ({ match: true, score: 0, type: 'pr', item: pr }));

    const wsItems =
      (scratchWorkspaces || []).length > 0
        ? query
          ? (scratchWorkspaces || [])
              .map((ws) => ({ ...fuzzyMatchWorkspace(query, ws), type: 'workspace', item: ws }))
              .filter((r) => r.match)
          : (scratchWorkspaces || []).map((ws) => ({ match: true, score: 0, type: 'workspace', item: ws }))
        : [];

    // Global terminal entry (only if session is active)
    const globalItems = [];
    if (hasGlobalSession) {
      const gLabel = 'Global Terminal';
      if (!query || gLabel.toLowerCase().includes(query.toLowerCase())) {
        globalItems.push({ match: true, score: query ? 1 : 0, type: 'global', item: { id: 'global' } });
      }
    }

    const all = [...prItems, ...wsItems, ...globalItems];

    // Boost items with active sessions to top (idle first, then working), then sort by score
    const sessionPriority = (entry) => {
      if (!workspaceStates?.size) return 0;
      const wsId = entry.type === 'workspace' ? entry.item.id : entry.item.workspace_id;
      if (!wsId) return 0;
      const state = workspaceStates.get(wsId);
      if (state === 'idle') return 2;
      if (state === 'working') return 1;
      return 0;
    };

    return all.sort((a, b) => {
      const aPri = sessionPriority(a);
      const bPri = sessionPriority(b);
      if (aPri !== bPri) return bPri - aPri;
      return b.score - a.score;
    });
  }, [prs, scratchWorkspaces, workspaceStates, hasGlobalSession, query]);

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (!resultsRef.current) return;
    const selected = resultsRef.current.children[selectedIndex];
    if (selected) selected.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleSelect = useCallback(
    (entry) => {
      if (entry.type === 'global') {
        onOpenGlobalTerminal();
      } else {
        onCloseGlobalTerminal?.();
        if (entry.type === 'pr') {
          onNavigate(entry.item.id);
        } else {
          onNavigateWorkspace(entry.item.id);
        }
      }
      close();
    },
    [onNavigate, onNavigateWorkspace, onOpenGlobalTerminal, onCloseGlobalTerminal, close],
  );

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      e.preventDefault();
      handleSelect(filtered[selectedIndex]);
    }
  };

  if (!open) return null;

  return (
    <div className={styles.overlay} onKeyDown={handleKeyDown}>
      <div className={styles.dialog} ref={dialogRef}>
        <div className={styles.inputWrapper}>
          <svg
            className={styles.searchIcon}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Search PRs and workspaces..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className={styles.hint}>esc</span>
        </div>
        <div className={styles.results} ref={resultsRef}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No results</div>
          ) : (
            filtered.map((entry, i) => (
              <div
                key={entry.type === 'pr' ? entry.item.id : entry.type === 'global' ? 'global' : `ws-${entry.item.id}`}
                className={`${styles.result} ${i === selectedIndex ? styles.resultSelected : ''}`}
                onClick={() => handleSelect(entry)}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                {entry.type === 'pr' ? (
                  <PRResult
                    pr={entry.item}
                    sessionState={entry.item.workspace_id ? workspaceStates?.get(entry.item.workspace_id) : undefined}
                    dismissed={entry.item.workspace_id ? dismissedIdle?.has(entry.item.workspace_id) : false}
                  />
                ) : entry.type === 'global' ? (
                  <GlobalResult />
                ) : (
                  <WorkspaceResult
                    ws={entry.item}
                    sessionState={workspaceStates?.get(entry.item.id)}
                    dismissed={dismissedIdle?.has(entry.item.id)}
                  />
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function SessionStateBadge({ state, dismissed }) {
  if (state === 'working')
    return (
      <Badge color="violet" title="Claude is actively working">
        <span className={styles.spinner} />
        Working
      </Badge>
    );
  if (state === 'idle' && !dismissed)
    return (
      <Badge color="amber" pulse title="Session waiting for input - needs attention">
        Waiting
      </Badge>
    );
  if (state === 'idle' && dismissed)
    return (
      <Badge color="gray" title="Session idle (already seen)">
        Idle
      </Badge>
    );
  return null;
}

function PRResult({ pr, sessionState, dismissed }) {
  return (
    <Stack direction="col" gap={1} className={styles.resultInfo}>
      <div className={styles.resultTitle}>{pr.title}</div>
      <Stack gap={2} className={styles.resultMeta}>
        <span className={styles.resultRepo}>
          {pr.org}/{pr.repo}
        </span>
        <span className={styles.resultNumber}>#{pr.number}</span>
        <span className={styles.resultBranch}>{pr.branch}</span>
      </Stack>
      <Stack gap={1} className={styles.resultBadges}>
        <StatusBadge status={pr.ci_status} type="ci" />
        <StatusBadge status={pr.review_status} type="review" />
        {pr.mergeable === 'CONFLICTING' && <StatusBadge status={pr.mergeable} type="merge" />}
        {pr.draft && <Badge color="yellow">Draft</Badge>}
        <SessionStateBadge state={sessionState} dismissed={dismissed} />
      </Stack>
    </Stack>
  );
}

function GlobalResult() {
  return (
    <Stack direction="col" gap={1} className={styles.resultInfo}>
      <div className={styles.resultTitle}>Global Terminal</div>
      <Stack gap={1} className={styles.resultBadges}>
        <Badge color="green">active session</Badge>
      </Stack>
    </Stack>
  );
}

function WorkspaceResult({ ws, sessionState, dismissed }) {
  return (
    <Stack direction="col" gap={1} className={styles.resultInfo}>
      <div className={styles.resultTitle}>{ws.bookmark}</div>
      <Stack gap={2} className={styles.resultMeta}>{ws.repo && <span className={styles.resultRepo}>{ws.repo}</span>}</Stack>
      <Stack gap={1} className={styles.resultBadges}>
        <Badge color="purple">scratch workspace</Badge>
        <SessionStateBadge state={sessionState} dismissed={dismissed} />
      </Stack>
    </Stack>
  );
}
