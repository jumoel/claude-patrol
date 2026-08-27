import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  startWorkspaceReconciliationScheduler,
  WORKSPACE_RECONCILIATION_INTERVAL_MS,
} from './workspace-reconciliation-scheduler.js';

test('hourly reconciliation defaults to report-only and does not overlap', async () => {
  let scheduled;
  let release;
  const calls = [];
  const scheduler = startWorkspaceReconciliationScheduler({
    getConfig: () => ({}),
    isPatrolAvailable: () => true,
    setIntervalFn: (callback, interval) => {
      scheduled = { callback, interval };
      return { unref() {} };
    },
    clearIntervalFn() {},
    run: async (config, options) => {
      calls.push({ config, options });
      await new Promise((resolve) => {
        release = resolve;
      });
      return { deleted: [], blocked: [] };
    },
  });

  assert.equal(scheduled.interval, WORKSPACE_RECONCILIATION_INTERVAL_MS);
  const first = scheduled.callback();
  assert.deepEqual(await scheduler.runNow(), { skipped: true, reason: 'reconciliation_busy' });
  release();
  const result = await first;

  assert.equal(result.dry_run, true);
  assert.equal(calls[0].options.dryRun, true);
  assert.equal(calls[0].options.minimumAgeMs, 168 * 60 * 60 * 1000);
});

test('hourly deletion mode passes the configured continuous orphan age', async () => {
  let options;
  const scheduler = startWorkspaceReconciliationScheduler({
    getConfig: () => ({
      workspace_reconciliation: { hourly_policy: 'delete_after_retention', retention_hours: 24 },
    }),
    isPatrolAvailable: () => false,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
    run: async (_config, received) => {
      options = received;
      return { deleted: [], warnings: ['Patrol is unavailable; cleanup skipped'] };
    },
  });

  const result = await scheduler.runNow();

  assert.equal(result.dry_run, false);
  assert.equal(options.dryRun, false);
  assert.equal(options.minimumAgeMs, 24 * 60 * 60 * 1000);
  assert.equal(options.isPatrolAvailable(), false);
});
