import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb } from './db.js';
import { transcriptsDir } from './paths.js';
import { expandPath, toClaudeProjectKey } from './utils.js';

/** Max conversation characters to return from getWorkspaceConversationText */
const MAX_CONVERSATION_CHARS = 80_000;

/**
 * Find the best-matching Claude Code JSONL file for a session.
 * Matches by mtime: created after startedAt and before endedAt + 60s.
 * @param {string} claudeProjectDir - path to ~/.claude/projects/<key>
 * @param {string} startedAt - ISO timestamp
 * @param {string | null} endedAt - ISO timestamp or null
 * @returns {string | null} full path to the best match, or null
 */
export function findSessionJsonl(claudeProjectDir, startedAt, endedAt) {
  let files;
  try {
    files = readdirSync(claudeProjectDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return null;
  }

  if (files.length === 0) return null;

  const startMs = new Date(startedAt).getTime();
  const endMs = endedAt ? new Date(endedAt).getTime() + 60_000 : Infinity;

  let best = null;
  let bestMtime = 0;

  for (const file of files) {
    const fullPath = join(claudeProjectDir, file);
    try {
      const st = statSync(fullPath);
      const mtime = st.mtimeMs;
      // File must have been modified after session started and before session ended + 60s
      if (mtime >= startMs && mtime <= endMs && mtime > bestMtime) {
        best = fullPath;
        bestMtime = mtime;
      }
    } catch {}
  }

  return best;
}

/**
 * Copy a session's Claude Code JSONL transcript to patrol's storage.
 * Updates the session's transcript_path in the DB.
 * Best-effort: returns null on failure rather than throwing.
 * @param {string} sessionId
 * @param {string} claudeProjectDir
 * @param {string} startedAt
 * @param {string | null} endedAt
 * @returns {string | null} path to the archived transcript, or null
 */
export function archiveTranscript(sessionId, claudeProjectDir, startedAt, endedAt) {
  try {
    const source = findSessionJsonl(claudeProjectDir, startedAt, endedAt);
    if (!source) return null;

    const dest = join(transcriptsDir(), `${sessionId}.jsonl`);
    copyFileSync(source, dest);

    const db = getDb();
    db.prepare('UPDATE sessions SET transcript_path = ? WHERE id = ?').run(dest, sessionId);

    return dest;
  } catch (err) {
    console.warn(`[transcripts] Failed to archive transcript for session ${sessionId}: ${err.message}`);
    return null;
  }
}

// --- Shared transcript parsing (used by routes/sessions.js, summarizer, and getOrCreateTranscriptSummary) ---

const SYSTEM_PATTERNS = [
  '<task-notification>',
  '<system-reminder>',
  '<command-name>',
  '<automated-',
  'IMPORTANT: After completing',
  'Read the output file to retrieve the result:',
];

/**
 * Extract text content from a Claude message content array/string.
 * @param {Array | string | undefined} content
 * @returns {string}
 */
function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Generate a compact summary of a transcript JSONL file.
 * Includes only human messages and assistant text responses - no tool
 * use, tool results, thinking blocks, or system-injected messages.
 * Returns the path to the summary file (cached alongside the JSONL).
 *
 * @param {string} jsonlPath - path to the full JSONL transcript
 * @returns {string | null} path to the summary file, or null on failure
 */
export function getOrCreateTranscriptSummary(jsonlPath) {
  const summaryPath = jsonlPath.replace(/\.jsonl$/, '.summary.md');

  if (existsSync(summaryPath)) {
    // Regenerate if the JSONL is newer than the summary
    try {
      const jsonlMtime = statSync(jsonlPath).mtimeMs;
      const summaryMtime = statSync(summaryPath).mtimeMs;
      if (summaryMtime >= jsonlMtime) return summaryPath;
    } catch {}
  }

  try {
    const raw = readFileSync(jsonlPath, 'utf8');
    const entries = raw
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((e) => e.type === 'user' || e.type === 'assistant');

    const lines = [];
    let prevWasAssistant = true;

    for (const e of entries) {
      const role = e.message?.role || e.type;
      const text = extractText(e.message?.content).trim();
      if (!text) continue;

      if (role === 'user') {
        const looksLikeSystem = SYSTEM_PATTERNS.some((p) => text.includes(p));
        const isHuman = prevWasAssistant && !looksLikeSystem;
        if (isHuman) {
          lines.push(`## User\n\n${text}\n`);
        }
      } else if (role === 'assistant') {
        lines.push(`## Assistant\n\n${text}\n`);
      }

      prevWasAssistant = role === 'assistant';
    }

    writeFileSync(summaryPath, lines.join('\n---\n\n'));
    return summaryPath;
  } catch (err) {
    console.warn(`[transcripts] Failed to create summary for ${jsonlPath}: ${err.message}`);
    return null;
  }
}

/**
 * Resolve the JSONL path for a session, preferring the archived copy.
 * @param {object} sess - session DB row
 * @param {string | null} fallbackProjectDir - derived from workspace path
 * @returns {string | null}
 */
export function resolveSessionJsonlPath(sess, fallbackProjectDir) {
  if (sess.transcript_path && existsSync(sess.transcript_path)) {
    return sess.transcript_path;
  }
  const projDir = sess.claude_project_dir || fallbackProjectDir;
  if (projDir) {
    return findSessionJsonl(projDir, sess.started_at, sess.ended_at);
  }
  return null;
}

/**
 * Derive the Claude project dir for a workspace path.
 * @param {string} workspacePath
 * @returns {string}
 */
export function claudeProjectDirForWorkspace(workspacePath) {
  return resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(workspacePath));
}

