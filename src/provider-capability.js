import { execFile } from './utils.js';

/**
 * Cached availability probe for an agent CLI. Subclasses implement runProbe()
 * and return the snapshot they computed; everything about caching, in-flight
 * coalescing and the public snapshot shape lives here.
 */
export class ProviderCapabilityService {
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

  /** ISO timestamp from the injected clock, for snapshot.checkedAt. */
  checkedAt() {
    return new Date(this.now()).toISOString();
  }

  /** Record an unavailable result and return the public snapshot. */
  unavailable(reason, version = null) {
    this.snapshot = { available: false, checking: false, reason, version, checkedAt: this.checkedAt() };
    return this.getSnapshot();
  }

  /** Record an available result and return the public snapshot. */
  available(version) {
    this.snapshot = { available: true, checking: false, reason: null, version, checkedAt: this.checkedAt() };
    return this.getSnapshot();
  }

  /** Run `<cli> --version` and return the first output line, or null. */
  async probeVersion(command) {
    const result = await this.run(command, ['--version'], {
      env: this.environment,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return (
      String(result.stdout || '')
        .trim()
        .split('\n')[0] || null
    );
  }

  /** @returns {Promise<ReturnType<ProviderCapabilityService['getSnapshot']>>} */
  async runProbe() {
    throw new Error(`${this.constructor.name} must implement runProbe()`);
  }
}
