import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { actionRegistry } from './actions.js';
import { closeDb, getDb, initDb } from './db.js';
import { createMcpServer } from './mcp-server.js';

afterEach(() => closeDb());

/** Connect a client to a server built from a fake Fastify app. */
async function connect(app, ctx) {
  const server = createMcpServer(app, ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

test('every registry action is exposed as an MCP tool with its description', async () => {
  const { client, close } = await connect({ appContext: {}, inject: async () => ({ statusCode: 200 }) });
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, Object.keys(actionRegistry).sort());
    const listPrs = tools.find((tool) => tool.name === 'list_prs');
    assert.equal(listPrs.description, actionRegistry.list_prs.description);
    assert.equal(typeof listPrs.inputSchema, 'object');
  } finally {
    await close();
  }
});

test('dispatch-only tools call the internal route and return its JSON; route failures become tool errors', async () => {
  const injected = [];
  const app = {
    appContext: {},
    async inject(request) {
      injected.push(request);
      if (request.url === '/api/sync/trigger') return { statusCode: 200, json: () => ({ ok: true }) };
      return { statusCode: 404, body: '{"error":{"code":"pr_not_found","message":"PR not found"}}' };
    },
  };
  const { client, close } = await connect(app);
  try {
    const sync = await client.callTool({ name: 'trigger_sync', arguments: {} });
    assert.deepEqual(injected[0], { method: 'POST', url: '/api/sync/trigger', payload: undefined, headers: {} });
    assert.deepEqual(JSON.parse(sync.content[0].text), { ok: true });

    const missing = await client.callTool({ name: 'get_pr', arguments: { id: 'acme/widgets#404' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Patrol API 404/);
    assert.equal(injected[1].url, '/api/prs/acme%2Fwidgets%23404');
  } finally {
    await close();
  }
});

test('handler tools receive the caller session id and can answer with plain text', async () => {
  initDb(':memory:');
  getDb()
    .prepare(
      "INSERT INTO sessions (id, name, pid, provider, status, started_at) VALUES ('global-1', 'Planner', 1, 'claude', 'active', '2026-08-27T12:00:00.000Z')",
    )
    .run();
  const app = { appContext: { getDb, getSessionStates: () => [] }, inject: async () => ({ statusCode: 200 }) };
  const { client, close } = await connect(app, { callerSessionId: 'global-1' });
  try {
    const sessions = await client.callTool({ name: 'list_sessions', arguments: {} });
    const rows = JSON.parse(sessions.content[0].text);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, 'global-1');
    assert.equal(rows[0].is_global, true);

    const self = await client.callTool({
      name: 'send_prompt_to_session',
      arguments: { session_id: 'global-1', prompt: 'hello' },
    });
    assert.deepEqual(JSON.parse(self.content[0].text), {
      ok: false,
      error: 'self_target',
      message: 'cannot send prompt to your own session',
    });
  } finally {
    await close();
  }
});
