import { loadConfig, watchConfig, configEvents } from './config.js';
import { initDb } from './db.js';
import { startPoller, resetStatements } from './poller.js';

console.log('[claude-patrol] Starting up...');

const config = loadConfig();
initDb(config.db_path);

startPoller(config);

configEvents.on('change', (newConfig) => {
  console.log('[claude-patrol] Config changed, restarting poller');
  resetStatements();
  startPoller(newConfig);
});

watchConfig();

console.log(`[claude-patrol] Running. Polling ${config.orgs.join(', ')} every ${config.poll_interval_seconds}s`);
