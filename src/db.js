import { constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA_VERSION, migrateDb } from './migrations.js';

/** @type {DatabaseSync | null} */
let db = null;

/**
 * Initialize and migrate the database.
 * @param {string} dbPath absolute path (already expanded by config loader)
 */
export function initDb(dbPath) {
  closeDb();
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const hadDatabase = dbPath !== ':memory:' && existsSync(dbPath);
  const nextDb = new DatabaseSync(dbPath);
  try {
    nextDb.exec('PRAGMA journal_mode = WAL');
    nextDb.exec('PRAGMA foreign_keys = ON');
    if (hadDatabase) {
      const version = Number(nextDb.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version < CURRENT_SCHEMA_VERSION) {
        nextDb.exec('PRAGMA wal_checkpoint(FULL)');
        const backupPath = `${dbPath}.backup-v${version}-to-v${CURRENT_SCHEMA_VERSION}`;
        try {
          copyFileSync(dbPath, backupPath, constants.COPYFILE_EXCL);
          console.log(`[db] Pre-migration backup written to ${backupPath}`);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      }
    }
    migrateDb(nextDb);
    const violations = nextDb.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(`foreign key validation failed (${violations.length} violation(s))`);
    }
    db = nextDb;
    return db;
  } catch (error) {
    nextDb.close();
    throw error;
  }
}

/** Close the active database. Primarily used by graceful shutdown and tests. */
export function closeDb() {
  if (!db) return;
  db.close();
  db = null;
}

/**
 * Run `fn` inside a transaction and commit, or roll back and rethrow. Uses
 * BEGIN IMMEDIATE so a writer takes the lock up front instead of failing on
 * its first write.
 * @template T
 * @param {import('node:sqlite').DatabaseSync} database
 * @param {() => T} fn
 * @returns {T}
 */
export function withTransaction(database, fn) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** Get the active database instance. */
export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
