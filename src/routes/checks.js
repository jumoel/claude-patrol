import { getDb } from '../db.js';
import { execFile, isFailedConclusion } from '../utils.js';

const RUN_ID_RE = /\/actions\/runs\/(\d+)/;

/** REST API uses lowercase conclusions; match all failure types. */
const FAILED_JOB_CONCLUSIONS = new Set(['failure', 'error', 'timed_out']);

/**
 * Parse checks JSON from a PR row and return the failed ones.
 * Handles both CheckRun (conclusion-based) and StatusContext (status-based).
 * @param {object} row - PR database row
 * @returns {Array<object>}
 */
function getFailedChecks(row) {
  const checks = JSON.parse(row.checks);
  return checks.filter(c =>
    isFailedConclusion(c.conclusion) ||
    // StatusContext items have conclusion=null but status may indicate failure
    (c.conclusion === null && (c.status === 'FAILURE' || c.status === 'ERROR'))
  );
}

/**
 * Extract unique GitHub Actions run IDs from failed check URLs.
 * @param {Array<{url?: string}>} checks
 * @returns {Set<string>}
 */
function extractRunIds(checks) {
  const runIds = new Set();
  for (const check of checks) {
    if (!check.url) continue;
    const match = check.url.match(RUN_ID_RE);
    if (match) runIds.add(match[1]);
  }
  return runIds;
}

/**
 * Register check-related routes.
 * @param {import('fastify').FastifyInstance} app
 */
