import { existsSync } from 'node:fs';
import { getDb } from './db.js';

/**
 * Run health checks: verify sessions are alive, workspaces exist.
 */
function runHealthCheck() {
  const db = getDb();
  const now = new Date().toISOString();

  // Check active sessions have live PIDs
  const sessions = db.prepare("SELECT * FROM sessions WHERE status = 'active'").all();
  for (const session of sessions) {
    if (session.pid) {
      try {
        process.kill(session.pid, 0);
      } catch {
        db.prepare("UPDATE sessions SET status = 'killed', ended_at = ? WHERE id = ?").run(now, session.id);
        console.log(`[health] Marked dead session ${session.id} (pid ${session.pid}) as killed`);
      }
    }
  }

  // Check active workspaces have existing directories
  const workspaces = db.prepare("SELECT * FROM workspaces WHERE status = 'active'").all();
  for (const ws of workspaces) {
    if (!existsSync(ws.path)) {
      db.prepare("UPDATE workspaces SET status = 'destroyed', destroyed_at = ? WHERE id = ?").run(now, ws.id);
      console.log(`[health] Marked missing workspace ${ws.name} as destroyed`);
    }
  }
}

/** @type {ReturnType<typeof setInterval> | null} */
let healthInterval = null;

/**
 * Start periodic health checks.
 * @param {number} intervalMs - check interval in milliseconds (default 60s)
 */
export function startHealthChecks(intervalMs = 60_000) {
  stopHealthChecks();
  runHealthCheck();
  healthInterval = setInterval(runHealthCheck, intervalMs);
}

/**
 * Stop health checks.
 */
export function stopHealthChecks() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}
