import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { actionRegistry } from './actions.js';
import { appEvents } from './app-events.js';
import { CLAUDE_REVIEW_TIMEOUT_MS } from './claude-review.js';
import { CODEX_REVIEW_TIMEOUT_MS } from './codex-review.js';
import { closeDb, getDb, initDb } from './db.js';
import {
  activeSessionCount,
  createSessionWithRuntime,
  dispatchWsMessage,
  getSessionPeerReviewReadiness,
  getSessionSnapshot,
  getSessionStates,
  killSession,
  killSessionAndWait,
  MAX_LIVE_GLOBAL_SESSIONS,
  normalizeGlobalSessionName,
  PATROL_MCP_TIMEOUT_MS,
  pollSessionStatuses,
  RingBuffer,
  reattachOrphanedSessions,
  recordProviderActivity,
  setMcpPort,
  TerminalOutputBatcher,
} from './pty-manager.js';
import {
  activityCredentialPathForSession,
  activitySettingsPathForSession,
  buildSessionLaunch,
  readActivityCredential,
} from './session-launch.js';
import { insertTestWorkItem } from './test-support/work-items.js';

afterEach(() => closeDb());

it('keeps the outer MCP timeout above either nested peer review timeout', () => {
  assert.ok(PATROL_MCP_TIMEOUT_MS > CODEX_REVIEW_TIMEOUT_MS);
  assert.ok(PATROL_MCP_TIMEOUT_MS > CLAUDE_REVIEW_TIMEOUT_MS);
});

describe('RingBuffer', () => {
  it('retains the newest bytes across repeated wraparound', () => {
    const buffer = new RingBuffer(7);
    let expected = Buffer.alloc(0);

    for (const chunk of ['ab', 'cdef', 'ghi', Buffer.from('jklmn')]) {
      buffer.append(chunk);
      expected = Buffer.concat([expected, Buffer.from(chunk)]).subarray(-7);
      assert.deepEqual(buffer.contents(), expected);
    }
  });

  it('keeps only the tail of chunks larger than its capacity', () => {
    const buffer = new RingBuffer(5);
    buffer.append('0123456789');
    assert.equal(buffer.contents().toString(), '56789');
  });

  it('rejects invalid capacities', () => {
    assert.throws(() => new RingBuffer(0), /positive integer/);
    assert.throws(() => new RingBuffer(1.5), /positive integer/);
  });
});

describe('TerminalOutputBatcher', () => {
  it('sends adjacent PTY chunks in one output frame', () => {
    const sent = [];
    const socket = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
    let scheduledFlush = null;
    const batcher = new TerminalOutputBatcher(
      new Set([socket]),
      (callback) => {
        scheduledFlush = callback;
        return 1;
      },
      () => {
        scheduledFlush = null;
      },
    );

    batcher.append('first');
    batcher.append('-second');
    assert.deepEqual(sent, []);

    scheduledFlush();
    assert.deepEqual(sent, [{ type: 'output', data: 'first-second' }]);
  });

  it('flushes synchronously when output ordering requires it', () => {
    const sent = [];
    const socket = { readyState: 1, send: (message) => sent.push(JSON.parse(message)) };
    let cancelCount = 0;
    const batcher = new TerminalOutputBatcher(
      new Set([socket]),
      () => 1,
      () => {
        cancelCount++;
      },
    );

    batcher.append('tail');
    batcher.flush();

    assert.equal(cancelCount, 1);
    assert.deepEqual(sent, [{ type: 'output', data: 'tail' }]);
  });

  it('does not schedule or serialize output without an open client', () => {
    let scheduleCount = 0;
    const batcher = new TerminalOutputBatcher(new Set([{ readyState: 3 }]), () => {
      scheduleCount++;
    });

    batcher.append('unobserved');
    batcher.flush();

    assert.equal(scheduleCount, 0);
  });
});

