import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { getDb } from '../db.js';

const execFile = promisify(execFileCb);

/**
 * Register check-related routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerCheckRoutes(app) {
  app.post('/api/checks/retrigger', async (request, reply) => {
    const { pr_id } = request.body;
    if (!pr_id) {
      return reply.code(400).send({ error: 'pr_id is required' });
    }

    const db = getDb();
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(pr_id);
    if (!row) {
      return reply.code(404).send({ error: 'PR not found' });
    }

    const checks = JSON.parse(row.checks);
    const failed = checks.filter(c =>
      c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'TIMED_OUT'
    );

    if (failed.length === 0) {
      return { ok: true, retriggered: 0 };
    }

    // Extract unique run IDs from check URLs
    const runIds = new Set();
    for (const check of failed) {
      if (!check.url) continue;
      const match = check.url.match(/\/actions\/runs\/(\d+)/);
      if (match) runIds.add(match[1]);
    }

    const results = [];
    for (const runId of runIds) {
      try {
        await execFile('gh', [
          'run', 'rerun', runId,
          '--failed',
          '--repo', `${row.org}/${row.repo}`,
        ]);
        results.push({ run_id: runId, status: 'retriggered' });
      } catch (err) {
        results.push({ run_id: runId, status: 'error', message: err.stderr || err.message });
      }
    }

    return { ok: true, retriggered: results.length, results };
  });
}
