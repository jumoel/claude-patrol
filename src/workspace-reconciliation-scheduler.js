import { reconcilePatrolWorkspaces } from './workspace-reconciliation.js';

export const WORKSPACE_RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;

export function workspaceReconciliationPolicy(config) {
  const configured = config.workspace_reconciliation ?? {};
  return {
    hourly_policy: configured.hourly_policy ?? 'report_only',
    retention_hours: configured.retention_hours ?? 168,
  };
}

/**
 * Start the hourly orphan pass. The scheduler never overlaps runs and leaves
 * deletion authority with the reconciliation service.
 */
export function startWorkspaceReconciliationScheduler({
  getConfig,
  isPatrolAvailable,
  run = reconcilePatrolWorkspaces,
  logger = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = WORKSPACE_RECONCILIATION_INTERVAL_MS,
}) {
  let running = false;
  const execute = async () => {
    if (running) return { skipped: true, reason: 'reconciliation_busy' };
    running = true;
    try {
      const config = getConfig();
      const policy = workspaceReconciliationPolicy(config);
      const dryRun = policy.hourly_policy === 'report_only';
      const result = await run(config, {
        dryRun,
        minimumAgeMs: policy.retention_hours * 60 * 60 * 1000,
        isPatrolAvailable,
      });
      return { skipped: false, dry_run: dryRun, ...result };
    } catch (error) {
      logger.warn(`[claude-patrol] Hourly workspace reconciliation failed: ${error.message}`);
      return { skipped: false, error: error.message };
    } finally {
      running = false;
    }
  };

  const handle = setIntervalFn(execute, intervalMs);
  handle.unref?.();
  return {
    runNow: execute,
    stop: () => clearIntervalFn(handle),
  };
}
