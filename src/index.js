import { execFile as execFileCb } from 'node:child_process';
import { emitLocalChange } from './app-events.js';
import { parseCliOptions } from './cli-args.js';
import {
  configEvents,
  ensureConfig,
  getCurrentConfig,
  isPollConfigured,
  loadConfig,
  setCurrentConfig,
  unwatchConfig,
  watchConfig,
} from './config.js';
import { closeDb, initDb } from './db.js';
import { startHealthChecks, stopHealthChecks } from './health.js';
import { isRunning, readPid, removePid, writePid } from './pid.js';
import { reconcilePollTargets, startPoller, stopPoller } from './poller.js';
import {
  activeSessionCount,
  cleanupOrphanedSessions,
  cleanupOrphanedTmuxSessions,
  killAllSessionsAndWait,
  pollSessionStatuses,
  reattachOrphanedSessions,
  setMcpPort,
  startSessionStatusPolling,
  stopSessionStatusPolling,
} from './pty-manager.js';
import { startRulesEngine, stopRulesEngine } from './rules.js';
import { createServer } from './server.js';
import { createShutdownController } from './shutdown.js';
import { validateStartup } from './startup.js';
import { destroyTui, initTui, setHeader } from './tui.js';
import { startUpdateChecks, stopUpdateChecks } from './update-check.js';
import { recoverInterruptedWorkItems } from './work-items.js';
import { inspectWorkspaceState, pruneStaleComposeStacks, recoverInterruptedWorkspaceOperations } from './workspace.js';
import { reconcilePatrolWorkspacesOnStartup } from './workspace-reconciliation.js';
import { startWorkspaceReconciliationScheduler } from './workspace-reconciliation-scheduler.js';

/**
 * One line describing what the server is doing, for the TUI header.
 * @param {string} serverUrl
 * @param {{ poll: { orgs: string[], repos: string[], interval_seconds: number }, work_items?: unknown }} config
 */
function statusHeader(serverUrl, config) {
  const targets = [...config.poll.orgs.map((o) => `org:${o}`), ...config.poll.repos.map((r) => `repo:${r}`)].join(', ');
  if (targets) return `${serverUrl}  |  polling ${targets} every ${config.poll.interval_seconds}s`;
  if (config.work_items) return `${serverUrl}  |  work items enabled`;
  return `${serverUrl}  |  setup mode - open browser to configure`;
}

/** Open the dashboard in the default browser; failures are only logged. */
function openBrowser(serverUrl) {
  execFileCb('open', [serverUrl], (err) => {
    if (err) console.warn(`Could not open browser: ${err.message}`);
  });
}

/**
 * Start the claude-patrol server.
 * @param {{ open?: boolean, noOpen?: boolean, reattach?: boolean, clean?: boolean }} [options]
 */
