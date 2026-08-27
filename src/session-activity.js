export const ACTIVITY_IDLE_THRESHOLD_MS = 10_000;

const CLAUDE_WORKING_EVENTS = new Set(['UserPromptSubmit', 'MessageDisplay', 'PostToolUse', 'PostToolUseFailure']);

function boundedString(value, maxLength = 256) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

/**
 * Convert provider payloads into the small lifecycle contract understood by
 * SessionActivityTracker. The endpoint never retains full hook payloads.
 */
export function normalizeProviderActivity(provider, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  if (provider === 'codex') {
    if (payload.event !== 'turn_completed') return null;
    const runId = boundedString(payload.run_id);
    if (!runId) return null;
    return { kind: 'completed', runId, source: 'codex_notify' };
  }

  if (provider !== 'claude') return null;
  const eventName = boundedString(payload.hook_event_name, 64);
  const runId = boundedString(payload.prompt_id);

  if (CLAUDE_WORKING_EVENTS.has(eventName)) {
    return { kind: 'working', runId, source: `claude_${eventName}` };
  }
  if (eventName === 'PreToolUse') {
    const toolName = boundedString(payload.tool_name, 128);
    return {
      kind: toolName === 'AskUserQuestion' ? 'blocked' : 'working',
      runId,
      source: `claude_${eventName}`,
    };
  }
  if (eventName === 'PermissionRequest') {
    return { kind: 'blocked', runId, source: 'claude_PermissionRequest' };
  }
  if (eventName === 'Stop') {
    return { kind: 'candidate_completed', runId, source: 'claude_Stop' };
  }
  if (eventName === 'StopFailure') {
    return { kind: 'failed', runId, source: 'claude_StopFailure' };
  }
  return null;
}

/**
 * Owns the activity state machine for one provider session. Provider lifecycle
 * events are authoritative; terminal output never changes activity state.
 */
export class SessionActivityTracker {
  constructor({
    onState,
    idleThresholdMs = ACTIVITY_IDLE_THRESHOLD_MS,
    now = () => Date.now(),
    schedule = setTimeout,
    cancel = clearTimeout,
  }) {
    this.onState = onState;
    this.idleThresholdMs = idleThresholdMs;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.state = null;
    this.lastWorkingAt = null;
    this.lastIdleAt = null;
    this.nativeTracking = false;
    this.currentRunId = null;
    this.completionConfirmed = false;
    this.completionOutcome = null;
    this.activitySource = null;
    this.candidateTimer = null;
  }

  snapshot() {
    return {
      activityState: this.state,
      lastWorkingAt: this.lastWorkingAt,
      lastIdleAt: this.lastIdleAt,
      nativeTracking: this.nativeTracking,
      currentRunId: this.currentRunId,
      completionConfirmed: this.completionConfirmed,
      completionOutcome: this.completionOutcome,
      activitySource: this.activitySource,
    };
  }

  dispose() {
    this.clearCandidateTimer();
  }

  clearCandidateTimer() {
    if (this.candidateTimer !== null) this.cancel(this.candidateTimer);
    this.candidateTimer = null;
  }

  emit(changedAt) {
    this.onState?.({
      state: this.state,
      changedAt,
      confirmed: this.completionConfirmed,
      outcome: this.completionOutcome,
      source: this.activitySource,
    });
  }

  transitionToWorking({ source, runId = null }) {
    const sameRun = !runId || runId === this.currentRunId;
    if (this.state === 'working' && sameRun) return false;

    const retainingRun =
      this.state === 'idle' && (this.completionConfirmed === false || this.completionOutcome === 'blocked');
    if (runId) this.currentRunId = runId;
    else if (!retainingRun) this.currentRunId = null;

    this.clearCandidateTimer();
    const previousAnchor = Math.max(this.lastWorkingAt ?? 0, this.lastIdleAt ?? 0);
    const changedAt = Math.max(this.now(), previousAnchor + 1);
    this.state = 'working';
    this.lastWorkingAt = changedAt;
    this.completionConfirmed = false;
    this.completionOutcome = null;
    this.activitySource = source;
    this.emit(changedAt);
    return true;
  }

  transitionToIdle({ source, runId = null, confirmed, outcome }) {
    const sameRun = !runId || runId === this.currentRunId;
    if (
      this.state === 'idle' &&
      sameRun &&
      this.completionConfirmed === confirmed &&
      this.completionOutcome === outcome
    ) {
      return false;
    }

    if (runId) this.currentRunId = runId;
    const previousAnchor = Math.max(this.lastWorkingAt ?? 0, this.lastIdleAt ?? 0);
    const changedAt = this.state === 'idle' && sameRun ? this.lastIdleAt : Math.max(this.now(), previousAnchor + 1);
    this.state = 'idle';
    this.lastIdleAt = changedAt;
    this.completionConfirmed = confirmed;
    this.completionOutcome = outcome;
    this.activitySource = source;
    this.emit(changedAt);
    return true;
  }

  markWorking(source = 'dispatch', { expectNative = false } = {}) {
    this.transitionToWorking({ source });
    if (expectNative) {
      this.nativeTracking = true;
    }
  }

  handleProviderEvent(event) {
    this.nativeTracking = true;

    if (event.kind === 'working') {
      if (event.runId && this.currentRunId && event.runId !== this.currentRunId && this.state === 'working') {
        return { accepted: false, reason: 'stale_event' };
      }
      const changed = this.transitionToWorking({ source: event.source, runId: event.runId });
      return { accepted: true, duplicate: !changed };
    }

    if (event.runId && this.currentRunId && event.runId !== this.currentRunId) {
      return { accepted: false, reason: 'stale_event' };
    }

    const outcome = event.kind === 'failed' ? 'failed' : event.kind === 'blocked' ? 'blocked' : 'completed';
    const confirmed = event.kind !== 'candidate_completed';
    const changed = this.transitionToIdle({
      source: event.source,
      runId: event.runId,
      confirmed,
      outcome,
    });
    if (!changed) return { accepted: true, duplicate: true };

    if (event.kind === 'candidate_completed') {
      this.clearCandidateTimer();
      const candidateRunId = this.currentRunId;
      const candidateIdleAt = this.lastIdleAt;
      this.candidateTimer = this.schedule(() => {
        this.candidateTimer = null;
        if (
          this.state !== 'idle' ||
          this.currentRunId !== candidateRunId ||
          this.lastIdleAt !== candidateIdleAt ||
          this.completionOutcome !== 'completed' ||
          this.completionConfirmed
        ) {
          return;
        }
        this.completionConfirmed = true;
        this.activitySource = 'claude_Stop_confirmed';
        this.emit(this.lastIdleAt);
      }, this.idleThresholdMs);
      this.candidateTimer?.unref?.();
    }

    return { accepted: true, duplicate: false };
  }
}
