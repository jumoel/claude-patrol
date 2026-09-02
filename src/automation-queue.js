class ReservationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReservationError';
    this.code = code;
  }
}

/**
 * Persistent, bounded queue for rule actions. Public rule_runs rows retain
 * their existing shape; automation_jobs contains internal scheduling state.
 */
export class AutomationQueue {
  #accepting = false;
  #completions = new Map();
  #concurrency;
  #execute;
  #getDb;
  #onUpdate;
  #pumping = false;
  #running = 0;

  constructor({ getDb, execute, onUpdate = () => {}, concurrency = 2 }) {
    this.#getDb = getDb;
    this.#execute = execute;
    this.#onUpdate = onUpdate;
    this.setConcurrency(concurrency);
  }

  setConcurrency(value) {
    const parsed = Number(value);
    this.#concurrency = Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
    this.#schedulePump();
  }

  start() {
    const db = this.#getDb();
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const interrupted = db.prepare("SELECT id FROM automation_jobs WHERE status = 'running'").all();
      for (const { id } of interrupted) {
        db.prepare("UPDATE automation_jobs SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, id);
        db.prepare(
          "UPDATE rule_runs SET status = 'error', error = 'server_restarted', ended_at = ? WHERE id = ? AND status = 'running'",
        ).run(now, id);
      }
      db.prepare(
        `UPDATE rule_runs
            SET status = 'error', error = 'server_restarted', ended_at = ?
          WHERE status = 'running'
            AND id NOT IN (SELECT id FROM automation_jobs WHERE status = 'queued')`,
      ).run(now);
      db.exec('COMMIT');
      if (interrupted.length > 0) {
        console.log(`[rules] Reconciled ${interrupted.length} interrupted automation job(s)`);
      }
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    this.#accepting = true;
    this.#schedulePump();
  }

  async stop({ drain = true } = {}) {
    this.#accepting = false;
    if (!drain) return;
    while (this.#running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * Atomically enforce cooldown/dedupe and persist a queued execution.
   * Returns synchronously so bulk callers can return stable run ids.
   */
  enqueue({ run, payload, cooldownMinutes = 0, bypassCooldown = false, dedupeKey = null }) {
    if (!this.#accepting) throw new Error('automation queue is not running');
    const db = this.#getDb();
    const now = run.started_at;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!bypassCooldown && cooldownMinutes > 0) {
        const cutoff = new Date(Date.parse(now) - cooldownMinutes * 60_000).toISOString();
        const recent = db
          .prepare('SELECT id FROM rule_runs WHERE rule_id = ? AND cooldown_key = ? AND started_at > ? LIMIT 1')
          .get(run.rule_id, run.cooldown_key, cutoff);
        if (recent) throw new ReservationError('cooldown', 'cooldown active (pass force=true to bypass)');
      }

      if (dedupeKey) {
        const duplicate = db.prepare('SELECT id FROM automation_jobs WHERE dedupe_key = ?').get(dedupeKey);
        if (duplicate) throw new ReservationError('duplicate', 'duplicate rule trigger');
      }

      db.prepare(
        `INSERT INTO rule_runs
          (id, rule_id, trigger, pr_id, workspace_id, session_id, cooldown_key, status, error, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, NULL)`,
      ).run(
        run.id,
        run.rule_id,
        run.trigger,
        run.pr_id,
        run.workspace_id,
        run.session_id,
        run.cooldown_key,
        run.started_at,
      );
      db.prepare(
        `INSERT INTO automation_jobs (id, payload, status, attempts, created_at, updated_at, dedupe_key)
         VALUES (?, ?, 'queued', 0, ?, ?, ?)`,
      ).run(run.id, JSON.stringify(payload), now, now, dedupeKey);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    let resolveCompletion;
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });
    this.#completions.set(run.id, resolveCompletion);
    this.#onUpdate(run);
    this.#schedulePump();
    return { run, completion };
  }

  #schedulePump() {
    if (!this.#accepting || this.#pumping) return;
    this.#pumping = true;
    queueMicrotask(() => {
      this.#pumping = false;
      this.#pump();
    });
  }

  #pump() {
    if (!this.#accepting) return;
    const db = this.#getDb();
    while (this.#running < this.#concurrency) {
      const job = db
        .prepare("SELECT id, payload FROM automation_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1")
        .get();
      if (!job) break;
      const claimed = db
        .prepare(
          "UPDATE automation_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .run(new Date().toISOString(), job.id);
      if (claimed.changes === 0) continue;
      this.#running++;
      this.#run(job)
        .catch((error) => {
          // #run settles the completion itself; this only guards the process
          // against an unhandled rejection from a bug in the finalization path.
          console.error(`[rules] automation job ${job.id} failed to finalize: ${error?.message ?? error}`);
        })
        .finally(() => {
          this.#running--;
          this.#schedulePump();
        });
    }
  }

  async #run(job) {
    const db = this.#getDb();
    let error = null;
    try {
      const payload = JSON.parse(job.payload);
      const run = db.prepare('SELECT * FROM rule_runs WHERE id = ?').get(job.id);
      await this.#execute(payload, run);
    } catch (caught) {
      error = caught?.message || String(caught);
    }

    const endedAt = new Date().toISOString();
    let status = error ? 'error' : 'success';
    let finalRun;
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE rule_runs SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(
          status,
          error,
          endedAt,
          job.id,
        );
        db.prepare("UPDATE automation_jobs SET status = 'done', updated_at = ? WHERE id = ?").run(endedAt, job.id);
        db.exec('COMMIT');
      } catch (updateError) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The transaction never opened or the connection is gone; nothing to roll back.
        }
        throw updateError;
      }
      finalRun = db.prepare('SELECT * FROM rule_runs WHERE id = ?').get(job.id);
    } catch (updateError) {
      // The run finished but its outcome could not be persisted. Report the
      // failure to the waiter instead of leaving the completion pending and
      // letting the rejection escape #pump.
      status = 'error';
      const message = `failed to record run outcome: ${updateError?.message ?? updateError}`;
      console.error(`[rules] automation job ${job.id} ${message}`);
      finalRun = { id: job.id, status, error: error ? `${error}; ${message}` : message, ended_at: endedAt };
    }

    this.#onUpdate(finalRun);
    const resolve = this.#completions.get(job.id);
    if (resolve) {
      this.#completions.delete(job.id);
      resolve(finalRun);
    }
  }
}

export { ReservationError };
