import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { configPath, dataDir, defaultDbPath } from './paths.js';
import { expandPath } from './utils.js';

const CONFIG_PATH = configPath();

const PATH_FIELDS = ['db_path', 'workspace_base_path', 'work_dir', 'global_terminal_cwd'];

const OWNER_REPO_RE = /^[^/]+\/[^/]+$/;

export const configSchema = z
  .object({
    port: z.number().int().positive().default(3000),
    db_path: z.string().optional(),
    workspace_base_path: z.string().default('~/.claude-patrol/workspaces'),
    work_dir: z.string().default('~/.claude-patrol/workspaces'),
    global_terminal_cwd: z.string().optional(),
    symlink_memory: z.boolean().default(false),
    poll: z
      .object({
        interval_seconds: z.number().int().min(5).default(30),
        orgs: z.array(z.string()).default([]),
        repos: z
          .array(z.string().regex(OWNER_REPO_RE, 'must be "owner/repo" format'))
          .default([]),
      })
      .default({ interval_seconds: 30, orgs: [], repos: [] }),
    repos: z
      .record(
        z.string(),
        z.object({
          symlinks: z.array(z.string()).optional(),
          initCommands: z.array(z.string()).optional(),
        }),
      )
      .optional(),
    // pass-through for unknown keys (rules array etc.)
  })
  .passthrough();

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
  writeFileSync(CONFIG_PATH, `${JSON.stringify(template, null, 2)}\n`);
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
  const parsed = JSON.parse(raw);
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${issues}`);
  }
  const cfg = result.data;

  // Default db_path if not set
  if (!cfg.db_path) {
    cfg.db_path = defaultDbPath();
  }

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
