import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSecurityPolicy, isLoopbackAddress, isLoopbackHost, isOriginAllowed } from './security.js';

test('loopback hosts and IPv4-mapped loopback addresses are recognized', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
});

test('non-loopback binding requires an authentication token', () => {
  assert.throws(
    () => createSecurityPolicy({ host: '0.0.0.0', security: {} }, {}),
    /Refusing to bind.*without authentication/,
  );
});

test('remote policy accepts bearer, query, or cookie tokens but exempts loopback callers', () => {
  const policy = createSecurityPolicy({ host: '0.0.0.0', security: { auth_token: 'a-secure-test-token' } }, {});
  const remote = (overrides = {}) => ({ ip: '192.0.2.10', headers: {}, query: {}, ...overrides });

  assert.equal(policy.authenticate(remote()), false);
  assert.equal(policy.authenticate(remote({ headers: { authorization: 'Bearer a-secure-test-token' } })), true);
  assert.equal(policy.authenticate(remote({ query: { token: 'a-secure-test-token' } })), true);
  assert.equal(policy.authenticate(remote({ headers: { cookie: 'claude_patrol_token=a-secure-test-token' } })), true);
  assert.equal(policy.authenticate(remote({ headers: { cookie: 'claude_patrol_token=%E0%A4%A' } })), false);
  assert.equal(policy.authenticate({ ip: '127.0.0.1', headers: {}, query: {} }), true);
});

test('origin policy permits same-origin and explicit allowlist entries', () => {
  assert.equal(isOriginAllowed({ headers: { origin: 'http://patrol.test:3000', host: 'patrol.test:3000' } }, []), true);
  assert.equal(
    isOriginAllowed({ headers: { origin: 'https://console.example', host: 'patrol.test:3000' } }, [
      'https://console.example',
    ]),
    true,
  );
  assert.equal(isOriginAllowed({ headers: { origin: 'https://evil.example', host: 'patrol.test:3000' } }, []), false);
});
