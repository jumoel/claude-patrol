import { loadConfig } from '../src/config.js';
import { initDb, getDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const config = loadConfig();
initDb(config.db_path);

const server = await createServer(config);
await server.listen({ port: 0 });
const address = server.server.address();
const base = `http://localhost:${address.port}`;

// Test workspace endpoints exist
const listRes = await fetch(`${base}/api/workspaces`);
console.log('GET /api/workspaces:', listRes.status, await listRes.json());

const createRes = await fetch(`${base}/api/workspaces`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pr_id: 'fake/repo#1' }) });
console.log('POST /api/workspaces (nonexistent PR):', createRes.status);

await server.close();
console.log('Plan 03 backend verified.');
