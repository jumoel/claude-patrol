import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_INTERVAL_MS = 300;

/**
 * Snapshot JavaScript file metadata below a directory without opening
 * persistent filesystem watchers.
 *
 * @param {string} root
 * @returns {Map<string, string>}
 */
export function snapshotJavaScriptFiles(root) {
  const snapshot = new Map();

  /** @param {string} directory @param {string} relativeDirectory */
  function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        try {
          const stats = statSync(absolutePath, { bigint: true });
          snapshot.set(relativePath, `${stats.mtimeNs}:${stats.size}`);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error;
        }
      }
    }
  }

  visit(root, '');
  return snapshot;
}

/**
 * Poll JavaScript metadata so watch mode remains usable when macOS refuses
 * directory watchers with EMFILE.
 *
 * @param {string} root
 * @param {(relativePath: string) => void} onChange
 * @param {{intervalMs?: number}} [options]
 */
export function createJavaScriptChangePoller(root, onChange, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  let previous = snapshotJavaScriptFiles(root);

  function poll() {
    const current = snapshotJavaScriptFiles(root);
    const paths = new Set([...previous.keys(), ...current.keys()]);
    for (const path of paths) {
      if (previous.get(path) !== current.get(path)) onChange(path);
    }
    previous = current;
  }

  const timer = setInterval(poll, intervalMs);

  return {
    poll,
    close() {
      clearInterval(timer);
    },
  };
}
