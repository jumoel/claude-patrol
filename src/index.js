import { loadConfig, watchConfig, configEvents, setCurrentConfig } from './config.js';
import { initDb } from './db.js';
import { startPoller, resetStatements } from './poller.js';
import { createServer } from './server.js';
import { cleanupOrphanedSessions, initMcpConfig, updateMcpConfig } from './pty-manager.js';
import { validateStartup } from './startup.js';
import { startHealthChecks } from './health.js';

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
initMcpConfig(config);

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
console.log(`[claude-patrol] Server listening on http://localhost:${port}`);

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
