import { loadConfig } from '../src/config.js';
import { initDb, getDb } from '../src/db.js';

const config = loadConfig();
console.log('Config loaded OK');
console.log('  db_path expanded:', config.db_path);
console.log('  workspace_base_path expanded:', config.workspace_base_path);

const db = initDb(config.db_path);
console.log('DB initialized');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t => t.name));

// Verify CHECK constraints work
try {
  db.prepare("INSERT INTO sessions (id, status, started_at) VALUES ('test', 'bogus', '2024-01-01')").run();
  console.error('FAIL: CHECK constraint did not reject invalid status');
} catch (err) {
  console.log('CHECK constraint works:', err.message.includes('CHECK') ? 'yes' : err.message);
}

// Clean up test row if it got in
db.prepare("DELETE FROM sessions WHERE id = 'test'").run();

console.log('Plan 01 verified.');
