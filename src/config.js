import { readFileSync, writeFileSync, watchFile, unwatchFile, existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import { expandPath } from './utils.js';
import { configPath, defaultDbPath, dataDir } from './paths.js';

const CONFIG_PATH = configPath();

const PATH_FIELDS = ['db_path', 'workspace_base_path', 'work_dir', 'global_terminal_cwd'];

const REQUIRED_FIELDS = {
  port: (v) => typeof v === 'number',
  workspace_base_path: (v) => typeof v === 'string',
  work_dir: (v) => typeof v === 'string',
};

/**
 * Validate config object. Throws on invalid.
 * @param {Record<string, unknown>} cfg
 */
const OWNER_REPO_RE = /^[^/]+\/[^/]+$/;

function validate(cfg) {
  for (const [field, predicate] of Object.entries(REQUIRED_FIELDS)) {
    if (!(field in cfg)) {
      throw new Error(`Missing required config field: ${field}`);
    }
    if (!predicate(cfg[field])) {
      throw new Error(`Config field "${field}" has invalid value: ${JSON.stringify(cfg[field])}`);
    }
  }

  if (!cfg.poll || typeof cfg.poll !== 'object') {
    throw new Error('Missing required config field: poll (object with orgs and/or repos arrays)');
  }

  cfg.poll.orgs = cfg.poll.orgs || [];
  cfg.poll.repos = cfg.poll.repos || [];

  if (!Array.isArray(cfg.poll.orgs)) {
    throw new Error('Config field "poll.orgs" must be an array');
  }
  if (!Array.isArray(cfg.poll.repos)) {
    throw new Error('Config field "poll.repos" must be an array');
  }
  if (typeof cfg.poll.interval_seconds !== 'number' || cfg.poll.interval_seconds < 5) {
    throw new Error('Config field "poll.interval_seconds" must be a number >= 5');
  }
  for (const repo of cfg.poll.repos) {
    if (!OWNER_REPO_RE.test(repo)) {
      throw new Error(`Invalid poll.repos entry "${repo}" - must be "owner/repo" format`);
    }
  }
}

/**
 * Read and validate config from disk. Path fields are expanded (~ -> home).
 * @returns {Readonly<Record<string, unknown>>}
 */
/**
 * Ensure a config file exists. If not, write a starter template and return false.
 * @returns {boolean} true if config exists, false if template was written
 */
export function ensureConfig() {
  if (existsSync(CONFIG_PATH)) return true;

  const template = {
    port: 3000,
    workspace_base_path: '~/.claude-patrol/workspaces',
    work_dir: '~/.claude-patrol/workspaces',
    poll: {
      interval_seconds: 30,
      orgs: [],
      repos: [],
    },
  };
  writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2) + '\n');
  return false;
}

/**
 * Check whether the config has any poll targets configured.
 * @param {Record<string, unknown>} cfg
 * @returns {boolean}
 */
export function isConfigured(cfg) {
  return cfg.poll.orgs.length > 0 || cfg.poll.repos.length > 0;
}

/**
 * Get the resolved config file path.
 * @returns {string}
 */
export function getConfigPath() {
  return CONFIG_PATH;
}

export function loadConfig() {
  const raw = readFileSync(CONFIG_PATH, 'utf8');
  const cfg = JSON.parse(raw);

  // Default db_path if not set
  if (!cfg.db_path) {
    cfg.db_path = defaultDbPath();
  }

  validate(cfg);

  for (const field of PATH_FIELDS) {
    if (cfg[field]) {
      if (field === 'db_path' && !cfg[field].startsWith('~') && !isAbsolute(cfg[field])) {
        // Relative db_path resolves against dataDir, not CWD
        cfg[field] = resolve(dataDir(), cfg[field]);
      } else {
        cfg[field] = expandPath(cfg[field]);
      }
    }
  }

  return Object.freeze(cfg);
}

export const configEvents = new EventEmitter();

/** @type {Readonly<Record<string, unknown>> | null} */
let currentConfig = null;

/**
 * Get the current config. Routes import this instead of holding their own copy.
 * @returns {Readonly<Record<string, unknown>>}
 */
export function getCurrentConfig() {
  return currentConfig;
}

/**
 * Set the current config. Called once at startup and on each config change.
 * @param {Readonly<Record<string, unknown>>} cfg
 */
export function setCurrentConfig(cfg) {
  currentConfig = cfg;
}

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