/**
 * Parse a JSONL transcript into structured entries with isHuman tagging.
 * This is the shared logic used by both the transcript API route and the summarizer.
 * @param {string} jsonlPath
 * @returns {Array<{timestamp: string, role: string, content: Array, isHuman: boolean}>}
 */
export function parseTranscript(jsonlPath) {
  const raw = readFileSync(jsonlPath, 'utf8');
  const parsed = raw.trim().split('\n')
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean)
    .filter(e => e.type === 'user' || e.type === 'assistant');

  let prevWasAssistant = true;
  return parsed.map(e => {
    const content = simplifyContent(e.message?.content);
    const role = e.message?.role || e.type;
    const hasText = content.some(b => b.type === 'text');

    let isHuman = false;
    if (role === 'user' && hasText) {
      const textContent = content.filter(b => b.type === 'text').map(b => b.text).join('');
      const looksLikeSystem = SYSTEM_PATTERNS.some(p => textContent.includes(p));
      isHuman = prevWasAssistant && !looksLikeSystem;
    }

    prevWasAssistant = role === 'assistant';

    return {
      timestamp: e.timestamp,
      role,
      content,
      model: e.message?.model || null,
      isHuman,
    };
  });
}

/**
 * Simplify Claude message content blocks.
 * Keeps text as-is, truncates tool_use/tool_result to short summaries.
 * @param {Array | string | undefined} content
 * @returns {Array}
 */
export function simplifyContent(content) {
  if (!content) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];

  return content.map(block => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.type === 'tool_use') {
      const inputStr = typeof block.input === 'string'
        ? block.input
        : JSON.stringify(block.input);
      return {
        type: 'tool_use',
        name: block.name,
        input_summary: inputStr.length > 200 ? inputStr.slice(0, 200) + '...' : inputStr,
      };
    }
    if (block.type === 'tool_result') {
      const outputStr = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      return {
        type: 'tool_result',
        name: block.name || null,
        output_summary: outputStr.length > 200 ? outputStr.slice(0, 200) + '...' : outputStr,
      };
    }
    if (block.type === 'thinking') {
      return { type: 'thinking', text: block.thinking || block.text || '' };
    }
    return { type: block.type };
  });
}

/**
 * Extract only human/assistant conversation text from parsed transcript entries.
 * Drops tool_use, tool_result, thinking blocks, and system-injected user messages.
 * @param {Array} entries - parsed transcript entries from parseTranscript()
 * @returns {string}
 */
export function extractConversation(entries) {
  const parts = [];

  for (const entry of entries) {
    if (entry.role === 'user' && !entry.isHuman) continue;

    const textParts = entry.content
      .filter(b => b.type === 'text')
      .map(b => b.text);

    if (textParts.length === 0) continue;

    const label = entry.role === 'user' ? 'User' : 'Assistant';
    parts.push(`${label}: ${textParts.join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Get conversation text for all sessions in a workspace.
 * Discovers ALL JSONL files in the Claude project dir (not just DB-tracked sessions),
 * plus archived transcripts. Filters by mtime when `since` is provided for incremental reads.
 * Returns only human + assistant text, no tool calls or system messages.
 *
 * @param {string} workspaceId
 * @param {{ since?: string | null }} [options]
 * @returns {string} combined conversation text, truncated to MAX_CONVERSATION_CHARS from the end
 */
export function getWorkspaceConversationText(workspaceId, { since = null } = {}) {
  const db = getDb();
  const workspace = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) return '';

  const projectDir = claudeProjectDirForWorkspace(workspace.path);
  const cutoff = since ? new Date(since).getTime() : 0;

  // Discover all JSONL files in the Claude project dir.
  // This catches sessions started outside patrol (e.g. direct `claude` CLI).
  let jsonlFiles;
  try {
    jsonlFiles = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => join(projectDir, f));
  } catch {
    jsonlFiles = [];
  }

  // Also include archived transcripts from DB sessions (they live outside the project dir)
  const sessions = db.prepare('SELECT * FROM sessions WHERE workspace_id = ? ORDER BY started_at ASC').all(workspaceId);
  const seen = new Set(jsonlFiles);
  for (const sess of sessions) {
    const resolved = resolveSessionJsonlPath(sess, projectDir);
    if (resolved && !seen.has(resolved)) {
      jsonlFiles.push(resolved);
      seen.add(resolved);
    }
  }

  // Sort by mtime so older transcripts come first
  jsonlFiles.sort((a, b) => {
    try { return statSync(a).mtimeMs - statSync(b).mtimeMs; } catch { return 0; }
  });

  const parts = [];
  for (const jsonlPath of jsonlFiles) {
    // For incremental updates, only read files modified after the cutoff
    try {
      if (statSync(jsonlPath).mtimeMs <= cutoff) continue;
    } catch {
      continue;
    }

    try {
      const entries = parseTranscript(jsonlPath);
      const text = extractConversation(entries);
      if (text.trim()) {
        parts.push(`--- Session ---\n${text}`);
      }
    } catch {
      // Skip unreadable transcripts
    }
  }

  let combined = parts.join('\n\n');

  // Truncate from the beginning if too long (keep recent context)
  if (combined.length > MAX_CONVERSATION_CHARS) {
    combined = '...[earlier conversation truncated]...\n\n' +
      combined.slice(combined.length - MAX_CONVERSATION_CHARS);
  }

  return combined;
}