it('accepts legacy MCP configs unless they explicitly set a short tool timeout', () => {
  initDb(':memory:');
  const sessionId = randomUUID();
  const path = resolve(tmpdir(), `patrol-mcp-${sessionId}.json`);
  try {
    writeFileSync(path, JSON.stringify({ mcpServers: { patrol: { type: 'http', url: 'http://localhost/mcp' } } }));
    assert.deepEqual(getSessionPeerReviewReadiness(sessionId), { ready: true, reason: null });

    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { patrol: { type: 'http', url: 'http://localhost/mcp', timeout: 1000 } } }),
    );
    assert.deepEqual(getSessionPeerReviewReadiness(sessionId), {
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

  assert.throws(
    () => createSessionWithRuntime({ type: 'global' }, process.cwd(), { runtime }),
    /simulated PTY attach failure/,
  );
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

  assert.throws(
    () => createSessionWithRuntime({ type: 'global' }, process.cwd(), { runtime }),
    /stop after command capture/,
  );
  const newSession = commands.find(([command, subcommand]) => command === 'tmux' && subcommand === 'new-session');
  assert.match(newSession.at(-1), /^'env' '-u' 'NO_COLOR' 'claude'/);
});

it('launches MCP-free provider sessions without submitting an initial prompt', () => {
  const common = {
    sessionId: 'idle-session',
    cwd: '/tmp/patrol-work-item',
    port: 4242,
    patrolPrompt: 'unused',
    mcpTimeoutMs: PATROL_MCP_TIMEOUT_MS,
    enablePatrolMcp: false,
  };

  assert.deepEqual(buildSessionLaunch({ ...common, provider: 'claude' }).commandArgs, [
    'env',
    '-u',
    'NO_COLOR',
    'claude',
  ]);
  assert.deepEqual(buildSessionLaunch({ ...common, provider: 'codex' }).commandArgs, [
    'env',
    '-u',
    'NO_COLOR',
    'codex',
    '-C',
    '/tmp/patrol-work-item',
  ]);
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
    () => createSessionWithRuntime({ type: 'global' }, '/tmp/patrol-workspace', { provider: 'codex', runtime }),
    /stop after command capture/,
  );
  const newSession = commands.find(([command, subcommand]) => command === 'tmux' && subcommand === 'new-session');
  const shellCommand = newSession.at(-1);
  assert.match(shellCommand, /^'env' '-u' 'NO_COLOR' 'PATROL_ACTIVITY_URL=/);
  assert.match(shellCommand, /'codex' '-C' '\/tmp\/patrol-workspace'/);
  assert.match(shellCommand, /notify=\[.*provider-activity-notify\.js/);
  assert.match(shellCommand, /mcp_servers\.patrol\.url=/);
  assert.match(shellCommand, /mcp_servers\.patrol\.required=true/);
  assert.match(shellCommand, /developer_instructions=/);
});

it('writes protected Claude hooks and Codex notifier credentials', () => {
  const launches = [
    buildSessionLaunch({
      provider: 'claude',
      sessionId: 'claude-activity-launch',
      cwd: '/tmp/patrol-work-item',
      port: 4242,
      patrolPrompt: 'unused',
      mcpTimeoutMs: PATROL_MCP_TIMEOUT_MS,
      enablePatrolMcp: false,
      activityToken: 'claude-activity-token',
    }),
    buildSessionLaunch({
      provider: 'codex',
      sessionId: 'codex-activity-launch',
      cwd: '/tmp/patrol-work-item',
      port: 4242,
      patrolPrompt: 'unused',
      mcpTimeoutMs: PATROL_MCP_TIMEOUT_MS,
      enablePatrolMcp: false,
      activityToken: 'codex-activity-token',
    }),
  ];

  try {
    const claudeSettings = JSON.parse(readFileSync(activitySettingsPathForSession('claude-activity-launch')));
    assert.deepEqual(Object.keys(claudeSettings.hooks), [
      'UserPromptSubmit',
      'MessageDisplay',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'Stop',
      'StopFailure',
    ]);
    assert.equal(claudeSettings.hooks.Stop[0].hooks[0].type, 'command');
    assert.match(claudeSettings.hooks.Stop[0].hooks[0].command, /provider-activity-notify\.js' 'claude'/);
    assert.equal(statSync(activitySettingsPathForSession('claude-activity-launch')).mode & 0o777, 0o600);
    assert.deepEqual(readActivityCredential('codex-activity-launch'), {
      provider: 'codex',
      token: 'codex-activity-token',
    });
    assert.equal(statSync(activityCredentialPathForSession('codex-activity-launch')).mode & 0o777, 0o600);
    assert.match(launches[1].commandArgs.join(' '), /notify=\[.*provider-activity-notify\.js/);
  } finally {
    for (const launch of launches) {
      for (const path of launch.tempPaths) {
        try {
          unlinkSync(path);
        } catch {}
      }
    }
  }
});

it('authenticates provider events and rejects stale or mismatched runs', () => {
  initDb(':memory:');
  setMcpPort(4242);
  let exitHandler = null;
  const runtime = {
    randomUUID: () => 'provider-event-session',
    execFileSync() {},
    spawnPty() {
      return {
        pid: 42,
        onData() {},
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  createSessionWithRuntime({ type: 'global' }, process.cwd(), {
    provider: 'claude',
    enablePatrolMcp: false,
    runtime,
  });
  const { token } = readActivityCredential('provider-event-session');

  assert.deepEqual(
    recordProviderActivity('provider-event-session', 'claude', 'wrong-token-value', {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-1',
    }),
    { accepted: false, reason: 'invalid_credential', status: 403 },
  );
  assert.deepEqual(
    recordProviderActivity('provider-event-session', 'codex', token, {
      event: 'turn_completed',
      run_id: 'turn-1',
    }),
    { accepted: false, reason: 'provider_mismatch', status: 409 },
  );
  assert.deepEqual(
    recordProviderActivity('provider-event-session', 'claude', token, {
      hook_event_name: 'UserPromptSubmit',
      prompt_id: 'prompt-1',
    }),
    { accepted: true, duplicate: false, status: 202 },
  );
  assert.equal(getSessionSnapshot('provider-event-session').nativeTracking, true);
  assert.deepEqual(
    recordProviderActivity('provider-event-session', 'claude', token, {
      hook_event_name: 'Stop',
      prompt_id: 'prompt-old',
    }),
    { accepted: false, reason: 'stale_event', status: 409 },
  );
  assert.deepEqual(
    recordProviderActivity('provider-event-session', 'claude', token, {
      hook_event_name: 'Stop',
      prompt_id: 'prompt-1',
    }),
    { accepted: true, duplicate: false, status: 202 },
  );
  assert.equal(getSessionSnapshot('provider-event-session').activityState, 'idle');
  assert.equal(getSessionSnapshot('provider-event-session').completionConfirmed, false);

  killSession('provider-event-session', { killTmux() {}, isTmuxAlive: () => false });
  assert.equal(activeSessionCount(), 0);
});

it('does not infer provider activity from terminal output', () => {
  initDb(':memory:');
  setMcpPort(4242);
  let dataHandler = null;
  let exitHandler = null;
  const runtime = {
    randomUUID: () => 'provider-output-session',
    execFileSync() {},
    spawnPty() {
      return {
        pid: 45,
        onData(handler) {
          dataHandler = handler;
        },
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  createSessionWithRuntime({ type: 'global' }, process.cwd(), {
    provider: 'claude',
    enablePatrolMcp: false,
    runtime,
  });

  dataHandler('terminal redraw before a provider event'.repeat(100));
  assert.equal(getSessionSnapshot('provider-output-session').activityState, null);

  const { token } = readActivityCredential('provider-output-session');
  recordProviderActivity('provider-output-session', 'claude', token, {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-1',
  });
  recordProviderActivity('provider-output-session', 'claude', token, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
  });
  const idle = getSessionSnapshot('provider-output-session');

  dataHandler('terminal redraw caused by scrolling'.repeat(100));
  assert.deepEqual(getSessionSnapshot('provider-output-session'), idle);

  killSession('provider-output-session', { killTmux() {}, isTmuxAlive: () => false });
});

it('persists the last idle transition for work-item sessions', () => {
  initDb(':memory:');
  setMcpPort(4242);
  const now = new Date().toISOString();
  insertTestWorkItem(getDb(), { id: 'item-1', path: process.cwd(), createdAt: now });
  let exitHandler = null;
  const runtime = {
    randomUUID: () => 'work-item-idle-session',
    execFileSync() {},
    spawnPty() {
      return {
        pid: 44,
        onData() {},
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  createSessionWithRuntime({ type: 'work_item', id: 'item-1' }, process.cwd(), {
    provider: 'claude',
    enablePatrolMcp: false,
    runtime,
  });
  const { token } = readActivityCredential('work-item-idle-session');
  recordProviderActivity('work-item-idle-session', 'claude', token, {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-1',
  });
  recordProviderActivity('work-item-idle-session', 'claude', token, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
  });

  const snapshot = getSessionSnapshot('work-item-idle-session');
  const expectedIdleAt = new Date(snapshot.lastIdleAt).toISOString();
  assert.equal(
    getDb().prepare('SELECT last_idle_at FROM sessions WHERE id = ?').get('work-item-idle-session').last_idle_at,
    expectedIdleAt,
  );
  assert.equal(
    getSessionStates().find((state) => state.sessionId === 'work-item-idle-session').activity_changed_at,
    expectedIdleAt,
  );

  killSession('work-item-idle-session', { killTmux() {}, isTmuxAlive: () => false });
});

it('wait_for_idle ignores candidate stops and reports provider failures', async () => {
  initDb(':memory:');
  setMcpPort(4242);
  let exitHandler = null;
  const runtime = {
    randomUUID: () => 'wait-provider-session',
    activityIdleThresholdMs: 20,
    execFileSync() {},
    spawnPty() {
      return {
        pid: 43,
        onData() {},
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };
  createSessionWithRuntime({ type: 'global' }, process.cwd(), {
    provider: 'claude',
    enablePatrolMcp: false,
    runtime,
  });
  const { token } = readActivityCredential('wait-provider-session');
  recordProviderActivity('wait-provider-session', 'claude', token, {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-1',
  });
  const since = getSessionSnapshot('wait-provider-session').lastWorkingAt;
  const waiting = actionRegistry.wait_for_idle.mcpHandler(null, {
    session_id: 'wait-provider-session',
    since,
    timeout_minutes: 1,
  });
  recordProviderActivity('wait-provider-session', 'claude', token, {
    hook_event_name: 'Stop',
    prompt_id: 'prompt-1',
  });
  const resolvedEarly = await Promise.race([
    waiting.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 5)),
  ]);
  assert.equal(resolvedEarly, false);
  assert.equal((await waiting).ok, true);

  recordProviderActivity('wait-provider-session', 'claude', token, {
    hook_event_name: 'UserPromptSubmit',
    prompt_id: 'prompt-2',
  });
  const failedSince = getSessionSnapshot('wait-provider-session').lastWorkingAt;
  const failure = actionRegistry.wait_for_idle.mcpHandler(null, {
    session_id: 'wait-provider-session',
    since: failedSince,
    timeout_minutes: 1,
  });
  recordProviderActivity('wait-provider-session', 'claude', token, {
    hook_event_name: 'StopFailure',
    prompt_id: 'prompt-2',
  });
  assert.deepEqual(await failure, {
    ok: false,
    error: 'provider_failure',
    message: 'session wait-provider-session provider turn failed',
  });

  killSession('wait-provider-session', { killTmux() {}, isTmuxAlive: () => false });
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

  assert.throws(
    () => createSessionWithRuntime({ type: 'global' }, process.cwd(), { runtime }),
    /stop after config capture/,
  );
  assert.equal(mcpConfig.mcpServers.patrol.url, 'http://127.0.0.1:4242/mcp/port-session');
  assert.throws(() => setMcpPort({ port: 3000 }), /Invalid MCP port/);
});

it('bypasses global reuse only when distinct creation is requested', () => {
  initDb(':memory:');
  getDb()
    .prepare(
      `INSERT INTO sessions (id, name, pid, provider, status, started_at)
       VALUES ('existing-global', 'Codex 1', 10, 'codex', 'active', ?)`,
    )
    .run(new Date().toISOString());

  const commands = [];
  let exitHandler = null;
  const runtime = {
    randomUUID: () => 'new-global',
    isTmuxAlive: () => true,
    execFileSync(command, args) {
      commands.push([command, ...args]);
    },
    spawnPty() {
      return {
        pid: 20,
        onData() {},
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  const reused = createSessionWithRuntime({ type: 'global' }, process.cwd(), {
    provider: 'codex',
    enablePatrolMcp: false,
    runtime,
  });
  assert.equal(reused.id, 'existing-global');
  assert.equal(commands.length, 0);

  const distinct = createSessionWithRuntime({ type: 'global' }, process.cwd(), {
    provider: 'codex',
    enablePatrolMcp: false,
    reuseExisting: false,
    runtime,
  });
  assert.equal(distinct.id, 'new-global');
  assert.equal(distinct.name, 'Codex 2');
  assert.ok(commands.some(([command, subcommand]) => command === 'tmux' && subcommand === 'new-session'));
  assert.deepEqual(
    getDb()
      .prepare("SELECT id, name, status FROM sessions WHERE status IN ('active', 'detached') ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'existing-global', name: 'Codex 1', status: 'active' },
      { id: 'new-global', name: 'Codex 2', status: 'active' },
    ],
  );

  killSession('new-global', { killTmux() {}, isTmuxAlive: () => false });
  assert.equal(activeSessionCount(), 0);
});

it('rejects deceptive session names and bounds live global processes', () => {
  assert.equal(normalizeGlobalSessionName('  Planner 🚀  '), 'Planner 🚀');
  assert.throws(() => normalizeGlobalSessionName('safe\u202ereversed'), /formatting characters/);
  assert.throws(() => normalizeGlobalSessionName('zero\u200bwidth'), /formatting characters/);

  initDb(':memory:');
  const insert = getDb().prepare(
    `INSERT INTO sessions (id, name, pid, provider, status, started_at)
     VALUES (?, ?, 1, 'claude', 'detached', ?)`,
  );
  for (let index = 0; index < MAX_LIVE_GLOBAL_SESSIONS; index++) {
    insert.run(`global-${index}`, `Claude ${index + 1}`, new Date().toISOString());
  }

  assert.throws(
    () =>
      createSessionWithRuntime({ type: 'global' }, process.cwd(), {
        provider: 'claude',
        reuseExisting: false,
        runtime: {
          randomUUID: () => 'over-limit',
          execFileSync() {
            assert.fail('the process limit must be checked before tmux starts');
          },
          isTmuxAlive: () => true,
          spawnPty() {
            assert.fail('the process limit must be checked before PTY attachment');
          },
        },
      }),
    (error) => error.code === 'global_session_limit',
  );
});

it('reattaches every surviving global session after an update', () => {
  initDb(':memory:');
  const now = new Date().toISOString();
  const insert = getDb().prepare(
    `INSERT INTO sessions (id, name, pid, provider, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run('global-one', 'Planner', 11, 'claude', 'active', now);
  insert.run('global-two', 'Reviewer', 22, 'codex', 'detached', now);

  const exitHandlers = new Map();
  const attached = [];
  const runtime = {
    randomUUID,
    isTmuxAlive: () => true,
    execFileSync() {},
    spawnPty(_file, args) {
      const sessionId = args.at(-1).replace('patrol-', '');
      attached.push(sessionId);
      return {
        pid: sessionId === 'global-one' ? 111 : 222,
        onData() {},
        onExit(handler) {
          exitHandlers.set(sessionId, handler);
        },
        kill() {
          exitHandlers.get(sessionId)?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  assert.equal(reattachOrphanedSessions(runtime), 2);
  assert.deepEqual(attached.sort(), ['global-one', 'global-two']);
  assert.equal(activeSessionCount(), 2);
  assert.deepEqual(
    getDb()
      .prepare('SELECT id, name, status FROM sessions ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'global-one', name: 'Planner', status: 'active' },
      { id: 'global-two', name: 'Reviewer', status: 'active' },
    ],
  );

  for (const sessionId of attached) {
    killSession(sessionId, { killTmux() {}, isTmuxAlive: () => false });
  }
  assert.equal(activeSessionCount(), 0);
});

it('polls reattached sessions until their provider reports a terminal state', async () => {
  initDb(':memory:');
  getDb()
    .prepare(
      `INSERT INTO sessions (id, name, pid, provider, status, started_at)
       VALUES ('reattach-status', 'Active turn', 11, 'codex', 'active', ?)`,
    )
    .run(new Date().toISOString());
  let exitHandler = null;
  const runtime = {
    isTmuxAlive: () => true,
    execFileSync() {},
    spawnPty() {
      return {
        pid: 12,
        onData() {},
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  assert.equal(reattachOrphanedSessions(runtime), 1);
  const observedCandidates = [];
  assert.equal(
    await pollSessionStatuses({
      probe: async (candidates) => {
        observedCandidates.push(candidates);
        return new Map([['reattach-status', { state: 'working', source: 'codex_status_poll' }]]);
      },
    }),
    1,
  );
  assert.equal(getSessionSnapshot('reattach-status').activityState, 'working');

  assert.equal(
    await pollSessionStatuses({
      probe: async () => new Map([['reattach-status', { state: 'idle', source: 'codex_status_poll' }]]),
    }),
    1,
  );
  assert.equal(getSessionSnapshot('reattach-status').activityState, 'idle');
  assert.equal(getSessionSnapshot('reattach-status').completionConfirmed, true);
  assert.deepEqual(observedCandidates, [[{ sessionId: 'reattach-status', provider: 'codex' }]]);

  assert.equal(
    await pollSessionStatuses({
      probe: async () => {
        assert.fail('idle reattached sessions should leave the polling set');
      },
    }),
    0,
  );

  killSession('reattach-status', { killTmux() {}, isTmuxAlive: () => false });
});

it('keeps a live Codex turn working until the pane title reports idle', async () => {
  initDb(':memory:');
  setMcpPort(4242);
  let exitHandler = null;
  const runtime = {
    randomUUID: () => 'live-codex-status',
    execFileSync() {},
    spawnPty() {
      return {
        pid: 12,
        onData() {},
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  createSessionWithRuntime({ type: 'global' }, process.cwd(), {
    provider: 'codex',
    enablePatrolMcp: false,
    initialPrompt: 'inspect the active pull request',
    runtime,
  });
  const { token } = readActivityCredential('live-codex-status');
  assert.equal(getSessionSnapshot('live-codex-status').activityState, 'working');

  assert.deepEqual(
    recordProviderActivity('live-codex-status', 'codex', token, {
      event: 'turn_completed',
      run_id: 'turn-1',
    }),
    { accepted: true, duplicate: false, status: 202 },
  );
  assert.equal(getSessionSnapshot('live-codex-status').activityState, 'working');

  let resolveStaleProbe;
  const stalePoll = pollSessionStatuses({
    probe: async () =>
      new Promise((resolvePromise) => {
        resolveStaleProbe = resolvePromise;
      }),
  });
  await Promise.resolve();
  recordProviderActivity('live-codex-status', 'codex', token, {
    event: 'turn_completed',
    run_id: 'turn-2',
  });
  resolveStaleProbe(new Map([['live-codex-status', { state: 'idle', source: 'codex_status_poll' }]]));
  assert.equal(await stalePoll, 0);
  assert.equal(getSessionSnapshot('live-codex-status').activityState, 'working');

  assert.equal(
    await pollSessionStatuses({
      probe: async () => new Map([['live-codex-status', { state: 'working', source: 'codex_status_poll' }]]),
    }),
    1,
  );
  assert.equal(getSessionSnapshot('live-codex-status').activityState, 'working');

  assert.equal(
    await pollSessionStatuses({
      probe: async () => new Map([['live-codex-status', { state: 'idle', source: 'codex_status_poll' }]]),
    }),
    1,
  );
  assert.equal(getSessionSnapshot('live-codex-status').activityState, 'idle');

  assert.equal(
    await pollSessionStatuses({
      probe: async () => {
        assert.fail('an idle Codex session should leave the polling set');
      },
    }),
    0,
  );

  killSession('live-codex-status', { killTmux() {}, isTmuxAlive: () => false });
});

it('restores the stored idle timestamp instead of creating a new waiting transition', async () => {
  initDb(':memory:');
  const storedIdleAt = '2026-08-27T12:00:00.000Z';
  const now = new Date().toISOString();
  const insert = getDb().prepare(
    `INSERT INTO sessions (id, name, pid, provider, status, started_at, last_idle_at)
     VALUES (?, ?, 11, 'codex', 'active', ?, ?)`,
  );
  insert.run('reattach-with-stored-idle', 'Stored idle', now, storedIdleAt);
  insert.run('reattach-never-idle', 'No stored idle', now, null);

  const exitHandlers = new Map();
  const runtime = {
    isTmuxAlive: () => true,
    execFileSync() {},
    spawnPty(_file, args) {
      const sessionId = args.at(-1).replace('patrol-', '');
      return {
        pid: 12,
        onData() {},
        onExit(handler) {
          exitHandlers.set(sessionId, handler);
        },
        kill() {
          exitHandlers.get(sessionId)?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  assert.equal(reattachOrphanedSessions(runtime), 2);
  assert.equal(
    await pollSessionStatuses({
      probe: async () =>
        new Map([
          ['reattach-with-stored-idle', { state: 'idle', source: 'codex_status_poll' }],
          ['reattach-never-idle', { state: 'idle', source: 'codex_status_poll' }],
        ]),
    }),
    2,
  );

  const states = new Map(getSessionStates().map((state) => [state.sessionId, state]));
  assert.equal(states.get('reattach-with-stored-idle').activity_changed_at, storedIdleAt);
  assert.equal(states.get('reattach-never-idle').activity_changed_at, null);
  assert.deepEqual(
    getDb()
      .prepare('SELECT id, last_idle_at FROM sessions ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { id: 'reattach-never-idle', last_idle_at: null },
      { id: 'reattach-with-stored-idle', last_idle_at: storedIdleAt },
    ],
  );

  for (const sessionId of states.keys()) {
    killSession(sessionId, { killTmux() {}, isTmuxAlive: () => false });
  }
});

it('restores provider activity credentials when reattaching a session', () => {
  initDb(':memory:');
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, name, pid, provider, status, started_at)
       VALUES ('reattach-native', 'Codex', 11, 'codex', 'active', ?)`,
    )
    .run(now);
  buildSessionLaunch({
    provider: 'codex',
    sessionId: 'reattach-native',
    cwd: process.cwd(),
    port: 4242,
    patrolPrompt: 'unused',
    mcpTimeoutMs: PATROL_MCP_TIMEOUT_MS,
    enablePatrolMcp: false,
    activityToken: 'reattach-native-token',
  });
  let exitHandler = null;
  const runtime = {
    isTmuxAlive: () => true,
    execFileSync() {},
    spawnPty() {
      return {
        pid: 12,
        onData() {},
        onExit(handler) {
          exitHandler = handler;
        },
        kill() {
          exitHandler?.({ exitCode: 0 });
        },
        write() {},
        resize() {},
      };
    },
  };

  assert.equal(reattachOrphanedSessions(runtime), 1);
  assert.deepEqual(
    recordProviderActivity('reattach-native', 'codex', 'reattach-native-token', {
      event: 'turn_completed',
      run_id: 'turn-1',
    }),
    { accepted: true, duplicate: false, status: 202 },
  );
  killSession('reattach-native', { killTmux() {}, isTmuxAlive: () => false });
  assert.equal(readActivityCredential('reattach-native'), null);
});

it('keeps a live tmux session recoverable when update reattach fails', () => {
  initDb(':memory:');
  getDb()
    .prepare(
      `INSERT INTO sessions (id, name, pid, provider, status, started_at)
       VALUES ('global-live', 'Still running', 11, 'claude', 'active', ?)`,
    )
    .run(new Date().toISOString());

  const reattached = reattachOrphanedSessions({
    isTmuxAlive: () => true,
    execFileSync() {},
    spawnPty() {
      throw new Error('temporary PTY failure');
    },
  });

  assert.equal(reattached, 0);
  assert.deepEqual(
    { ...getDb().prepare("SELECT name, status, ended_at FROM sessions WHERE id = 'global-live'").get() },
    { name: 'Still running', status: 'detached', ended_at: null },
  );
});

it('marks a session killed when tmux exits during reattach', () => {
  initDb(':memory:');
  getDb()
    .prepare(
      `INSERT INTO sessions (id, name, pid, provider, status, started_at)
       VALUES ('global-dying', 'Dying', 11, 'claude', 'active', ?)`,
    )
    .run(new Date().toISOString());
  let livenessChecks = 0;

  const reattached = reattachOrphanedSessions({
    isTmuxAlive: () => livenessChecks++ === 0,
    execFileSync() {},
    spawnPty() {
      throw new Error('tmux exited');
    },
  });

  assert.equal(reattached, 0);
  const row = getDb().prepare("SELECT status, ended_at FROM sessions WHERE id = 'global-dying'").get();
  assert.equal(row.status, 'killed');
  assert.ok(row.ended_at);
});

it('does not close a detached session row when tmux remains alive after a failed kill', async () => {
  initDb(':memory:');
  let localChanges = 0;
  const onLocalChange = () => {
    localChanges += 1;
  };
  appEvents.on('local-change', onLocalChange);
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, pid, provider, status, started_at)
       VALUES ('detached-session', 123, 'claude', 'detached', ?)`,
    )
    .run(now);

  try {
    await assert.rejects(
      killSessionAndWait('detached-session', 5, {
        killTmux: () => {
          throw new Error('injected tmux failure');
        },
        isTmuxAlive: () => true,
      }),
      (error) => error.code === 'session_stop_timeout',
    );
    assert.equal(
      getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('detached-session').status,
      'detached',
    );
    assert.equal(localChanges, 0);

    await killSessionAndWait('detached-session', 5, {
      killTmux: () => {
        throw new Error('tmux already gone');
      },
      isTmuxAlive: () => false,
    });
    assert.equal(getDb().prepare('SELECT status FROM sessions WHERE id = ?').get('detached-session').status, 'killed');
    assert.equal(localChanges, 1);
  } finally {
    appEvents.off('local-change', onLocalChange);
  }
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

  it('routes resize to PTY resize', () => {
    const entry = makeEntry();
    const result = dispatchWsMessage(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }), entry, ctx);
    assert.deepEqual(result, { type: 'resize' });
    assert.deepEqual(entry.resizes, [[120, 40]]);
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
