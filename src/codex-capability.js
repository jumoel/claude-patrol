import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ProviderCapabilityService } from './provider-capability.js';

const CODEX_ENV_KEYS = ['CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/** Build the minimal environment shared by the capability probe and MCP child. */
export function buildCodexEnvironment(source = process.env, base = getDefaultEnvironment()) {
  const environment = { ...base };
  for (const key of CODEX_ENV_KEYS) {
    if (typeof source[key] === 'string') environment[key] = source[key];
  }
  return environment;
}

export class CodexCapabilityService extends ProviderCapabilityService {
  constructor({ environment = buildCodexEnvironment(), ...options } = {}) {
    super({ ...options, environment });
  }

  async runProbe() {
    let version = null;
    try {
      version = await this.probeVersion('codex');
    } catch {
      return this.unavailable('Codex CLI is not installed or is not working');
    }

    try {
      await this.run('codex', ['mcp-server', '--help'], {
        env: this.environment,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      });
    } catch {
      return this.unavailable('This Codex CLI does not support mcp-server', version);
    }

    try {
      await this.run('codex', ['login', 'status'], {
        env: this.environment,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      return this.unavailable('Codex is not authenticated. Run codex login.', version);
    }

    return this.available(version);
  }
}
