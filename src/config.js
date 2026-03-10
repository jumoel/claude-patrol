import { readFileSync, watchFile, unwatchFile } from 'node:fs';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { expandPath } from './utils.js';

const CONFIG_PATH = resolve(import.meta.dirname, '..', 'config.json');

const PATH_FIELDS = ['db_path', 'workspace_base_path', 'work_dir', 'global_terminal_cwd'];

const REQUIRED_FIELDS = {
  orgs: (v) => Array.isArray(v) && v.length > 0,
  poll_interval_seconds: (v) => typeof v === 'number' && v >= 5,
  db_path: (v) => typeof v === 'string',
  port: (v) => typeof v === 'number',
  workspace_base_path: (v) => typeof v === 'string',
  work_dir: (v) => typeof v === 'string',
};

/**
 * Validate config object. Throws on invalid.
 * @param {Record<string, unknown>} cfg
 */
function validate(cfg) {
  for (const [field, predicate] of Object.entries(REQUIRED_FIELDS)) {
    if (!(field in cfg)) {
      throw new Error(`Missing required config field: ${field}`);
    }
    if (!predicate(cfg[field])) {
      throw new Error(`Config field "${field}" has invalid value: ${JSON.stringify(cfg[field])}`);
    }
  }
}

/**
 * Read and validate config from disk. Path fields are expanded (~ -> home).
 * @returns {Readonly<Record<string, unknown>>}
 */
export function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  validate(cfg);

  for (const field of PATH_FIELDS) {
    if (cfg[field]) {
      cfg[field] = expandPath(cfg[field]);
    }
  }

  return Object.freeze(cfg);
}

export const configEvents = new EventEmitter();

/**
 * Watch config file for changes. Emits 'change' on configEvents with the new config.
 */
export function watchConfig() {
  unwatchConfig();
  watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    try {
      const cfg = loadConfig();
      configEvents.emit('change', cfg);
      console.log('[config] Reloaded config');
    } catch (err) {
      console.warn(`[config] Invalid config change ignored: ${err.message}`);
    }
  });
}

/**
 * Stop watching the config file.
 */
export function unwatchConfig() {
  unwatchFile(CONFIG_PATH);
}
