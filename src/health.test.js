import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { closeDb, getDb, initDb } from './db.js';
import { startHealthChecks, stopHealthChecks } from './health.js';

afterEach(() => {
  stopHealthChecks();
  closeDb();
});

test('the health check marks dead-pid sessions killed and missing workspace directories as errors', () => {
  initDb(':memory:');
  const db = getDb();
  const now = '2026-08-27T12:00:00.000Z';
  const present = mkdtempSync(join(tmpdir(), 'patrol-health-'));
  try {
    db.prepare(
      "INSERT INTO sessions (id, pid, provider, status, started_at) VALUES ('alive', ?, 'claude', 'active', ?)",
    ).run(process.pid, now);
    db.prepare(
      "INSERT INTO sessions (id, pid, provider, status, started_at) VALUES ('dead', ?, 'claude', 'active', ?)",
    ).run(2 ** 22 + 4242, now);
    db.prepare(
      `INSERT INTO workspaces (id, name, path, bookmark, repo, status, created_at, operation_state)
       VALUES ('present', 'present', ?, 'b', 'acme/a', 'active', ?, 'ready'),
              ('gone', 'gone', ?, 'b', 'acme/a', 'active', ?, 'ready')`,
    ).run(present, now, join(present, 'missing'), now);

    const originalLog = console.log;
    console.log = () => {};
    try {
      startHealthChecks(60_000);
    } finally {
      console.log = originalLog;
    }

    const status = (id) => db.prepare('SELECT status FROM sessions WHERE id = ?').get(id).status;
    assert.equal(status('alive'), 'active');
    assert.equal(status('dead'), 'killed');
    const workspace = (id) => ({
      ...db.prepare('SELECT operation_state, operation_step FROM workspaces WHERE id = ?').get(id),
    });
    assert.deepEqual(workspace('present'), { operation_state: 'ready', operation_step: null });
    assert.deepEqual(workspace('gone'), { operation_state: 'error', operation_step: 'health:missing_path' });
  } finally {
    rmSync(present, { recursive: true, force: true });
  }
});
