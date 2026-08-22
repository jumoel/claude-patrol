import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
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
}) {
  const provider = normalizeSessionProvider(rawProvider);
  if (claudeSessionId && provider !== 'claude') {
    const error = new Error('Only Claude sessions can resume a Claude conversation');
    error.code = 'provider_unsupported';
    throw error;
  }

  const tempPaths = [];
  const mcpUrl = enablePatrolMcp && port !== null ? `http://127.0.0.1:${port}/mcp/${sessionId}` : null;
  let commandArgs;
  let claudeProjectDir = null;

  if (provider === 'claude') {
    commandArgs = claudeSessionId ? ['claude', '--resume', claudeSessionId] : ['claude'];
    claudeProjectDir = resolve(expandPath('~/.claude/projects'), toClaudeProjectKey(cwd));

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

  return {
    provider,
    commandArgs: ['env', '-u', 'NO_COLOR', ...commandArgs],
    claudeProjectDir,
    tempPaths,
  };
}
