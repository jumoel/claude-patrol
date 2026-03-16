import { execFile as execFileCb } from 'node:child_process';
import { emitLocalChange } from './app-events.js';
import {
  configEvents,
  ensureConfig,
  isConfigured,
  loadConfig,
  setCurrentConfig,
  unwatchConfig,
  watchConfig,
} from './config.js';
import { initDb } from './db.js';
import { startHealthChecks, stopHealthChecks } from './health.js';
import { isRunning, removePid, writePid } from './pid.js';
import { resetStatements, startPoller, stopPoller } from './poller.js';
import {
  activeSessionCount,
  cleanupOrphanedSessions,
  cleanupOrphanedTmuxSessions,
  initMcpConfig,
  killAllSessions,
  reattachOrphanedSessions,
  updateMcpConfig,
} from './pty-manager.js';
import { createServer } from './server.js';
import { validateStartup } from './startup.js';
import { destroyTui, initTui, setHeader } from './tui.js';
import { startUpdateChecks, stopUpdateChecks } from './update-check.js';

/**
 * Start the claude-patrol server.
 * @param {{ open?: boolean, noOpen?: boolean }} [options]
 */
export async function startServer(options = {}) {
  // --port <number> overrides config.port and skips the single-instance check
  const portFlagIdx = process.argv.indexOf('--port');
  const portOverride = portFlagIdx !== -1 ? Number(process.argv[portFlagIdx + 1]) : null;

  const isReattachEarly = options.reattach || process.argv.includes('--reattach');
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

  try {
    await validateStartup();
  } catch (err) {
    console.error(`[claude-patrol] ${err.message}`);
    process.exit(1);
  }

  const config = loadConfig();
  setCurrentConfig(config);
  initDb(config.db_path);

  const isClean = options.clean || process.argv.includes('--clean');
  if (isClean) {
    cleanupOrphanedSessions();
    cleanupOrphanedTmuxSessions();
    console.log('[claude-patrol] Cleaned up all orphaned sessions');
  } else {
    // Default: reattach surviving tmux sessions, kill dead ones.
    const count = reattachOrphanedSessions();
    if (count > 0) console.log(`[claude-patrol] Reattached ${count} surviving session(s)`);
  }

  let pollerRunning = false;
  if (isConfigured(config)) {
    startPoller(config);
    pollerRunning = true;
  } else {
    console.log('[claude-patrol] No poll targets configured - skipping poller (setup mode)');
  }
  startHealthChecks();
  startUpdateChecks();

  const server = await createServer();
  let port = portOverride || config.port;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await server.listen({ port, host: '0.0.0.0' });
      break;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[claude-patrol] Port ${port} in use, trying ${port + 1}`);
        port++;
      } else {
        throw err;
      }
    }
  }

  // Write MCP config after server binds so it uses the actual port
  initMcpConfig({ ...config, port });

  // Write PID file with actual port
  writePid(port);

  const serverUrl = `http://localhost:${port}`;

  // Start TUI if running in an interactive terminal
  const isTTY = process.stdin.isTTY && process.stdout.isTTY;
  if (isTTY) {
    const pollTargets = [...config.poll.orgs.map((o) => `org:${o}`), ...config.poll.repos.map((r) => `repo:${r}`)].join(
      ', ',
    );
    const headerMsg = pollTargets
      ? `${serverUrl}  |  polling ${pollTargets} every ${config.poll.interval_seconds}s`
      : `${serverUrl}  |  setup mode - open browser to configure`;
    initTui({
      header: headerMsg,
      footer: '[space] open browser  [ctrl-c] quit',
    });
  }

  if (isReattachEarly) {
    console.log(`[claude-patrol] Restarted successfully on ${serverUrl}`);
  } else {
    console.log(`Server listening on ${serverUrl}`);
  }

  // Only open browser when explicitly requested via --open
  const shouldOpen = !options.noOpen && (options.open || process.argv.includes('--open'));
  if (shouldOpen) {
    execFileCb('open', [serverUrl], (err) => {
      if (err) console.warn(`Could not open browser: ${err.message}`);
    });
  }

  configEvents.on('change', (newConfig) => {
    setCurrentConfig(newConfig);
    resetStatements();
    if (isConfigured(newConfig)) {
      console.log(`Config changed, ${pollerRunning ? 'restarting' : 'starting'} poller`);
      startPoller(newConfig);
      pollerRunning = true;
    } else {
      console.log('Config changed but no poll targets yet');
    }
    updateMcpConfig(newConfig);
    emitLocalChange();
    // Update header with new config
    if (isTTY) {
      const targets = [
        ...newConfig.poll.orgs.map((o) => `org:${o}`),
        ...newConfig.poll.repos.map((r) => `repo:${r}`),
      ].join(', ');
      setHeader(`${serverUrl}  |  polling ${targets} every ${newConfig.poll.interval_seconds}s`);
    }
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
  let shutdownState = 'running'; // running | prompting | exiting

  async function doExit(killSessions) {
    shutdownState = 'exiting';
    destroyTui();
    unwatchConfig();
    stopPoller();
    stopHealthChecks();
    stopUpdateChecks();
    if (killSessions) {
      console.log('Killing all sessions...');
      killAllSessions();
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
    console.log('Shutdown complete.');
    process.exit(0);
  }

  function shutdown(signal) {
    const count = activeSessionCount();

    if (shutdownState === 'exiting') {
      process.exit(1);
    }

    if (shutdownState === 'prompting') {
      // Second signal while prompting - exit preserving sessions
      doExit(false);
      return;
    }

    if (count === 0 || isClean || signal === 'SIGTERM') {
      // No sessions, --clean mode, or SIGTERM: exit immediately
      doExit(isClean);
      return;
    }

    // Interactive prompt: active sessions exist
    shutdownState = 'prompting';
    destroyTui();
    console.log(`\n${count} active session(s) running.`);
    console.log('  [k] Kill sessions and exit');
    console.log('  [Enter/p] Preserve sessions and exit (reattach on next start)');
    console.log('  [Ctrl-C] Preserve and exit immediately');

    const onKey = (key) => {
      process.stdin.removeListener('data', onKey);
      if (key === 'k' || key === 'K') {
        doExit(true);
      } else {
        doExit(false);
      }
    };
    process.stdin.on('data', onKey);
  }

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
        execFileCb('open', [serverUrl], (err) => {
          if (err) console.warn(`Could not open browser: ${err.message}`);
        });
      }
    });
  }
}

// Direct execution guard: `node src/index.js` still works
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/src/index.js')) {
  startServer();
}