export function registerCheckRoutes(app) {
  app.post('/api/checks/retrigger', async (request, reply) => {
    const { pr_id, check_name } = request.body;
    if (!pr_id) {
      return reply.code(400).send({ error: 'pr_id is required' });
    }

    const db = getDb();
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(pr_id);
    if (!row) {
      return reply.code(404).send({ error: 'PR not found' });
    }

    let failed = getFailedChecks(row);

    // Optional: filter to checks matching a name pattern (case-insensitive substring)
    if (check_name) {
      const pattern = check_name.toLowerCase();
      failed = failed.filter(c => c.name.toLowerCase().includes(pattern));
    }

    if (failed.length === 0) {
      return { ok: true, retriggered: 0, matched_checks: [] };
    }

    // Group failed checks by run ID so we can retrigger per-run
    const runToChecks = new Map();
    for (const check of failed) {
      if (!check.url) continue;
      const match = check.url.match(RUN_ID_RE);
      if (!match) continue;
      const runId = match[1];
      if (!runToChecks.has(runId)) runToChecks.set(runId, []);
      runToChecks.get(runId).push(check);
    }

    const results = [];
    for (const [runId, checks] of runToChecks) {
      try {
        // When filtering by name, we need to retrigger specific jobs.
        // gh run rerun --job requires the job ID from the REST API.
        if (check_name) {
          const { stdout: jobsJson } = await execFile('gh', [
            'api', `repos/${row.org}/${row.repo}/actions/runs/${runId}/jobs`,
          ], { timeout: 30_000 });
          const jobsData = JSON.parse(jobsJson);
          const matchedJobs = (jobsData.jobs || []).filter(j =>
            FAILED_JOB_CONCLUSIONS.has(j.conclusion) &&
            checks.some(c => j.name.includes(c.name.split(' / ').pop()))
          );
          for (const job of matchedJobs) {
            try {
              await execFile('gh', [
                'run', 'rerun', runId,
                '--job', String(job.id),
                '--repo', `${row.org}/${row.repo}`,
              ]);
              results.push({ run_id: runId, job_name: job.name, status: 'retriggered' });
            } catch (err) {
              results.push({ run_id: runId, job_name: job.name, status: 'error', message: err.stderr || err.message });
            }
          }
        } else {
          await execFile('gh', [
            'run', 'rerun', runId,
            '--failed',
            '--repo', `${row.org}/${row.repo}`,
          ]);
          results.push({ run_id: runId, status: 'retriggered' });
        }
      } catch (err) {
        results.push({ run_id: runId, status: 'error', message: err.stderr || err.message });
      }
    }

    return {
      ok: true,
      retriggered: results.filter(r => r.status === 'retriggered').length,
      matched_checks: failed.map(c => c.name),
      results,
    };
  });

  app.get('/api/prs/:id/check-logs', async (request, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM prs WHERE id = ?').get(request.params.id);
    if (!row) {
      return reply.code(404).send({ error: 'PR not found' });
    }

    const failed = getFailedChecks(row);

    if (failed.length === 0) {
      return { logs: [] };
    }

    const runIds = extractRunIds(failed);

    // Optional filter to a single run
    const filterRunId = request.query.run_id;
    const targetRunIds = filterRunId ? [filterRunId] : [...runIds];

    const logs = [];
    for (const runId of targetRunIds) {
      try {
        // Get failed jobs for this run
        const { stdout: jobsJson } = await execFile('gh', [
          'api', `repos/${row.org}/${row.repo}/actions/runs/${runId}/jobs`,
        ], { timeout: 30_000 });
        const jobsData = JSON.parse(jobsJson);

        // GitHub REST API uses lowercase conclusions (unlike GraphQL which uses uppercase)
        const failedJobs = (jobsData.jobs || []).filter(j =>
          FAILED_JOB_CONCLUSIONS.has(j.conclusion)
        );

        // Fetch logs for all failed jobs in parallel
        const jobResults = await Promise.allSettled(failedJobs.map(async (job) => {
          const failedSteps = (job.steps || [])
            .filter(s => s.conclusion === 'failure')
            .map(s => s.name);

          const { stdout: logText } = await execFile('gh', [
            'api', `repos/${row.org}/${row.repo}/actions/jobs/${job.id}/logs`,
          ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });

          const extracted = extractErrorContext(logText);
          const truncated = extracted.length > 20_000;
          return {
            run_id: runId,
            job_name: job.name,
            failed_steps: failedSteps,
            log: truncated ? extracted.slice(0, 20_000) : extracted,
            truncated,
          };
        }));

        for (let i = 0; i < jobResults.length; i++) {
          const result = jobResults[i];
          if (result.status === 'fulfilled') {
            logs.push(result.value);
          } else {
            logs.push({
              run_id: runId,
              job_name: failedJobs[i].name,
              error: `Failed to fetch job log: ${result.reason.message}`,
            });
          }
        }
      } catch (err) {
        logs.push({
          run_id: runId,
          job_name: 'unknown',
          error: `Failed to fetch run jobs: ${err.message}`,
        });
      }
    }

    return { logs };
  });
}

/**
 * Extract error context from a GitHub Actions job log.
 * Finds ##[error] lines and extracts from the nearest ##[group] marker through the error.
 * @param {string} logText
 * @returns {string}
 */
function extractErrorContext(logText) {
  const lines = logText.split('\n');
  const errorIndices = [];
  const groupIndices = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('##[error]')) {
      errorIndices.push(i);
    }
    if (lines[i].includes('##[group]')) {
      groupIndices.push(i);
    }
  }

  if (errorIndices.length === 0) {
    // No error markers - return last 200 lines as fallback
    return lines.slice(-200).join('\n');
  }

  // For each error line, find the nearest preceding ##[group] marker
  const ranges = [];
  for (const errIdx of errorIndices) {
    let groupStart = 0;
    for (const gIdx of groupIndices) {
      if (gIdx <= errIdx) groupStart = gIdx;
      else break;
    }
    // Take from group start through a few lines past the error
    const end = Math.min(errIdx + 10, lines.length);
    ranges.push([groupStart, end]);
  }

  // Merge overlapping ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    if (ranges[i][0] <= prev[1]) {
      prev[1] = Math.max(prev[1], ranges[i][1]);
    } else {
      merged.push(ranges[i]);
    }
  }

  return merged.map(([start, end]) => lines.slice(start, end).join('\n')).join('\n...\n');
}
