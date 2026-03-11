import { execFile as execFileCb } from 'node:child_process';
import { loadConfig, ensureConfig, watchConfig, unwatchConfig, configEvents, setCurrentConfig } from './config.js';
import { configPath } from './paths.js';
import { initDb } from './db.js';
import { startPoller, stopPoller, resetStatements } from './poller.js';
import { createServer } from './server.js';
import { cleanupOrphanedSessions, cleanupOrphanedTmuxSessions, initMcpConfig, updateMcpConfig, killAllSessions } from './pty-manager.js';
import { validateStartup } from './startup.js';
import { startHealthChecks, stopHealthChecks } from './health.js';
import { writePid, removePid, isRunning } from './pid.js';
import { initTui, destroyTui, setHeader } from './tui.js';

/**
 * Start the claude-patrol server.
 * @param {{ open?: boolean, noOpen?: boolean }} [options]
 */
export async function startServer(options = {}) {
  const status = isRunning();
  if (status.running) {
    console.error(`[claude-patrol] Already running (pid ${status.pid}, port ${status.port}). Use "claude-patrol stop" to stop it.`);
    process.exit(1);
  }

  if (!ensureConfig()) {
    console.log(`[claude-patrol] Created starter config at ${configPath()}`);
    console.log('[claude-patrol] Edit it to add your poll targets, then run again.');
    process.exit(0);
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
  cleanupOrphanedSessions();
  cleanupOrphanedTmuxSessions();

  startPoller(config);
  startHealthChecks();

  const server = await createServer();
  let port = config.port;
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
    const pollTargets = [
      ...config.poll.orgs.map(o => `org:${o}`),
      ...config.poll.repos.map(r => `repo:${r}`),
    ].join(', ');
    initTui({
      header: `${serverUrl}  |  polling ${pollTargets} every ${config.poll.interval_seconds}s`,
      footer: '[space] open browser  [ctrl-c] quit',
    });
  }

  console.log(`Server listening on ${serverUrl}`);

  // Only open browser when explicitly requested via --open
  const shouldOpen = !options.noOpen && (options.open || process.argv.includes('--open'));
  if (shouldOpen) {
    execFileCb('open', [serverUrl], (err) => {
      if (err) console.warn(`Could not open browser: ${err.message}`);
    });
  }

  configEvents.on('change', (newConfig) => {
    console.log('Config changed, restarting poller');
    setCurrentConfig(newConfig);
    resetStatements();
    startPoller(newConfig);
    updateMcpConfig(newConfig);
    // Update header with new config
    if (isTTY) {
      const targets = [
        ...newConfig.poll.orgs.map(o => `org:${o}`),
        ...newConfig.poll.repos.map(r => `repo:${r}`),
      ].join(', ');
      setHeader(`${serverUrl}  |  polling ${targets} every ${newConfig.poll.interval_seconds}s`);
    }
  });

  watchConfig();

  console.log('Running');

  // Graceful shutdown
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) {
      process.exit(1);
    }
    shuttingDown = true;
    destroyTui();
    console.log(`Received ${signal}, shutting down...`);
    unwatchConfig();
    stopPoller();
    stopHealthChecks();
    killAllSessions();
    removePid();
    server.closeSSE();
    try { await server.close(); } catch { /* ignore close errors */ }
    console.log('Shutdown complete.');
    process.exit(0);
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
