/**
 * Serialize async work per key. Callers queue behind the previous holder of
 * the same key; a failed holder does not block the next one, and the entry is
 * removed once the last holder settles so the map does not grow.
 *
 * @returns {<T>(key: string, fn: () => Promise<T> | T) => Promise<T>}
 */
export function createKeyedLock() {
  /** @type {Map<string, Promise<unknown>>} */
  const holders = new Map();
  return async function withLock(key, fn) {
    const previous = holders.get(key);
    const current = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // The earlier holder reports its own failure; this caller proceeds.
        }
      }
      return fn();
    })();
    holders.set(key, current);
    try {
      return await current;
    } finally {
      if (holders.get(key) === current) holders.delete(key);
    }
  };
}
