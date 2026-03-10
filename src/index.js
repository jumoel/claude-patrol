import { execFile as execFileCb } from 'node:child_process';
import { loadConfig, watchConfig, unwatchConfig, configEvents, setCurrentConfig } from './config.js';
import { initDb } from './db.js';
import { startPoller, stopPoller, resetStatements } from './poller.js';
import { createServer } from './server.js';
import { cleanupOrphanedSessions, cleanupOrphanedTmuxSessions, initMcpConfig, updateMcpConfig, killAllSessions } from './pty-manager.js';
import { validateStartup } from './startup.js';
import { startHealthChecks, stopHealthChecks } from './health.js';

console.log('[claude-patrol] Starting up...');

// Validate required tools are available
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

// Write MCP config after server binds so it uses the actual port (which may
// differ from config.port if the original port was already in use).
initMcpConfig({ ...config, port });

const serverUrl = `http://localhost:${port}`;
console.log(`[claude-patrol] Server listening on ${serverUrl}`);

// Open browser unless NODE_ENV=test or --no-open flag is passed
if (process.env.NODE_ENV !== 'test' && !process.argv.includes('--no-open')) {
  execFileCb('open', [serverUrl], (err) => {
    if (err) console.warn(`[claude-patrol] Could not open browser: ${err.message}`);
  });
}

configEvents.on('change', (newConfig) => {
  console.log('[claude-patrol] Config changed, restarting poller');
  setCurrentConfig(newConfig);
  resetStatements();
  startPoller(newConfig);
  updateMcpConfig(newConfig);
});

watchConfig();

const pollTargets = [
  ...config.poll.orgs.map(o => `org:${o}`),
  ...config.poll.repos.map(r => `repo:${r}`),
].join(', ');
console.log(`[claude-patrol] Running. Polling ${pollTargets} every ${config.poll.interval_seconds}s`);

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) {
    console.log('[claude-patrol] Forced exit.');
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`\n[claude-patrol] Received ${signal}, shutting down...`);
  unwatchConfig();
  stopPoller();
  stopHealthChecks();
  killAllSessions();
  // server.close() waits for open connections (SSE, WebSocket) to drain,
  // which can hang indefinitely. Race it against a hard timeout.
  const forceExit = setTimeout(() => {
    console.log('[claude-patrol] Shutdown timed out, forcing exit.');
    process.exit(0);
  }, 3000);
  forceExit.unref();
  try { await server.close(); } catch { /* ignore close errors */ }
  console.log('[claude-patrol] Shutdown complete.');
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
