import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandPath, toClaudeProjectKey } from './utils.js';

export const SESSION_PROVIDERS = Object.freeze(['claude', 'codex']);

/**
 * Validate an agent provider at an API or process boundary.
 * @param {unknown} value
 * @param {'claude'|'codex'} [fallback='claude']
 * @returns {'claude'|'codex'}
 */
export function normalizeSessionProvider(value, fallback = 'claude') {
  const provider = value ?? fallback;
  if (!SESSION_PROVIDERS.includes(provider)) {
    const error = new Error(`Unknown session provider: ${String(provider)}`);
    error.code = 'invalid_provider';
    throw error;
  }
  return provider;
}

export function mcpConfigPathForSession(sessionId) {
  return resolve(tmpdir(), `patrol-mcp-${sessionId}.json`);
}

export function activityCredentialPathForSession(sessionId) {
  return resolve(tmpdir(), `patrol-activity-${sessionId}.json`);
}

export function activitySettingsPathForSession(sessionId) {
  return resolve(tmpdir(), `patrol-activity-settings-${sessionId}.json`);
}

export function readActivityCredential(sessionId) {
  try {
    const credential = JSON.parse(readFileSync(activityCredentialPathForSession(sessionId), 'utf8'));
    if (
      !credential ||
      !SESSION_PROVIDERS.includes(credential.provider) ||
      typeof credential.token !== 'string' ||
      credential.token.length < 16
    ) {
      return null;
    }
    return { provider: credential.provider, token: credential.token };
  } catch {
    return null;
  }
}

function writeClaudeMcpConfig(sessionId, url, timeoutMs) {
  const path = mcpConfigPathForSession(sessionId);
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          patrol: {
            type: 'http',
            url,
            timeout: timeoutMs,
          },
        },
      },
      null,
      2,
    ),
  );
  return path;
}

function writeActivityCredential(sessionId, provider, token) {
  const path = activityCredentialPathForSession(sessionId);
  writeFileSync(path, JSON.stringify({ provider, token }), { mode: 0o600, flag: 'wx' });
  return path;
}

function writeClaudeActivitySettings(sessionId) {
  const path = activitySettingsPathForSession(sessionId);
  const command = [process.execPath, PROVIDER_ACTIVITY_NOTIFY_PATH, 'claude']
    .map((part) => `'${part.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const activityHook = {
    type: 'command',
    command,
    timeout: 2,
  };
  const hooks = {};
  for (const eventName of [
    'UserPromptSubmit',
    'MessageDisplay',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'Stop',
    'StopFailure',
  ]) {
    hooks[eventName] = [{ hooks: [activityHook] }];
  }
  writeFileSync(path, JSON.stringify({ hooks }, null, 2), { mode: 0o600, flag: 'wx' });
  return path;
}

const PROVIDER_ACTIVITY_NOTIFY_PATH = fileURLToPath(new URL('./provider-activity-notify.js', import.meta.url));

/**
 * Build the provider-specific CLI invocation and metadata for a Patrol session.
 */
export function buildSessionLaunch({
  provider: rawProvider,
  sessionId,
  cwd,
  port,
  patrolPrompt,
  mcpTimeoutMs,
  claudeSessionId = null,
  enablePatrolMcp = true,
  initialPrompt = null,
  activityToken = null,
}) {
  const provider = normalizeSessionProvider(rawProvider);
  if (claudeSessionId && provider !== 'claude') {
    const error = new Error('Only Claude sessions can resume a Claude conversation');
    error.code = 'provider_unsupported';
    throw error;
  }

  const tempPaths = [];
  const mcpUrl = enablePatrolMcp && port !== null ? `http://127.0.0.1:${port}/mcp/${sessionId}` : null;
  const activityBaseUrl =
    activityToken && port !== null ? `http://127.0.0.1:${port}/api/sessions/${sessionId}/activity` : null;
  let commandArgs;
  let claudeProjectDir = null;

  try {
    if (provider === 'claude') {
      commandArgs = claudeSessionId ? ['claude', '--resume', claudeSessionId] : ['claude'];
      claudeProjectDir = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(cwd));

      if (activityBaseUrl) {
        const settingsPath = writeClaudeActivitySettings(sessionId);
        tempPaths.push(settingsPath);
        commandArgs.push('--settings', settingsPath);
      }

      if (mcpUrl) {
        const mcpConfigPath = writeClaudeMcpConfig(sessionId, mcpUrl, mcpTimeoutMs);
        tempPaths.push(mcpConfigPath);
        commandArgs.push('--mcp-config', mcpConfigPath);

        const promptFile = resolve(tmpdir(), `patrol-prompt-${sessionId}.txt`);
        writeFileSync(promptFile, patrolPrompt);
        tempPaths.push(promptFile);
        commandArgs.push('--append-system-prompt-file', promptFile);
        commandArgs.push('--allowedTools', 'mcp__patrol__*', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent');
      }
      if (initialPrompt) commandArgs.push(initialPrompt);
    } else {
      commandArgs = ['codex', '-C', cwd];
      if (activityBaseUrl) {
        commandArgs.push('-c', `notify=${JSON.stringify([process.execPath, PROVIDER_ACTIVITY_NOTIFY_PATH, 'codex'])}`);
      }
      if (mcpUrl) {
        commandArgs.push(
          '-c',
          `mcp_servers.patrol.url=${JSON.stringify(mcpUrl)}`,
          '-c',
          'mcp_servers.patrol.required=true',
          '-c',
          `mcp_servers.patrol.tool_timeout_sec=${Math.ceil(mcpTimeoutMs / 1000)}`,
          '-c',
          `developer_instructions=${JSON.stringify(patrolPrompt)}`,
        );
      }
      if (initialPrompt) commandArgs.push(initialPrompt);
    }

    const envArgs = ['env', '-u', 'NO_COLOR'];
    if (activityBaseUrl) {
      tempPaths.push(writeActivityCredential(sessionId, provider, activityToken));
      envArgs.push(`PATROL_ACTIVITY_URL=${activityBaseUrl}/${provider}`);
      envArgs.push(`PATROL_ACTIVITY_TOKEN=${activityToken}`);
    }

    return {
      provider,
      commandArgs: [...envArgs, ...commandArgs],
      claudeProjectDir,
      tempPaths,
    };
  } catch (error) {
    for (const path of tempPaths) {
      try {
        unlinkSync(path);
      } catch {}
    }
    throw error;
  }
}
