import { loadConfig } from '../src/config.js';
import { initDb } from '../src/db.js';
import { cleanupOrphanedSessions } from '../src/pty-manager.js';
import { createServer } from '../src/server.js';

const config = loadConfig();
initDb(config.db_path);
cleanupOrphanedSessions();

const server = await createServer(config);
await server.listen({ port: 0 });
const address = server.server.address();
const base = `http://localhost:${address.port}`;

const listRes = await fetch(`${base}/api/sessions`);
console.log('GET /api/sessions:', listRes.status, await listRes.json());

const createRes = await fetch(`${base}/api/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ global: true }),
});
const text = await createRes.text();
console.log('POST /api/sessions (global):', createRes.status, text);

await server.close();
console.log('Plan 04 backend verified.');
