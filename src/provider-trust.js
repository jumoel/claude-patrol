import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { normalizeSessionProvider } from './session-launch.js';

/**
 * Pre-trust a working directory for an agent CLI so an interactive session
 * launched there does not stop at the "do you trust this folder" prompt.
 *
 * Both CLIs keep trust in a user-level config file keyed by the absolute,
 * symlink-resolved directory path:
 * - Claude Code: `~/.claude.json` -> `projects[path].hasTrustDialogAccepted`
 * - Codex: `~/.codex/config.toml` -> `[projects."path"] trust_level = "trusted"`
 *
 * Edits are read-modify-write with an atomic rename so a half-written file is
 * never visible to a CLI that starts concurrently. Unparseable files are left
 * alone and reported as an error rather than overwritten.
 */

const CLAUDE_PROJECT_DEFAULTS = Object.freeze({
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
});

export function claudeConfigPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : homedir();
  return resolve(dir, '.claude.json');
}

export function codexConfigPath(env = process.env) {
  const dir = env.CODEX_HOME ? resolve(env.CODEX_HOME) : resolve(homedir(), '.codex');
  return resolve(dir, 'config.toml');
}

/**
 * The CLIs see `getcwd()`, which is the physical path, so trust the resolved
 * path. A directory that does not exist yet falls back to the absolute input.
 */
function resolveTrustedPath(cwd) {
  try {
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

function readTextIfPresent(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function currentMode(path, fallback) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return fallback;
  }
}

function writeFileAtomic(path, content, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.patrol-${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, path);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} cwd
 * @param {{ configPath?: string }} [options]
 * @returns {{ path: string, configPath: string, changed: boolean }}
 */
export function trustClaudeDirectory(cwd, { configPath = claudeConfigPath() } = {}) {
  const path = resolveTrustedPath(cwd);
  const raw = readTextIfPresent(configPath);
  let config = {};
  if (raw !== null) {
    config = JSON.parse(raw);
    if (!isPlainObject(config)) throw new Error(`${configPath} does not contain a JSON object`);
  }
  if (config.projects === undefined) config.projects = {};
  if (!isPlainObject(config.projects)) throw new Error(`${configPath} has a non-object "projects" entry`);

  const existing = config.projects[path];
  if (isPlainObject(existing) && existing.hasTrustDialogAccepted === true) {
    return { path, configPath, changed: false };
  }
  config.projects[path] = isPlainObject(existing)
    ? { ...existing, hasTrustDialogAccepted: true }
    : { ...CLAUDE_PROJECT_DEFAULTS, hasTrustDialogAccepted: true };

  // Claude Code writes two-space indented JSON without a trailing newline.
  writeFileAtomic(configPath, JSON.stringify(config, null, 2), currentMode(configPath, 0o600));
  return { path, configPath, changed: true };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * JSON string escaping is a subset of TOML basic-string escaping, so the JSON
 * form of a path is a valid TOML basic string and matches what Codex writes.
 */
function tomlBasicString(value) {
  return JSON.stringify(value);
}

/**
 * @param {string} cwd
 * @param {{ configPath?: string }} [options]
 * @returns {{ path: string, configPath: string, changed: boolean, reason?: string }}
 */
export function trustCodexDirectory(cwd, { configPath = codexConfigPath() } = {}) {
  const path = resolveTrustedPath(cwd);
  const raw = readTextIfPresent(configPath) ?? '';
  const quoted = tomlBasicString(path);
  const lines = raw.split('\n');
  const headerPattern = new RegExp(`^\\s*\\[\\s*projects\\s*\\.\\s*${escapeRegExp(quoted)}\\s*\\]\\s*(#.*)?$`);
  const headerIndex = lines.findIndex((line) => headerPattern.test(line));

  if (headerIndex === -1) {
    // Codex only ever writes `[projects."path"]` tables. If the path shows up
    // in any other spelling the user hand-wrote it, and appending a table
    // could produce a duplicate that makes the whole file unparseable.
    if (raw.includes(quoted) || raw.includes(`'${path}'`)) {
      return { path, configPath, changed: false, reason: 'unmanaged_entry' };
    }
    const separator = raw === '' ? '' : raw.endsWith('\n') ? '\n' : '\n\n';
    const next = `${raw}${separator}[projects.${quoted}]\ntrust_level = "trusted"\n`;
    writeFileAtomic(configPath, next, currentMode(configPath, 0o600));
    return { path, configPath, changed: true };
  }

  let tableEnd = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      tableEnd = i;
      break;
    }
  }
  const keyPattern = /^\s*trust_level\s*=\s*(.*?)\s*(#.*)?$/;
  let keyIndex = -1;
  for (let i = headerIndex + 1; i < tableEnd; i++) {
    if (keyPattern.test(lines[i])) {
      keyIndex = i;
      break;
    }
  }
  if (keyIndex !== -1 && /^(["'])trusted\1$/.test(lines[keyIndex].match(keyPattern)[1])) {
    return { path, configPath, changed: false };
  }
  if (keyIndex === -1) {
    lines.splice(headerIndex + 1, 0, 'trust_level = "trusted"');
  } else {
    lines[keyIndex] = 'trust_level = "trusted"';
  }
  writeFileAtomic(configPath, lines.join('\n'), currentMode(configPath, 0o600));
  return { path, configPath, changed: true };
}

/**
 * Trust `cwd` for the CLI that `provider` launches.
 * @param {'claude'|'codex'} provider
 * @param {string} cwd
 * @param {{ claude?: { configPath?: string }, codex?: { configPath?: string } }} [options]
 */
export function trustSessionDirectory(provider, cwd, options = {}) {
  return normalizeSessionProvider(provider) === 'claude'
    ? trustClaudeDirectory(cwd, options.claude)
    : trustCodexDirectory(cwd, options.codex);
}
