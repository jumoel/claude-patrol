import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';

const APP = 'claude-patrol';

function xdgDir(envVar, fallbackSegment) {
  const base = process.env[envVar] || join(homedir(), fallbackSegment);
  const dir = join(base, APP);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** ~/.config/claude-patrol (or $XDG_CONFIG_HOME/claude-patrol) */
export function configDir() {
  return xdgDir('XDG_CONFIG_HOME', '.config');
}

/** ~/.local/share/claude-patrol (or $XDG_DATA_HOME/claude-patrol) */
export function dataDir() {
  return xdgDir('XDG_DATA_HOME', join('.local', 'share'));
}

/** ~/.local/state/claude-patrol (or $XDG_STATE_HOME/claude-patrol) */
export function stateDir() {
  return xdgDir('XDG_STATE_HOME', join('.local', 'state'));
}

/** Path to config.json */
export function configPath() {
  return join(configDir(), 'config.json');
}

/** Default DB path when not specified in config */
export function defaultDbPath() {
  return join(dataDir(), 'claude-patrol.db');
}

/** Path to MCP config JSON */
export function mcpConfigPath() {
  return join(dataDir(), '.patrol-mcp.json');
}

/** Path to PID file */
export function pidPath() {
  return join(stateDir(), 'claude-patrol.pid');
}

/** ~/.local/share/claude-patrol/transcripts (or $XDG_DATA_HOME/claude-patrol/transcripts) */
export function transcriptsDir() {
  const dir = join(dataDir(), 'transcripts');
  mkdirSync(dir, { recursive: true });
  return dir;
}
