import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { actionRegistry } from './actions.js';

/**
 * Build a configured McpServer with all patrol tools registered.
 * Tools call internal Fastify routes via app.inject() rather than HTTP loopback,
 * so there is no port to capture and no extra process to manage.
 *
 * Per-tool behavior lives in `src/actions.js`. This file is now a thin loop
 * that adapts the registry to the MCP tool surface. Each entry runs through
 * its `mcpHandler` if present, otherwise the simple `dispatch` + optional
 * `transform` path.
 *
 * `ctx` carries per-request information not on the args themselves. Today it
 * holds `callerSessionId`, captured by the route handler from the URL. Tools
 * that need to know who is calling (e.g. self-target checks for inter-session
 * messaging) read it from there. Tools that don't care can ignore it.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ callerSessionId: string | null }} [ctx]
 * @returns {McpServer}
 */
export function createMcpServer(app, ctx = { callerSessionId: null }) {
  const server = new McpServer({
    name: 'patrol',
    version: '1.0.0',
  });

  for (const [tool, entry] of Object.entries(actionRegistry)) {
    server.tool(tool, entry.description, entry.schema.shape, async (args) => {
      let result;
      if (entry.mcpHandler) {
        result = await entry.mcpHandler(app, args, ctx);
      } else {
        result = await invokeForMcp(app, entry, args, ctx);
      }
      // Some handlers return raw text via `__text` (transcript summaries).
      if (result && typeof result === 'object' && '__text' in result) {
        return { content: [{ type: 'text', text: result.__text }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    });
  }

  return server;
}

/**
 * MCP-only call path: dispatch + optional transform. Bypasses ruleFireable
 * because MCP tools always work from a Claude session.
 */
async function invokeForMcp(app, entry, args, ctx) {
  const { method, path, body } = entry.dispatch(args, ctx);
  const res = await app.inject({
    method,
    url: path,
    payload: body !== undefined ? JSON.stringify(body) : undefined,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
  });
  if (res.statusCode >= 400) {
    throw new Error(`Patrol API ${res.statusCode}: ${res.body}`);
  }
  const data = res.json();
  return entry.transform ? entry.transform(data) : data;
}
