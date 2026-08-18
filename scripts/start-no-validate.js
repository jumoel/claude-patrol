import { configEvents, isConfigured, loadConfig, setCurrentConfig, watchConfig } from '../src/config.js';
import { initDb } from '../src/db.js';
import { resetStatements, startPoller, stopPoller } from '../src/poller.js';
import { createServer } from '../src/server.js';
import { cleanupOrphanedSessions } from '../src/pty-manager.js';
import { startHealthChecks } from '../src/health.js';
import { startRulesEngine } from '../src/rules.js';

const config = loadConfig();
setCurrentConfig(config);
initDb(config.db_path);
cleanupOrphanedSessions();
if (isConfigured(config)) startPoller(config);
startHealthChecks();

const server = await createServer({ config });
startRulesEngine(server, config);
await server.listen({ port: config.port, host: config.host });
console.log(`Server listening on http://localhost:${config.port}`);

configEvents.on('change', (newConfig) => {
  setCurrentConfig(newConfig);
  resetStatements();
  if (isConfigured(newConfig)) startPoller(newConfig);
  else stopPoller();
  if (server.updateSyncConfig) server.updateSyncConfig(newConfig);
  if (server.updateConfig) server.updateConfig(newConfig);
  if (server.updateWorkspaceConfig) server.updateWorkspaceConfig(newConfig);
});

watchConfig();
