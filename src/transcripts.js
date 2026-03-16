import { copyFileSync, readdirSync, statSync } from 'node:fs';
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
