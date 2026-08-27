import { basename } from 'node:path';
import { execFile } from './utils.js';

const TMUX_FIELD_SEPARATOR = '\x1f';
const TMUX_PANE_FORMAT = ['#{session_name}', '#{pane_pid}', '#{pane_current_command}', '#{pane_title}'].join(
  TMUX_FIELD_SEPARATOR,
);
const CODEX_WORKING_TITLE_RE = /^[\u2801-\u28ff]\s/u;

function stdoutOf(result) {
  return typeof result === 'string' ? result : (result?.stdout ?? '');
}

export function parseTmuxProviderPanes(raw) {
  const panes = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [tmuxName, rawPid, currentCommand, ...titleParts] = line.split(TMUX_FIELD_SEPARATOR);
    if (!tmuxName?.startsWith('patrol-')) continue;
    const panePid = Number(rawPid);
    if (!Number.isInteger(panePid) || panePid <= 0) continue;
    panes.set(tmuxName.slice('patrol-'.length), {
      panePid,
      currentCommand: basename(currentCommand || ''),
      title: titleParts.join(TMUX_FIELD_SEPARATOR),
    });
  }
  return panes;
}

export function normalizeClaudeAgentStatus(agent) {
  const state = agent?.state ?? agent?.status;
  if (['working', 'busy', 'running'].includes(state)) return 'working';
  if (['needs_input', 'needs-input', 'waiting', 'blocked'].includes(state)) return 'blocked';
  if (state === 'idle') return 'idle';
  return null;
}

export function normalizeCodexPaneStatus(pane) {
  if (pane?.currentCommand !== 'codex' || !pane.title) return null;
  return CODEX_WORKING_TITLE_RE.test(pane.title) ? 'working' : 'idle';
}

/**
 * Poll the provider-owned status surfaces for reattached sessions. The tmux
 * query identifies each provider process without reading terminal contents.
 * Claude exposes machine-readable session state; Codex exposes its active-turn
 * spinner in the pane title.
 *
 * @param {Array<{sessionId: string, provider: 'claude'|'codex'}>} candidates
 * @param {{execFileImpl?: typeof execFile}} [options]
 * @returns {Promise<Map<string, {state: 'working'|'idle'|'blocked', source: string}>>}
 */
export async function pollProviderSessionStatuses(candidates, { execFileImpl = execFile } = {}) {
  if (candidates.length === 0) return new Map();

  const needsClaude = candidates.some((candidate) => candidate.provider === 'claude');
  const [tmuxResult, claudeResult] = await Promise.allSettled([
    execFileImpl('tmux', ['list-panes', '-a', '-F', TMUX_PANE_FORMAT], {
      encoding: 'utf8',
      timeout: 5_000,
    }),
    needsClaude
      ? execFileImpl('claude', ['agents', '--json'], { encoding: 'utf8', timeout: 5_000 })
      : Promise.resolve({ stdout: '[]' }),
  ]);

  if (tmuxResult.status !== 'fulfilled') return new Map();
  const panes = parseTmuxProviderPanes(stdoutOf(tmuxResult.value));

  const claudeByPid = new Map();
  if (claudeResult.status === 'fulfilled') {
    try {
      const agents = JSON.parse(stdoutOf(claudeResult.value));
      if (Array.isArray(agents)) {
        for (const agent of agents) {
          const state = normalizeClaudeAgentStatus(agent);
          if (Number.isInteger(agent?.pid) && state) claudeByPid.set(agent.pid, state);
        }
      }
    } catch {
      // A malformed provider response is inconclusive, not an idle session.
    }
  }

  const statuses = new Map();
  for (const candidate of candidates) {
    const pane = panes.get(candidate.sessionId);
    if (!pane) continue;
    const state =
      candidate.provider === 'claude' ? (claudeByPid.get(pane.panePid) ?? null) : normalizeCodexPaneStatus(pane);
    if (state) statuses.set(candidate.sessionId, { state, source: `${candidate.provider}_status_poll` });
  }
  return statuses;
}
