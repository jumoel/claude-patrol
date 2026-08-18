import { timingSafeEqual } from 'node:crypto';

const PROTECTED_PREFIXES = ['/api/', '/ws/', '/mcp/'];

export function isLoopbackHost(host) {
  const normalized = String(host ?? '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    normalized.startsWith('127.')
  );
}

export function isLoopbackAddress(address) {
  const normalized = String(address ?? '').toLowerCase();
  return isLoopbackHost(normalized) || normalized.startsWith('::ffff:127.');
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookie(header) {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    try {
      cookies.set(part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // Ignore malformed cookie values instead of turning an authentication
      // failure into an internal server error.
    }
  }
  return cookies;
}

function requestToken(request) {
  const authorization = request.headers?.authorization;
  if (authorization?.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  const queryToken = request.query?.token;
  if (typeof queryToken === 'string') return queryToken;
  return parseCookie(request.headers?.cookie).get('claude_patrol_token') ?? null;
}

export function isProtectedPath(path) {
  return PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function isOriginAllowed(request, allowedOrigins = []) {
  const origin = request.headers?.origin;
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

/**
 * Build the request policy. Loopback binds need no token. Non-loopback binds
 * require a token for remote callers, while same-machine MCP/CLI calls remain
 * compatible through the loopback-address exemption.
 */
export function createSecurityPolicy(config = {}, env = process.env) {
  const host = config.host ?? '127.0.0.1';
  const remoteEnabled = !isLoopbackHost(host);
  const authToken = env.CLAUDE_PATROL_AUTH_TOKEN || config.security?.auth_token || null;
  const allowedOrigins = config.security?.allowed_origins ?? [];

  if (remoteEnabled && !authToken) {
    throw new Error(
      `Refusing to bind to ${host} without authentication. Set CLAUDE_PATROL_AUTH_TOKEN or security.auth_token.`,
    );
  }

  return Object.freeze({
    host,
    remoteEnabled,
    allowedOrigins,
    authenticate(request) {
      if (!remoteEnabled || isLoopbackAddress(request.ip ?? request.socket?.remoteAddress)) return true;
      return safeTokenEqual(requestToken(request), authToken);
    },
    hasValidToken(request) {
      return safeTokenEqual(requestToken(request), authToken);
    },
  });
}

export const AUTH_COOKIE = 'claude_patrol_token';
