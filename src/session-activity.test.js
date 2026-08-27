import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeProviderActivity, SessionActivityTracker } from './session-activity.js';

function activityHarness() {
  let now = 1_000;
  const timers = [];
  const events = [];
  const tracker = new SessionActivityTracker({
    idleThresholdMs: 100,
    now: () => now,
    schedule(callback, delay) {
      const timer = { callback, at: now + delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      timer.cancelled = true;
    },
    onState: (event) => events.push(event),
  });
  return {
    tracker,
    events,
    advance(ms) {
      now += ms;
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
        timer.cancelled = true;
        timer.callback();
      }
    },
  };
}

describe('normalizeProviderActivity', () => {
  it('keeps only lifecycle identifiers from Codex completion notifications', () => {
    assert.deepEqual(
      normalizeProviderActivity('codex', {
        event: 'turn_completed',
        run_id: 'turn-1',
        'last-assistant-message': 'must not be retained',
      }),
      { kind: 'completed', runId: 'turn-1', source: 'codex_notify' },
    );
    assert.equal(normalizeProviderActivity('codex', { event: 'turn_started', run_id: 'turn-1' }), null);
  });

  it('maps Claude prompts, waits, stops, and failures', () => {
    assert.equal(normalizeProviderActivity('claude', { hook_event_name: 'UserPromptSubmit' }).kind, 'working');
    assert.equal(normalizeProviderActivity('claude', { hook_event_name: 'MessageDisplay' }).kind, 'working');
    assert.equal(
      normalizeProviderActivity('claude', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }).kind,
      'blocked',
    );
    assert.equal(normalizeProviderActivity('claude', { hook_event_name: 'PermissionRequest' }).kind, 'blocked');
    assert.equal(normalizeProviderActivity('claude', { hook_event_name: 'Stop' }).kind, 'candidate_completed');
    assert.equal(normalizeProviderActivity('claude', { hook_event_name: 'StopFailure' }).kind, 'failed');
  });
});

describe('SessionActivityTracker', () => {
  it('uses PTY silence only before a native event handshake', () => {
    const fallback = activityHarness();
    fallback.tracker.markWorking();
    fallback.advance(100);
    assert.deepEqual(fallback.tracker.snapshot(), {
      activityState: 'idle',
      lastWorkingAt: 1_000,
      lastIdleAt: 1_100,
      nativeTracking: false,
      currentRunId: null,
      completionConfirmed: true,
      completionOutcome: 'completed',
      activitySource: 'pty_silence',
    });

    const native = activityHarness();
    native.tracker.markWorking();
    native.tracker.handleProviderEvent({ kind: 'working', runId: 'prompt-1', source: 'claude_UserPromptSubmit' });
    native.advance(1_000);
    assert.equal(native.tracker.snapshot().activityState, 'working');
    assert.equal(native.tracker.snapshot().nativeTracking, true);
  });

  it('keeps an explicitly notifier-tracked turn working until its native completion', () => {
    const harness = activityHarness();
    harness.tracker.markWorking('dispatch', { expectNative: true });
    harness.advance(1_000);
    assert.equal(harness.tracker.snapshot().activityState, 'working');
    assert.equal(harness.tracker.snapshot().nativeTracking, true);
  });

  it('publishes Claude Stop immediately but confirms it without moving the timing anchor', () => {
    const harness = activityHarness();
    harness.tracker.handleProviderEvent({ kind: 'working', runId: 'prompt-1', source: 'prompt' });
    harness.advance(10);
    harness.tracker.handleProviderEvent({ kind: 'candidate_completed', runId: 'prompt-1', source: 'stop' });

    const candidate = harness.tracker.snapshot();
    assert.equal(candidate.activityState, 'idle');
    assert.equal(candidate.completionConfirmed, false);
    assert.equal(candidate.lastIdleAt, 1_010);

    harness.advance(100);
    const confirmed = harness.tracker.snapshot();
    assert.equal(confirmed.completionConfirmed, true);
    assert.equal(confirmed.lastIdleAt, candidate.lastIdleAt);
    assert.equal(harness.events.at(-1).changedAt, candidate.lastIdleAt);
  });

  it('cancels candidate completion when provider output resumes', () => {
    const harness = activityHarness();
    harness.tracker.handleProviderEvent({ kind: 'working', runId: 'prompt-1', source: 'prompt' });
    harness.tracker.handleProviderEvent({ kind: 'candidate_completed', runId: 'prompt-1', source: 'stop' });
    harness.tracker.markWorking('pty_output');
    harness.advance(1_000);

    const snapshot = harness.tracker.snapshot();
    assert.equal(snapshot.activityState, 'working');
    assert.equal(snapshot.currentRunId, 'prompt-1');
    assert.equal(snapshot.completionOutcome, null);
  });

  it('accepts Codex completion immediately and deduplicates its turn id', () => {
    const harness = activityHarness();
    harness.tracker.markWorking('dispatch');
    harness.advance(5);
    const first = harness.tracker.handleProviderEvent({ kind: 'completed', runId: 'turn-1', source: 'codex_notify' });
    const idleAt = harness.tracker.snapshot().lastIdleAt;
    harness.advance(5);
    const duplicate = harness.tracker.handleProviderEvent({
      kind: 'completed',
      runId: 'turn-1',
      source: 'codex_notify',
    });

    assert.deepEqual(first, { accepted: true, duplicate: false });
    assert.deepEqual(duplicate, { accepted: true, duplicate: true });
    assert.equal(harness.tracker.snapshot().lastIdleAt, idleAt);
    assert.equal(harness.tracker.snapshot().completionConfirmed, true);
  });

  it('rejects a terminal event for a stale run and records blocked and failed outcomes', () => {
    const harness = activityHarness();
    harness.tracker.handleProviderEvent({ kind: 'working', runId: 'prompt-2', source: 'prompt' });
    assert.deepEqual(harness.tracker.handleProviderEvent({ kind: 'completed', runId: 'prompt-1', source: 'stop' }), {
      accepted: false,
      reason: 'stale_event',
    });
    harness.tracker.handleProviderEvent({ kind: 'blocked', runId: 'prompt-2', source: 'permission' });
    assert.equal(harness.tracker.snapshot().completionOutcome, 'blocked');
    harness.tracker.markWorking('terminal_input');
    harness.tracker.handleProviderEvent({ kind: 'failed', runId: 'prompt-2', source: 'failure' });
    assert.equal(harness.tracker.snapshot().completionOutcome, 'failed');
    assert.equal(harness.tracker.snapshot().completionConfirmed, true);
  });
});
