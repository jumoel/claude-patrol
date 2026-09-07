import { reviewReserve } from './review-request-query.js';

/** One identity/scope generation. Balances only increase at a new reset window. */
export class GitHubBudget {
  remaining = null;
  resetAt = null;
  fullCost = null;
  incrementalCost = null;
  cost = null;
  attempts = 0;
  pending = new Map();
  sequence = 0;
  known = false;

  begin(prediction = 1) {
    const token = ++this.sequence;
    this.attempts++;
    this.pending.set(token, prediction);
    return token;
  }

  observe(token, sample) {
    const predicted = this.pending.get(token) ?? 1;
    this.pending.delete(token);
    if (
      !sample ||
      !Number.isFinite(sample.cost) ||
      sample.cost < 0 ||
      !Number.isFinite(sample.remaining) ||
      sample.remaining < 0 ||
      !Number.isFinite(Date.parse(sample.resetAt))
    ) {
      this.remaining = this.remaining === null ? null : Math.max(0, this.remaining - predicted);
      this.known = false;
      return null;
    }
    const newer = !this.resetAt || Date.parse(sample.resetAt) > Date.parse(this.resetAt);
    if (newer) {
      this.resetAt = sample.resetAt;
      this.remaining = sample.remaining;
    } else if (sample.resetAt === this.resetAt) {
      this.remaining = Math.min(this.remaining ?? sample.remaining, sample.remaining);
    } else return sample.cost;
    this.known = true;
    this.cost = sample.cost;
    return sample.cost;
  }

  cycle(full, cost) {
    if (!Number.isFinite(cost) || cost <= 0) return;
    const key = full ? 'fullCost' : 'incrementalCost';
    this[key] = Math.max(this[key] ?? 0, cost);
  }

  reserve(interval) {
    return this.known
      ? reviewReserve({
          remaining: this.remaining,
          resetAt: this.resetAt,
          interval,
          incrementalCost: this.incrementalCost,
          fullCost: this.fullCost,
        })
      : null;
  }

  admits(interval, prediction) {
    const reserve = this.reserve(interval);
    const pending = [...this.pending.values()].reduce((sum, value) => sum + value, 0);
    return reserve !== null && this.remaining - pending - prediction >= reserve;
  }

  snapshot(interval) {
    return {
      remaining: this.known ? this.remaining : null,
      reset_at: this.resetAt,
      last_cost: this.cost,
      full_cycle_cost: this.fullCost,
      incremental_cycle_cost: this.incrementalCost,
      attempts: this.attempts,
      reserve: this.reserve(interval),
    };
  }
}
