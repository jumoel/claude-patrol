import { randomUUID } from 'node:crypto';
import { appEvents } from './app-events.js';

/**
 * In-memory registry of long-running async operations (workspace destroy,
 * future: workspace create, summary generation, etc). Surfaces them in the
 * UI so users see what's still running in the background and any warnings
 * that came back.
 *
 * Tasks are not persisted - on restart, the slate is empty. That's fine
 * because tasks are observability-only; the underlying ops complete
 * regardless of whether anyone is watching.
 */

const MAX_TASKS = 50;
const COMPLETED_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, Task>} */
const tasks = new Map();

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} kind - dot-namespaced kind, e.g. 'workspace.destroy'
 * @property {string} label - short human-readable label
 * @property {'running' | 'success' | 'warning' | 'error'} status
 * @property {string} startedAt - ISO timestamp
 * @property {string | null} endedAt - ISO timestamp when finished
 * @property {string[]} warnings - non-fatal issues collected during the run
 * @property {string | null} error - fatal error message, if any
 * @property {object | null} context - free-form bag, e.g. { workspaceId, prId, repo }
 */

function pruneIfNeeded() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.endedAt && now - new Date(t.endedAt).getTime() > COMPLETED_TTL_MS) {
      tasks.delete(id);
    }
  }
  if (tasks.size <= MAX_TASKS) return;

  const completed = [...tasks.values()]
    .filter((t) => t.endedAt)
    .sort((a, b) => new Date(a.endedAt) - new Date(b.endedAt));
  while (tasks.size > MAX_TASKS && completed.length > 0) {
    tasks.delete(completed.shift().id);
  }
}

/**
 * Create and register a new running task.
 * @param {{ kind: string, label: string, context?: object | null }} opts
 * @returns {Task}
 */
export function createTask({ kind, label, context = null }) {
  /** @type {Task} */
  const task = {
    id: randomUUID(),
    kind,
    label,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    warnings: [],
    error: null,
    context,
  };
  tasks.set(task.id, task);
  appEvents.emit('task-update', task);
  return task;
}

/**
 * Mark a task as finished. Status is derived: error wins, then warnings, else success.
 * @param {string} id
 * @param {{ error?: string | null, warnings?: string[] }} [opts]
 */
export function completeTask(id, { error = null, warnings = [] } = {}) {
  const task = tasks.get(id);
  if (!task) return;
  task.endedAt = new Date().toISOString();
  if (warnings.length) task.warnings.push(...warnings);
  if (error) {
    task.status = 'error';
    task.error = error;
  } else if (task.warnings.length > 0) {
    task.status = 'warning';
  } else {
    task.status = 'success';
  }
  appEvents.emit('task-update', task);
  pruneIfNeeded();
}

/**
 * Snapshot of all known tasks, running first, then most recent completed.
 * @returns {Task[]}
 */
export function listTasks() {
  pruneIfNeeded();
  return [...tasks.values()].sort((a, b) => {
    if (!a.endedAt && b.endedAt) return -1;
    if (a.endedAt && !b.endedAt) return 1;
    return new Date(b.startedAt) - new Date(a.startedAt);
  });
}

/**
 * Run an async function as a tracked task. If `fn` resolves to `{ warnings: string[] }`,
 * those warnings are folded into the task. Throws are surfaced as task errors.
 * @template T
 * @param {{ kind: string, label: string, context?: object | null }} opts
 * @param {(task: Task) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runTask(opts, fn) {
  const task = createTask(opts);
  try {
    const result = await fn(task);
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    completeTask(task.id, { warnings });
    return result;
  } catch (err) {
    completeTask(task.id, { error: err.message });
    throw err;
  }
}
