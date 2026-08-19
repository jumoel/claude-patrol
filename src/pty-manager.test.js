import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { CODEX_REVIEW_TIMEOUT_MS } from './codex-review.js';
import { closeDb, getDb, initDb } from './db.js';
import {
  createSessionWithRuntime,
  dispatchWsMessage,
  getSessionCodexReviewReadiness,
  PATROL_MCP_TIMEOUT_MS,
  setMcpPort,
} from './pty-manager.js';

afterEach(() => closeDb());

it('keeps the outer Claude MCP timeout above the nested Codex review timeout', () => {
  assert.ok(PATROL_MCP_TIMEOUT_MS > CODEX_REVIEW_TIMEOUT_MS);
});

it('accepts legacy MCP configs unless they explicitly set a short tool timeout', () => {
  initDb(':memory:');
  const sessionId = randomUUID();
  const path = resolve(tmpdir(), `patrol-mcp-${sessionId}.json`);
  try {
    writeFileSync(path, JSON.stringify({ mcpServers: { patrol: { type: 'http', url: 'http://localhost/mcp' } } }));
    assert.deepEqual(getSessionCodexReviewReadiness(sessionId), { ready: true, reason: null });

    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { patrol: { type: 'http', url: 'http://localhost/mcp', timeout: 1000 } } }),
    );
    assert.deepEqual(getSessionCodexReviewReadiness(sessionId), {
      ready: false,
      reason: 'session_restart_required',
    });
  } finally {
    unlinkSync(path);
  }
});

it('rolls back tmux and database state when PTY attachment fails', () => {
  initDb(':memory:');
  const sessionId = 'failed-session';
  const commands = [];
  const runtime = {
    randomUUID: () => sessionId,
    execFileSync(command, args) {
      commands.push([command, ...args]);
    },
    spawnPty() {
      throw new Error('simulated PTY attach failure');
    },
  };

  assert.throws(() => createSessionWithRuntime(null, process.cwd(), { runtime }), /simulated PTY attach failure/);
  assert.deepEqual(commands.at(-1), ['tmux', 'kill-session', '-t', `patrol-${sessionId}`]);
  assert.equal(getDb().prepare('SELECT COUNT(*) AS count FROM sessions WHERE id = ?').get(sessionId).count, 0);
});

it('removes an inherited NO_COLOR setting from the Claude process', () => {
  initDb(':memory:');
  const commands = [];
  const runtime = {
    randomUUID: () => 'color-session',
    execFileSync(command, args) {
      commands.push([command, ...args]);
    },
    spawnPty() {
      throw new Error('stop after command capture');
    },
  };

  assert.throws(() => createSessionWithRuntime(null, process.cwd(), { runtime }), /stop after command capture/);
  const newSession = commands.find(([command, subcommand]) => command === 'tmux' && subcommand === 'new-session');
  assert.match(newSession.at(-1), /^'env' '-u' 'NO_COLOR' 'claude'/);
});

it('launches Codex with the session-scoped Patrol MCP server and instructions', () => {
  initDb(':memory:');
  setMcpPort(4242);
  const commands = [];
  const runtime = {
    randomUUID: () => 'codex-session',
    execFileSync(command, args) {
      commands.push([command, ...args]);
    },
    spawnPty() {
      throw new Error('stop after command capture');
    },
  };

  assert.throws(
    () => createSessionWithRuntime(null, '/tmp/patrol-workspace', { provider: 'codex', runtime }),
    /stop after command capture/,
  );
  const newSession = commands.find(([command, subcommand]) => command === 'tmux' && subcommand === 'new-session');
  const shellCommand = newSession.at(-1);
  assert.match(shellCommand, /^'env' '-u' 'NO_COLOR' 'codex' '-C' '\/tmp\/patrol-workspace'/);
  assert.match(shellCommand, /mcp_servers\.patrol\.url=/);
  assert.match(shellCommand, /mcp_servers\.patrol\.required=true/);
  assert.match(shellCommand, /developer_instructions=/);
});

