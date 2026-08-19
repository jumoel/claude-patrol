import { execFile } from './utils.js';

function unavailable(reason, checkedAt, version = null) {
  return { available: false, checking: false, reason, version, checkedAt };
}

export class ClaudeCapabilityService {
  constructor({ run = execFile, environment = { ...process.env }, cacheMs = 60_000, now = () => Date.now() } = {}) {
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
      const result = await this.run('claude', ['--version'], {
        env: this.environment,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      version =
        String(result.stdout || '')
          .trim()
          .split('\n')[0] || null;
    } catch {
      this.snapshot = unavailable('Claude CLI is not installed or is not working', checkedAt());
      return this.getSnapshot();
    }

    try {
      const result = await this.run('claude', ['auth', 'status'], {
        env: this.environment,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      const status = JSON.parse(String(result.stdout || '{}'));
      if (status.loggedIn !== true) throw new Error('not authenticated');
    } catch {
      this.snapshot = unavailable('Claude is not authenticated. Run claude auth login.', checkedAt(), version);
      return this.getSnapshot();
    }

    this.snapshot = { available: true, checking: false, reason: null, version, checkedAt: checkedAt() };
    return this.getSnapshot();
  }
}
