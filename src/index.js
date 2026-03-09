import { loadConfig, watchConfig, configEvents } from './config.js';
import { initDb } from './db.js';
import { startPoller, resetStatements } from './poller.js';
import { createServer } from './server.js';

console.log('[claude-patrol] Starting up...');

const config = loadConfig();
initDb(config.db_path);

startPoller(config);

const server = await createServer(config);
await server.listen({ port: config.port, host: '0.0.0.0' });
console.log(`[claude-patrol] Server listening on http://localhost:${config.port}`);

configEvents.on('change', (newConfig) => {
  console.log('[claude-patrol] Config changed, restarting poller');
  resetStatements();
  startPoller(newConfig);
  if (server.updateSyncConfig) server.updateSyncConfig(newConfig);
  if (server.updateConfig) server.updateConfig(newConfig);
});

watchConfig();

console.log(`[claude-patrol] Running. Polling ${config.orgs.join(', ')} every ${config.poll_interval_seconds}s`);
