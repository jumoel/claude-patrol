/**
 * Orders in-process observations without making polling timestamps part of
 * acknowledgement versions. Database tokens separately guard content writes.
 */
export class PrReadFence {
  #sequence = 0;
  #generation = 0;
  #active = new Set();
  #accepted = new Map();

  begin() {
    const read = { sequence: ++this.#sequence, generation: this.#generation };
    this.#active.add(read);
    return read;
  }

  current(read) {
    return this.#active.has(read) && read.generation === this.#generation;
  }

  accepts(read, key) {
    return this.current(read) && (this.#accepted.get(key) ?? 0) <= read.sequence;
  }

  /** Call after the corresponding SQLite commit, including no-ops/removals. */
  accept(read, keys) {
    if (!this.current(read)) return;
    for (const key of keys) this.#accepted.set(key, Math.max(this.#accepted.get(key) ?? 0, read.sequence));
  }

  end(read) {
    this.#active.delete(read);
    const oldest = Math.min(...Array.from(this.#active, (entry) => entry.sequence));
    for (const [key, sequence] of this.#accepted) {
      if (sequence < oldest) this.#accepted.delete(key);
    }
  }

  invalidate() {
    this.#generation++;
    this.#active.clear();
    this.#accepted.clear();
  }
}