it('writes per-session MCP config with the explicitly recorded port', () => {
  initDb(':memory:');
  setMcpPort(4242);
  let mcpConfig;
  const runtime = {
    randomUUID: () => 'port-session',
    execFileSync(command, args) {
      if (command === 'tmux' && args[0] === 'new-session') {
        const path = resolve(tmpdir(), 'patrol-mcp-port-session.json');
        mcpConfig = JSON.parse(readFileSync(path, 'utf8'));
      }
    },
    spawnPty() {
      throw new Error('stop after config capture');
    },
  };

  assert.throws(() => createSessionWithRuntime(null, process.cwd(), { runtime }), /stop after config capture/);
  assert.equal(mcpConfig.mcpServers.patrol.url, 'http://127.0.0.1:4242/mcp/port-session');
  assert.throws(() => setMcpPort({ port: 3000 }), /Invalid MCP port/);
});

/**
 * Defense against the regression class that produced `claude-patrol#2`: the
 * WS message validator and handler used to be two independently-maintained
 * lists. These tests exercise every documented WS message type through the
 * unified dispatcher so adding a handler arm without validation (or vice
 * versa) breaks here, not in production after a user-reported regression.
 */

function makeEntry() {
  const writes = [];
  const resizes = [];
  return {
    writes,
    resizes,
    proc: {
      write(data) {
        writes.push(data);
      },
      resize(cols, rows) {
        resizes.push([cols, rows]);
      },
    },
  };
}

const ctx = { tmuxName: 'patrol-test' };

describe('dispatchWsMessage', () => {
  it('routes input to PTY write', () => {
    const entry = makeEntry();
    const result = dispatchWsMessage(JSON.stringify({ type: 'input', data: 'hello' }), entry, ctx);
    assert.deepEqual(result, { type: 'input' });
    assert.deepEqual(entry.writes, ['hello']);
  });

  it('routes resize to PTY resize and sets suppression window', () => {
    const entry = makeEntry();
    const before = Date.now();
    const result = dispatchWsMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), entry, ctx);
    assert.deepEqual(result, { type: 'resize' });
    assert.deepEqual(entry.resizes, [[120, 40]]);
    assert.ok(entry.resizeSuppressUntil >= before);
  });

  it('routes prompt-submit to the splitting submitter (text first, Enter later)', async () => {
    const entry = makeEntry();
    const result = dispatchWsMessage(
      JSON.stringify({ type: 'prompt-submit', text: 'investigate failures' }),
      entry,
      ctx,
    );
    assert.deepEqual(result, { type: 'prompt-submit' });
    // Text is written synchronously; the Enter follows after the split delay.
    assert.deepEqual(entry.writes, ['investigate failures']);
    // Wait long enough for the split-write delay (PROMPT_SUBMIT_DELAY_MS = 100ms).
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(entry.writes, ['investigate failures', '\r']);
  });

  it('strips trailing carriage returns from prompt-submit text', async () => {
    const entry = makeEntry();
    dispatchWsMessage(JSON.stringify({ type: 'prompt-submit', text: 'foo\r' }), entry, ctx);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(entry.writes, ['foo', '\r']);
  });

  it('rejects unknown message types', () => {
    const entry = makeEntry();
    const result = dispatchWsMessage(JSON.stringify({ type: 'something-else', data: 'x' }), entry, ctx);
    assert.equal(result, null);
    assert.deepEqual(entry.writes, []);
  });

  it('rejects malformed JSON', () => {
    const entry = makeEntry();
    const result = dispatchWsMessage('not json', entry, ctx);
    assert.equal(result, null);
  });

  it('rejects messages with missing or wrong-type fields', () => {
    const entry = makeEntry();
    // input without data
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'input' }), entry, ctx), null);
    // input with non-string data
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'input', data: 42 }), entry, ctx), null);
    // prompt-submit without text
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'prompt-submit' }), entry, ctx), null);
    // prompt-submit with non-string text
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'prompt-submit', text: 42 }), entry, ctx), null);
    // resize with non-integer dims
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'resize', cols: 'wide', rows: 40 }), entry, ctx), null);
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 'resize', cols: 80.5, rows: 40 }), entry, ctx), null);
    assert.deepEqual(entry.writes, []);
    assert.deepEqual(entry.resizes, []);
  });

  it('rejects messages without a string type field', () => {
    const entry = makeEntry();
    assert.equal(dispatchWsMessage(JSON.stringify({ data: 'x' }), entry, ctx), null);
    assert.equal(dispatchWsMessage(JSON.stringify({ type: 42 }), entry, ctx), null);
    assert.equal(dispatchWsMessage(JSON.stringify(null), entry, ctx), null);
  });
});