export async function startServer(options = {}) {
  const cli = parseCliOptions(process.argv.slice(2), options);
  // --port <number> overrides config.port and skips the single-instance check
  let portOverride = cli.port;
  const hostOverride = cli.host;

  const isReattachEarly = cli.reattach;
  // On a restart-style relaunch (--reattach) without an explicit --port, pin
  // to the previous instance's port so MCP URLs in already-running Claude
  // sessions stay valid.
  if (isReattachEarly && portOverride === null) {
    const previousPort = readPid()?.port;
    if (typeof previousPort === 'number') portOverride = previousPort;
  }
  if (!isReattachEarly && !portOverride) {
    const status = isRunning();
    if (status.running) {
      console.error(
        `[claude-patrol] Already running (pid ${status.pid}, port ${status.port}). Use "claude-patrol stop" to stop it.`,
      );
      process.exit(78); // EX_CONFIG (sysexits.h) - not a crash, just a precondition failure
    }
  }

  if (!ensureConfig()) {
    console.log(`[claude-patrol] First run - starting in setup mode.`);
  }

  console.log('[claude-patrol] Starting up...');

  const config = loadConfig();
  try {
    await validateStartup(config);
  } catch (err) {
    console.error(`[claude-patrol] ${err.message}`);
    process.exit(1);
  }
  setCurrentConfig(config);
  initDb(config.db_path);

  const interruptedWorkspaces = recoverInterruptedWorkspaceOperations();
  if (interruptedWorkspaces.length > 0) {
    console.warn(`[claude-patrol] Recovered ${interruptedWorkspaces.length} interrupted workspace operation(s)`);
  }
  const workspaceIssues = inspectWorkspaceState();
  if (workspaceIssues.length > 0) {
    console.warn(
      `[claude-patrol] ${workspaceIssues.length} workspace operation(s) need reconciliation; inspect GET /api/workspaces/operations`,
    );
  }

  const isClean = cli.clean;
  if (isClean) {
    cleanupOrphanedSessions();
    cleanupOrphanedTmuxSessions();
    console.log('[claude-patrol] Cleaned up all orphaned sessions');
  } else {
    // Default: reattach surviving tmux sessions, kill dead ones.
    const count = reattachOrphanedSessions();
    if (count > 0) console.log(`[claude-patrol] Reattached ${count} surviving session(s)`);
    await pollSessionStatuses();
    startSessionStatusPolling();
  }
  const interruptedWorkItems = recoverInterruptedWorkItems();
  if (interruptedWorkItems.length > 0) {
    console.warn(`[claude-patrol] Recovered ${interruptedWorkItems.length} interrupted work-item operation(s)`);
  }

  // Tear down compose stacks orphaned by past workspace destroys. Runs in the
  // background so a slow docker daemon doesn't delay startup.
  pruneStaleComposeStacks(config.workspace_base_path)
    .then(({ torn, warnings }) => {
      if (torn.length > 0) {
        console.log(`[claude-patrol] Pruned ${torn.length} stale compose stack(s): ${torn.join(', ')}`);
      }
      for (const w of warnings) console.warn(`[claude-patrol] ${w}`);
    })
    .catch((err) => console.warn(`[claude-patrol] Stale compose prune failed: ${err.message}`));

  let pollerRunning = false;
  if (isPollConfigured(config)) {
    startPoller(config);
    pollerRunning = true;
  } else {
    console.log(
      config.work_items
        ? '[claude-patrol] No poll targets configured - work-item mode remains available'
        : '[claude-patrol] No poll targets configured - skipping poller (setup mode)',
    );
  }
  startHealthChecks();
  startUpdateChecks();

  const host = hostOverride || config.host;
  const server = await createServer({ config: { ...config, host } });

  // Wire the rules engine (after createServer so app.inject is available;
  // before listen so trigger handlers attach before any pr-changed fires).
  startRulesEngine(server, config);

  let port = portOverride || config.port;
  // When an explicit --port is given (e.g. on restart), the caller wants
  // exactly that port - bumping would invalidate MCP URLs in already-running
  // agent sessions. Retry the same port through the overlap window with the
  // dying old process, then bail out. Without --port, fall back to bumping.
  const stickyPort = portOverride !== null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await server.listen({ port, host });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      if (stickyPort) {
        if (attempt === 9) throw err;
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      console.warn(`[claude-patrol] Port ${port} in use, trying ${port + 1}`);
      port++;
    }
  }

  // Write MCP config after server binds so it uses the actual port
  setMcpPort(port);

  // Write PID file with actual port
  writePid(port);

  const serverUrl = `http://localhost:${port}`;

  try {
    const reconciliation = await reconcilePatrolWorkspacesOnStartup(config, {
      isPatrolAvailable: () => server.server.listening,
    });
    if (reconciliation.deleted.length > 0) {
      console.log(`[claude-patrol] Removed ${reconciliation.deleted.length} orphaned Patrol workspace(s)`);
    }
    if (reconciliation.cleanedWorkspaces.length > 0) {
      console.log(
        `[claude-patrol] Completed cleanup for ${reconciliation.cleanedWorkspaces.length} stale workspace operation(s)`,
      );
    }
    for (const warning of reconciliation.warnings) {
      console.warn(`[claude-patrol] Workspace reconciliation warning: ${warning}`);
    }
    for (const candidate of reconciliation.blocked) {
      console.warn(`[claude-patrol] Kept stale workspace ${candidate.path}: ${candidate.reason}`);
    }
  } catch (error) {
    console.warn(`[claude-patrol] Workspace reconciliation failed: ${error.message}`);
  }
  const workspaceReconciliationScheduler = startWorkspaceReconciliationScheduler({
    getConfig: getCurrentConfig,
    isPatrolAvailable: () => server.server.listening,
  });

  // Start TUI if running in an interactive terminal
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isTTY) {
    initTui({
      header: statusHeader(serverUrl, config),
      footer: '[space] open browser  [ctrl-c] quit',
    });
  }

  if (isReattachEarly) {
    console.log(`[claude-patrol] Restarted successfully on ${serverUrl}`);
  } else {
    console.log(`Server listening on ${serverUrl}`);
  }

  // Only open browser when explicitly requested via --open
  if (!cli.noOpen && cli.open) openBrowser(serverUrl);

  configEvents.on('change', (newConfig) => {
    setCurrentConfig(newConfig);
    if (isPollConfigured(newConfig)) {
      console.log(`Config changed, ${pollerRunning ? 'restarting' : 'starting'} poller`);
      startPoller(newConfig);
      pollerRunning = true;
    } else {
      console.log('Config changed but no poll targets yet');
      stopPoller();
      pollerRunning = false;
      reconcilePollTargets(newConfig).catch((error) =>
        console.error(`[poller] Target reconciliation failed: ${error.message}`),
      );
    }
    emitLocalChange();
    if (isTTY) setHeader(statusHeader(serverUrl, newConfig));
  });

  watchConfig();

  // Listen for IPC messages from watch.js (vite output, watch status)
  if (process.send) {
    process.on('message', (msg) => {
      if (msg?.type === 'log') {
        const level = msg.level || 'log';
        if (level === 'error') console.error(msg.msg);
        else if (level === 'warn') console.warn(msg.msg);
        else console.log(msg.msg);
      }
    });
  }

  console.log('Running');

  // Graceful shutdown
  async function doExit(killSessions) {
    destroyTui();
    unwatchConfig();
    await stopPoller({ drain: true });
    await stopRulesEngine({ drain: true });
    stopHealthChecks();
    stopUpdateChecks();
    await stopSessionStatusPolling();
    workspaceReconciliationScheduler.stop();
    if (killSessions) {
      console.log('Killing all sessions...');
      const { closed, failed } = await killAllSessionsAndWait();
      if (failed.length > 0) {
        console.warn(`Closed ${closed} session(s); ${failed.length} did not confirm within the timeout.`);
      }
    } else {
      const n = activeSessionCount();
      if (n > 0) console.log(`Leaving ${n} session(s) running - will reattach on next start.`);
    }
    removePid();
    server.closeSSE();
    try {
      await server.close();
    } catch {
      /* ignore close errors */
    }
    closeDb();
    console.log('Shutdown complete.');
    process.exit(0);
  }

  const shutdownController = createShutdownController({
    activeSessionCount,
    exit: doExit,
    forceExit: () => process.exit(1),
    isClean,
    isTTY,
    stdin: process.stdin,
    destroyTui,
    log: (line) => console.log(line),
  });
  const shutdown = (signal) => shutdownController.shutdown(signal);

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Listen for keyboard input in interactive mode
  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key) => {
      if (key === '\x03') {
        shutdown('SIGINT');
        return;
      }
      if (key === ' ') {
        console.log(`Opening ${serverUrl}...`);
        openBrowser(serverUrl);
      }
    });
  }
}

// Direct execution guard: `node src/index.js` still works
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/src/index.js')) {
  startServer();
}
