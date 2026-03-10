import { loadConfig, watchConfig, configEvents } from '../src/config.js';
import { initDb } from '../src/db.js';
import { startPoller, resetStatements } from '../src/poller.js';
import { createServer } from '../src/server.js';
import { cleanupOrphanedSessions } from '../src/pty-manager.js';
import { startHealthChecks } from '../src/health.js';

const config = loadConfig();
initDb(config.db_path);
cleanupOrphanedSessions();
startPoller(config);
startHealthChecks();

const server = await createServer(config);
await server.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Server listening on http://localhost:${config.port}`);

configEvents.on('change', (newConfig) => {
  resetStatements();
  startPoller(newConfig);
  if (server.updateSyncConfig) server.updateSyncConfig(newConfig);
  if (server.updateConfig) server.updateConfig(newConfig);
  if (server.updateWorkspaceConfig) server.updateWorkspaceConfig(newConfig);
});

watchConfig();
