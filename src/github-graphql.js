import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 16 * 1024 * 1024;
const ERROR_LIMIT = 256 * 1024;

export class GitHubError extends Error {
  constructor(message, kind, extra = {}) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/** One process attempt. Never parse a truncated response. */
export function graphqlProcess(
  query,
  variables,
  { signal, timeoutMs = 30_000, stdoutLimit = OUTPUT_LIMIT, stderrLimit = ERROR_LIMIT, spawnProcess = spawn } = {},
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GitHubError('GitHub request cancelled', 'cancelled'));
    const child = spawnProcess('gh', ['api', 'graphql', '--input', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure;
    let settled = false;
    const stop = (error) => {
      failure ??= error;
      child.kill('SIGKILL');
    };
    const abort = () => stop(new GitHubError('GitHub request cancelled', 'cancelled'));
    const timer = setTimeout(() => stop(new GitHubError('GitHub request timed out', 'timeout')), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdout.removeListener('data', onOutput);
      child.stderr.removeListener('data', onErrorOutput);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      child.stdin.removeListener('error', onInputError);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const onOutput = (data) => {
      outputBytes += data.length;
      if (outputBytes > stdoutLimit) stop(new GitHubError('GitHub stdout exceeded its limit', 'overflow'));
      else output.push(data);
    };
    const onErrorOutput = (data) => {
      errorBytes += data.length;
      if (errorBytes > stderrLimit) stop(new GitHubError('GitHub stderr exceeded its limit', 'overflow'));
      else errors.push(data);
    };
    const onError = (error) => finish(new GitHubError(error.message, 'process'));
    // EPIPE is expected when gh rejects input and exits. Its response remains authoritative.
    const onInputError = (error) => {
      if (error.code !== 'EPIPE') stop(new GitHubError(error.message, 'process'));
    };
    const onClose = (code) =>
      finish(failure, {
        code,
        stdout: Buffer.concat(output).toString(),
        stderr: Buffer.concat(errors).toString(),
      });
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onErrorOutput);
    child.on('error', onError);
    child.on('close', onClose);
    child.stdin.on('error', onInputError);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(JSON.stringify({ query, variables }));
  });
}

export function withGitHubMetadata(query) {
  const end = query.lastIndexOf('}');
  if (end < 0) throw new GitHubError('Invalid GraphQL operation', 'validation');
  return `${query.slice(0, end)} viewer { id login } rateLimit { cost remaining resetAt } ${query.slice(end)}`;
}

const rateLimited = (text) =>
  /rate.?limit.*exceeded|exceeded.*rate.?limit|RATE_LIMITED|secondary rate limit/i.test(text);
const transient = (text) =>
  /HTTP 50[234]|connection reset|connection refused|TLS handshake timeout|temporary failure|unexpected EOF/i.test(text);

/** Exit status is not a substitute for interpreting the GraphQL envelope. */
export function decodeGraphql({ stdout, stderr, code }) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch {
    if (rateLimited(stderr)) throw new GitHubError(stderr.slice(0, 500), 'rate_limit', { rateLimited: true });
    if (transient(stderr)) throw new GitHubError(stderr.slice(0, 500), 'transient');
    throw new GitHubError(`GitHub returned no valid JSON (exit ${code})`, 'malformed');
  }
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    (result.errors !== undefined && !Array.isArray(result.errors))
  ) {
    throw new GitHubError('Invalid GitHub response envelope', 'malformed');
  }
  const errors = result.errors ?? [];
  if (errors.some((error) => rateLimited(JSON.stringify(error))) || rateLimited(stderr)) {
    throw new GitHubError('GitHub rate limit exceeded', 'rate_limit', { rateLimited: true, envelope: result });
  }
  if (!result.data?.viewer?.id || typeof result.data.viewer.login !== 'string') {
    throw new GitHubError('GitHub response did not identify the authenticated viewer', 'identity');
  }
  if (
    errors.some(
      (error) =>
        !Array.isArray(error?.path) ||
        typeof error.path[0] !== 'string' ||
        ['viewer', 'rateLimit'].includes(error.path[0]) ||
        ['UNAUTHORIZED', 'FORBIDDEN'].includes(error.type),
    )
  ) {
    throw new GitHubError('GitHub returned an unassignable or authorization error', 'graphql', { envelope: result });
  }
  if (code !== 0 && !errors.length)
    throw new GitHubError(`GitHub failed without a GraphQL error (exit ${code})`, 'process');
  return result;
}

export function requireGraphqlRoot(result, root) {
  if (result?.errors?.some((error) => error.path?.[0] === root) || result?.data?.[root] == null) {
    throw new GitHubError(`GitHub did not return a complete ${root} result`, 'graphql');
  }
  return result.data[root];
}

/** Injectable process boundary, shared by background and interactive operations. */
export function createGraphqlTransport({
  run = graphqlProcess,
  pause = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new GitHubError('GitHub request cancelled', 'cancelled'));
      const abort = () => {
        clearTimeout(timer);
        reject(new GitHubError('GitHub request cancelled', 'cancelled'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    }),
} = {}) {
  return async (query, variables = {}, options = {}) => {
    const {
      signal,
      maxAttempts = 3,
      acceptResponse = () => {},
      onAttempt = () => {},
      onTelemetry = () => {},
      onRateLimit = () => {},
    } = options;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      onAttempt();
      try {
        const raw = await run(withGitHubMetadata(query), variables, { signal });
        // Fencing must precede identity changes, quota observations and failure handling.
        acceptResponse();
        let result;
        try {
          result = decodeGraphql(raw);
        } catch (error) {
          if (error.rateLimited) {
            if (error.envelope?.data?.viewer) acceptResponse(error.envelope.data.viewer);
            onTelemetry(error.envelope?.data?.rateLimit ?? null);
            onRateLimit(error);
          }
          throw error;
        }
        acceptResponse(result.data.viewer);
        onTelemetry(result.data.rateLimit ?? null);
        return result;
      } catch (error) {
        acceptResponse();
        if (!['transient', 'timeout'].includes(error.kind) || attempt === maxAttempts) throw error;
        await pause(1000 * 2 ** (attempt - 1), signal);
      }
    }
    throw new GitHubError('No GitHub request attempts allowed', 'budget');
  };
}
