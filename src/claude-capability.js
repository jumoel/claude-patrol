import { ProviderCapabilityService } from './provider-capability.js';

export class ClaudeCapabilityService extends ProviderCapabilityService {
  async runProbe() {
    let version = null;
    try {
      version = await this.probeVersion('claude');
    } catch {
      return this.unavailable('Claude CLI is not installed or is not working');
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
      return this.unavailable('Claude is not authenticated. Run claude auth login.', version);
    }

    return this.available(version);
  }
}
