import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from './utils.js';

const CODEX_ENV_KEYS = ['CODEX_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];

/** Build the minimal environment shared by the capability probe and MCP child. */
export function buildCodexEnvironment(source = process.env, base = getDefaultEnvironment()) {
  const environment = { ...base };
  for (const key of CODEX_ENV_KEYS) {
    if (typeof source[key] === 'string') environment[key] = source[key];
  }
  return environment;
}

function unavailable(reason, checkedAt, version = null) {
  return { available: false, checking: false, reason, version, checkedAt };
}

export class CodexCapabilityService {
  constructor({
    run = execFile,
    environment = buildCodexEnvironment(),
    cacheMs = 60_000,
    now = () => Date.now(),
  } = {}) {
    this.run = run;
    this.environment = environment;
    this.cacheMs = cacheMs;
    this.now = now;
    this.inFlight = null;
    this.snapshot = { available: false, checking: true, reason: null, version: null, checkedAt: null };
  }

  start() {
    void this.refresh().catch(() => {});
  }

  getSnapshot() {
    return { ...this.snapshot };
  }

  async refreshIfStale() {
    const checked = this.snapshot.checkedAt ? new Date(this.snapshot.checkedAt).getTime() : 0;
    if (!checked || this.now() - checked >= this.cacheMs) await this.refresh();
    return this.getSnapshot();
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.snapshot = { ...this.snapshot, checking: true };
    this.inFlight = this.runProbe().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async runProbe() {
    const checkedAt = () => new Date(this.now()).toISOString();
    let version = null;
    try {
      const result = await this.run('codex', ['--version'], {
        env: this.environment,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      version =
        String(result.stdout || '')
          .trim()
          .split('\n')[0] || null;
    } catch {
      this.snapshot = unavailable('Codex CLI is not installed or is not working', checkedAt());
      return this.getSnapshot();
    }

    try {
      await this.run('codex', ['mcp-server', '--help'], {
        env: this.environment,
        timeout: 10_000,
        maxBuffer: 256 * 1024,
      });
    } catch {
      this.snapshot = unavailable('This Codex CLI does not support mcp-server', checkedAt(), version);
      return this.getSnapshot();
    }

    try {
      await this.run('codex', ['login', 'status'], {
        env: this.environment,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      this.snapshot = unavailable('Codex is not authenticated. Run codex login.', checkedAt(), version);
      return this.getSnapshot();
    }

    this.snapshot = { available: true, checking: false, reason: null, version, checkedAt: checkedAt() };
    return this.getSnapshot();
  }
}
