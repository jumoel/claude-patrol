import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJavaScriptChangePoller, snapshotJavaScriptFiles } from './file-change-poller.js';

test('snapshot includes nested JavaScript files and excludes other files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claude-patrol-poller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'root.js'), 'one');
  writeFileSync(join(root, 'nested', 'child.js'), 'two');
  writeFileSync(join(root, 'ignored.json'), '{}');

  assert.deepEqual([...snapshotJavaScriptFiles(root).keys()].sort(), ['nested/child.js', 'root.js']);
});

test('poller reports added, changed, and deleted JavaScript files', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claude-patrol-poller-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const existing = join(root, 'existing.js');
  writeFileSync(existing, 'one');

  const changes = [];
  const poller = createJavaScriptChangePoller(root, (path) => changes.push(path), { intervalMs: 60_000 });
  t.after(() => poller.close());

  writeFileSync(existing, 'longer contents');
  writeFileSync(join(root, 'added.js'), 'added');
  poller.poll();
  assert.deepEqual(changes.sort(), ['added.js', 'existing.js']);

  changes.length = 0;
  unlinkSync(existing);
  poller.poll();
  assert.deepEqual(changes, ['existing.js']);
});
