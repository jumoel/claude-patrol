import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import {
  archiveTranscript,
  findSessionJsonl,
  getOrCreateTranscriptSummary,
  parseTranscript,
  resolveSessionJsonlPath,
} from './transcripts.js';

const roots = [];
afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'patrol-transcripts-'));
  roots.push(root);
  return root;
}

/** Write a JSONL file and pin its mtime. */
function writeJsonl(path, entries, mtimeMs) {
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

const T0 = Date.parse('2026-08-27T12:00:00.000Z');
const user = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (blocks) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude', content: blocks } });

test('findSessionJsonl picks the newest file modified inside the session window', () => {
  const dir = scratch();
  writeJsonl(join(dir, 'before.jsonl'), [user('old')], T0 - 60_000);
  writeJsonl(join(dir, 'during.jsonl'), [user('one')], T0 + 10_000);
  writeJsonl(join(dir, 'later.jsonl'), [user('two')], T0 + 20_000);
  writeJsonl(join(dir, 'after.jsonl'), [user('late')], T0 + 200_000);
  writeFileSync(join(dir, 'notes.txt'), 'ignored');

  const startedAt = new Date(T0).toISOString();
  const endedAt = new Date(T0 + 30_000).toISOString();
  assert.equal(findSessionJsonl(dir, startedAt, endedAt), join(dir, 'later.jsonl'));
  assert.equal(findSessionJsonl(dir, startedAt, null), join(dir, 'after.jsonl'), 'an open session accepts later files');
  assert.equal(findSessionJsonl(join(dir, 'missing'), startedAt, endedAt), null);
  assert.equal(findSessionJsonl(dir, new Date(T0 + 500_000).toISOString(), null), null);
});

test('parseTranscript tags human turns and summarizes tool blocks', () => {
  const dir = scratch();
  const path = join(dir, 'session.jsonl');
  writeJsonl(
    path,
    [
      user('Please fix the build'),
      assistant([
        { type: 'thinking', thinking: 'consider' },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(300) } },
      ]),
      user([{ type: 'tool_result', content: 'ok' }]),
      user('<system-reminder>injected</system-reminder>'),
      assistant([{ type: 'text', text: 'Done.' }]),
      { type: 'summary', ignored: true },
      'not json at all',
    ],
    T0,
  );
  writeFileSync(path, `${readFileSync(path, 'utf8')}garbage line\n`);

  const entries = parseTranscript(path);
  assert.deepEqual(
    entries.map((entry) => [entry.role, entry.isHuman]),
    [
      ['user', true],
      ['assistant', false],
      ['user', false],
      ['user', false],
      ['assistant', false],
    ],
  );
  const toolUse = entries[1].content.find((block) => block.type === 'tool_use');
  assert.equal(toolUse.name, 'Bash');
  assert.equal(toolUse.input_summary.length, 203, 'tool input is truncated to 200 characters plus an ellipsis');
  assert.deepEqual(entries[1].content[0], { type: 'thinking', text: 'consider' });
  assert.equal(entries[1].model, 'claude');
});

test('getOrCreateTranscriptSummary writes a markdown summary and reuses it while it is fresh', () => {
  const dir = scratch();
  const path = join(dir, 'session.jsonl');
  writeJsonl(path, [user('Question'), assistant([{ type: 'text', text: 'Answer' }])], T0);

  const summaryPath = getOrCreateTranscriptSummary(path);
  assert.equal(summaryPath, join(dir, 'session.summary.md'));
  const summary = readFileSync(summaryPath, 'utf8');
  assert.match(summary, /## User\n\nQuestion/);
  assert.match(summary, /## Assistant\n\nAnswer/);

  writeFileSync(summaryPath, 'cached');
  utimesSync(summaryPath, new Date(T0 + 5_000), new Date(T0 + 5_000));
  assert.equal(readFileSync(getOrCreateTranscriptSummary(path), 'utf8'), 'cached', 'a newer summary is kept');

  utimesSync(path, new Date(T0 + 10_000), new Date(T0 + 10_000));
  assert.match(readFileSync(getOrCreateTranscriptSummary(path), 'utf8'), /Question/, 'a newer JSONL regenerates it');
});

test('archiveTranscript copies the session JSONL into Patrol storage and records the path', () => {
  initDb(':memory:');
  const dir = scratch();
  writeJsonl(join(dir, 'session.jsonl'), [user('hello')], T0 + 1_000);
  const startedAt = new Date(T0).toISOString();
  getDb()
    .prepare("INSERT INTO sessions (id, pid, provider, status, started_at) VALUES ('s1', 1, 'claude', 'killed', ?)")
    .run(startedAt);

  const dest = archiveTranscript('s1', dir, startedAt, null);
  assert.ok(dest && existsSync(dest), 'the archive exists');
  assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(dir, 'session.jsonl'), 'utf8'));
  const row = getDb().prepare('SELECT transcript_path FROM sessions WHERE id = ?').get('s1');
  assert.equal(row.transcript_path, dest);

  assert.equal(archiveTranscript('s1', join(dir, 'missing'), startedAt, null), null, 'no JSONL is not an error');
  assert.equal(resolveSessionJsonlPath({ ...row, started_at: startedAt, ended_at: null }, null), dest);
  mkdirSync(join(dir, 'fallback'));
  writeJsonl(join(dir, 'fallback', 'live.jsonl'), [user('live')], T0 + 2_000);
  assert.equal(
    resolveSessionJsonlPath({ transcript_path: null, started_at: startedAt, ended_at: null }, join(dir, 'fallback')),
    join(dir, 'fallback', 'live.jsonl'),
  );
});
