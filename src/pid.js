import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { pidPath } from './paths.js';

/**
 * Write PID file with server metadata.
 * @param {number} port - actual port the server bound to
 */
export function writePid(port) {
  const data = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(pidPath(), JSON.stringify(data, null, 2));
}

/**
 * Read and parse PID file. Returns null if missing or malformed.
 * @returns {{ pid: number, port: number, startedAt: string } | null}
 */
export function readPid() {
  try {
    const raw = readFileSync(pidPath(), 'utf8');
    const data = JSON.parse(raw);
    if (typeof data.pid !== 'number' || typeof data.port !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

/** Remove PID file. */
export function removePid() {
  try {
    unlinkSync(pidPath());
  } catch {
    // already gone
  }
}

/**
 * Check if the server is currently running.
 * @returns {{ running: boolean, pid?: number, port?: number, startedAt?: string }}
 */
export function isRunning() {
  const data = readPid();
  if (!data) return { running: false };

  try {
    process.kill(data.pid, 0);
    return { running: true, pid: data.pid, port: data.port, startedAt: data.startedAt };
  } catch {
    // Process not running - stale PID file
    removePid();
    return { running: false };
  }
}
