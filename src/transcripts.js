import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from './db.js';
import { transcriptsDir } from './paths.js';

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
