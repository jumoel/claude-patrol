/**
 * Coalescing single-flight executor. At most one job runs at a time. Requests
 * received while a job is active are merged into one pending job, and every
 * caller resolves or rejects with the coalesced execution.
 */
export class SingleFlight {
  #active = null;
  #idleWaiters = [];
  #merge;
  #pending = null;
  #run;

  constructor({ run, merge = (_previous, next) => next }) {
    this.#run = run;
    this.#merge = merge;
  }

  request(value) {
    const promise = new Promise((resolve, reject) => {
      if (this.#pending) {
        this.#pending.value = this.#merge(this.#pending.value, value);
        this.#pending.waiters.push({ resolve, reject });
      } else {
        this.#pending = { value, waiters: [{ resolve, reject }] };
      }
    });
    this.#drain();
    return promise;
  }

  whenIdle() {
    if (!this.#active && !this.#pending) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  get active() {
    return this.#active !== null;
  }

  get pending() {
    return this.#pending !== null;
  }

  async #drain() {
    if (this.#active || !this.#pending) return;

    const job = this.#pending;
    this.#pending = null;
    this.#active = job;
    try {
      const result = await this.#run(job.value);
      for (const waiter of job.waiters) waiter.resolve(result);
    } catch (error) {
      for (const waiter of job.waiters) waiter.reject(error);
    } finally {
      this.#active = null;
      if (this.#pending) {
        this.#drain();
      } else {
        for (const resolve of this.#idleWaiters.splice(0)) resolve();
      }
    }
  }
}
