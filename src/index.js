import { loadConfig, watchConfig, configEvents } from './config.js';
import { initDb } from './db.js';
import { startPoller, resetStatements } from './poller.js';
import { createServer } from './server.js';
import { cleanupOrphanedSessions } from './pty-manager.js';
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
initDb(config.db_path);
cleanupOrphanedSessions();

startPoller(config);
startHealthChecks();

const server = await createServer(config);
await server.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[claude-patrol] Server listening on http://localhost:${config.port}`);

configEvents.on('change', (newConfig) => {
  console.log('[claude-patrol] Config changed, restarting poller');
  resetStatements();
  startPoller(newConfig);
  if (server.updateSyncConfig) server.updateSyncConfig(newConfig);
  if (server.updateConfig) server.updateConfig(newConfig);
  if (server.updateWorkspaceConfig) server.updateWorkspaceConfig(newConfig);
});

watchConfig();

console.log(`[claude-patrol] Running. Polling ${config.orgs.join(', ')} every ${config.poll_interval_seconds}s`);
