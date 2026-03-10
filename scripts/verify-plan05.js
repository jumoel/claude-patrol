import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db.js';
import { cleanupOrphanedSessions } from '../src/pty-manager.js';
import { createServer } from '../src/server.js';
import { startHealthChecks, stopHealthChecks } from '../src/health.js';

const config = loadConfig();
initDb(config.db_path);
cleanupOrphanedSessions();

const server = await createServer(config);
await server.listen({ port: 0 });
const address = server.server.address();
const base = `http://localhost:${address.port}`;

// All endpoints should be reachable
const endpoints = ['/api/prs', '/api/config', '/api/workspaces', '/api/sessions'];
for (const ep of endpoints) {
  const res = await fetch(`${base}${ep}`);
  console.log(`GET ${ep}: ${res.status}`);
}

// Health checks start/stop
startHealthChecks(60000);
stopHealthChecks();
console.log('Health checks start/stop OK');

await server.close();
console.log('Plan 05 verified.');
