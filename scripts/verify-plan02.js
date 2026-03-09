import { loadConfig } from '../src/config.js';
import { initDb, getDb } from '../src/db.js';
import { createServer } from '../src/server.js';

const config = loadConfig();
initDb(config.db_path);

const server = await createServer(config);
await server.listen({ port: 0 }); // random port
const address = server.server.address();
console.log(`Server started on port ${address.port}`);

// Test endpoints
const base = `http://localhost:${address.port}`;

const prsRes = await fetch(`${base}/api/prs`);
const prsData = await prsRes.json();
console.log('GET /api/prs:', prsRes.status, `(${prsData.prs.length} PRs)`);

const configRes = await fetch(`${base}/api/config`);
const configData = await configRes.json();
console.log('GET /api/config:', configRes.status, configData);

await server.close();
console.log('Plan 02 backend verified.');
