import { usePRs } from './hooks/usePRs.js';
import { AppShell } from './components/AppShell/AppShell.jsx';
import { PRTable } from './components/PRTable/PRTable.jsx';
import { FilterBar } from './components/FilterBar/FilterBar.jsx';
import { GlobalTerminal } from './components/GlobalTerminal/GlobalTerminal.jsx';
import { DashboardSummary } from './components/DashboardSummary/DashboardSummary.jsx';
import { PRDetail } from './components/PRDetail/PRDetail.jsx';
import { WorkspaceDetail } from './components/WorkspaceDetail/WorkspaceDetail.jsx';
import { fetchScratchWorkspaces, createScratchWorkspace, fetchConfig } from './lib/api.js';
import { getRelativeTime } from './lib/time.js';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';

function formatCountdown(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

/**
 * Apply client-side filters. Each filter key maps to an array of allowed values.
 * Empty array = no filter (show all).
 */
function applyFilters(prs, filters) {
  return prs.filter(pr => {
    // "Needs work" is a meta-filter: show only PRs that need attention
    // (failing CI, conflicts, or drafts)
    if (filters.needsWork) {
      const isGood = pr.ci_status === 'pass' && pr.mergeable === 'MERGEABLE' && !pr.draft;
      if (isGood) return false;
    }
    if (filters.org?.length && !filters.org.includes(pr.org)) return false;
    if (filters.repo?.length && !filters.repo.includes(pr.repo)) return false;
    if (filters.ci?.length && !filters.ci.includes(pr.ci_status)) return false;
    if (filters.review?.length && !filters.review.includes(pr.review_status)) return false;
    if (filters.mergeable?.length && !filters.mergeable.includes(pr.mergeable)) return false;
    if (filters.draft?.length) {
      const isDraft = pr.draft ? 'true' : 'false';
      if (!filters.draft.includes(isDraft)) return false;
    }
    return true;
  });
}

const NO_FILTERS = {};

export default function App() {
  const [filters, setFilters] = useState({});
  const [selectedPR, setSelectedPR] = useState(null);
  const [selectedWorkspace, setSelectedWorkspace] = useState(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [scratchWorkspaces, setScratchWorkspaces] = useState([]);
  const [showNewWork, setShowNewWork] = useState(false);
  const [newWorkRepo, setNewWorkRepo] = useState('');
  const [newWorkBranch, setNewWorkBranch] = useState('');
  const [newWorkSubmitting, setNewWorkSubmitting] = useState(false);
  const [repos, setRepos] = useState([]);
  const copiedTimeout = useRef(null);
  const toggleTerminal = useCallback(() => setTerminalOpen(prev => !prev), []);
  const { prs: allPRs, syncedAt, loading, error, syncing, countdown, triggerSync } = usePRs(NO_FILTERS);

  const filteredPRs = useMemo(() => applyFilters(allPRs, filters), [allPRs, filters]);

  // Load scratch workspaces on mount and when sync happens (syncedAt changes)
  useEffect(() => {
    fetchScratchWorkspaces()
      .then(ws => setScratchWorkspaces(ws))
      .catch(() => {});
  }, [syncedAt]);

  // Derive available repos from PRs + config (config fetched once on mount)
  const configRef = useRef(null);
  useEffect(() => {
    if (!configRef.current) {
      fetchConfig().then(cfg => { configRef.current = cfg; }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const prRepos = [...new Set(allPRs.map(pr => `${pr.org}/${pr.repo}`))];
    const cfg = configRef.current;
    const configRepos = cfg?.poll?.repos || [];
    const configOrgs = (cfg?.poll?.orgs || []).map(o => `${o}/*`);
    const all = [...new Set([...prRepos, ...configRepos, ...configOrgs])].sort();
    setRepos(all);
    if (!newWorkRepo && all.length > 0) {
      const first = all.find(r => !r.endsWith('/*')) || '';
      setNewWorkRepo(first);
    }
  }, [allPRs]);

  const handleNewWork = useCallback(async () => {
    if (!newWorkRepo || !newWorkBranch) return;
    setNewWorkSubmitting(true);
    try {
      const ws = await createScratchWorkspace(newWorkRepo, newWorkBranch);
      setShowNewWork(false);
      setNewWorkBranch('');
      window.location.hash = `/workspace/${ws.id}`;
    } catch (err) {
      alert(err.message);
    } finally {
      setNewWorkSubmitting(false);
    }
  }, [newWorkRepo, newWorkBranch]);

  const copyFilteredAsMarkdown = useCallback(() => {
    const md = filteredPRs
      .map(pr => `- [#${pr.number}](${pr.url}) - ${pr.title}`)
      .join('\n');
    navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      clearTimeout(copiedTimeout.current);
      copiedTimeout.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [filteredPRs]);

  // Simple hash-based routing
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash;
      if (hash.startsWith('#/pr/')) {
        setSelectedPR(decodeURIComponent(hash.slice(5)));
        setSelectedWorkspace(null);
      } else if (hash.startsWith('#/workspace/')) {
        setSelectedWorkspace(hash.slice(12));
        setSelectedPR(null);
      } else {
        setSelectedPR(null);
        setSelectedWorkspace(null);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  const syncTime = syncedAt
    ? `Last synced: ${new Date(syncedAt).toLocaleTimeString()}`
    : 'Not synced';
  const nextSync = countdown > 0 ? formatCountdown(countdown) : '';

  const navigateToPR = (prId) => {
    window.location.hash = `/pr/${encodeURIComponent(prId)}`;
  };

  const navigateBack = () => {
    window.location.hash = '';
  };

  return (
    <AppShell title="Claude Patrol" syncTime={syncTime} nextSync={nextSync} syncing={syncing} onSync={triggerSync} terminalOpen={terminalOpen} onToggleTerminal={toggleTerminal}>
      {selectedPR ? (
        <PRDetail prId={selectedPR} onBack={navigateBack} />
      ) : selectedWorkspace ? (
        <WorkspaceDetail workspaceId={selectedWorkspace} onBack={navigateBack} />
      ) : (
        <>
          <DashboardSummary prCount={filteredPRs.length} syncedAt={syncedAt} />
          <FilterBar prs={allPRs} filters={filters} onFilterChange={setFilters} onCopyMarkdown={copyFilteredAsMarkdown} copied={copied} />
          {error && <p>{error}</p>}
          {loading && allPRs.length === 0 && <p>Loading...</p>}
          <PRTable prs={filteredPRs} onRowClick={navigateToPR} />
          {/* Scratch workspaces + New Work */}
          <div style={{ marginTop: '1.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <h3 style={{ fontSize: '0.875rem', fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Scratch Workspaces {scratchWorkspaces.length > 0 && `(${scratchWorkspaces.length})`}
              </h3>
              <button
                onClick={() => setShowNewWork(!showNewWork)}
                style={{ padding: '0.375rem 0.75rem', fontSize: '0.875rem', fontWeight: 500, color: '#4f46e5', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: '0.375rem', cursor: 'pointer' }}
              >
                + New Work
              </button>
            </div>
            {showNewWork && (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '0.5rem', padding: '1rem', marginBottom: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: '#6b7280', marginBottom: '0.25rem' }}>Repo</label>
                  <select value={newWorkRepo} onChange={e => setNewWorkRepo(e.target.value)} style={{ padding: '0.375rem 0.5rem', border: '1px solid #d1d5db', borderRadius: '0.375rem', fontSize: '0.875rem' }}>
                    {repos.filter(r => !r.endsWith('/*')).map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: '200px' }}>
                  <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 500, color: '#6b7280', marginBottom: '0.25rem' }}>Branch</label>
                  <input
                    type="text"
                    value={newWorkBranch}
                    onChange={e => setNewWorkBranch(e.target.value)}
                    placeholder="feat/my-feature"
                    onKeyDown={e => e.key === 'Enter' && handleNewWork()}
                    style={{ width: '100%', padding: '0.375rem 0.5rem', border: '1px solid #d1d5db', borderRadius: '0.375rem', fontSize: '0.875rem' }}
                  />
                </div>
                <button
                  onClick={handleNewWork}
                  disabled={newWorkSubmitting || !newWorkRepo || !newWorkBranch}
                  style={{ padding: '0.375rem 1rem', fontSize: '0.875rem', fontWeight: 500, color: '#fff', background: newWorkSubmitting || !newWorkRepo || !newWorkBranch ? '#9ca3af' : '#4f46e5', border: 'none', borderRadius: '0.375rem', cursor: newWorkSubmitting ? 'wait' : 'pointer' }}
                >
                  {newWorkSubmitting ? 'Creating...' : 'Create'}
                </button>
              </div>
            )}
            {scratchWorkspaces.length > 0 ? (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '0.5rem', overflow: 'hidden' }}>
                {scratchWorkspaces.map(ws => (
                  <div
                    key={ws.id}
                    onClick={() => { window.location.hash = `/workspace/${ws.id}`; }}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem', borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '0.875rem', fontWeight: 600, color: '#111827' }}>{ws.bookmark}</span>
                      {ws.repo && <span style={{ fontSize: '0.75rem', color: '#6b7280', background: '#f3f4f6', padding: '0.125rem 0.5rem', borderRadius: '0.25rem' }}>{ws.repo}</span>}
                    </div>
                    <span style={{ fontSize: '0.75rem', color: '#9ca3af' }}>{getRelativeTime(ws.created_at)}</span>
                  </div>
                ))}
              </div>
            ) : !showNewWork && (
              <p style={{ fontSize: '0.875rem', color: '#9ca3af' }}>No scratch workspaces. Click "New Work" to start.</p>
            )}
          </div>
        </>
      )}
      <GlobalTerminal open={terminalOpen} onToggle={toggleTerminal} />
    </AppShell>
  );
}
