import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify from 'fastify';
import { appEvents } from './app-events.js';
import { createMcpServer } from './mcp-server.js';
import { getGhRateLimitState, pollerEvents } from './poller.js';
import { getSessionStates } from './pty-manager.js';
import { registerCheckRoutes } from './routes/checks.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerPRRoutes } from './routes/prs.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

// Event types forwarded over the /api/events SSE stream.
// Each entry registers a listener on connect and tears it down on close,
// replacing per-event boilerplate. `payload` is optional - when present it
// transforms (or ignores) the emitter's args before serialization. Today only
// `local-change` uses it, since that event emits a constant `{}` regardless
// of what the producer passes.
const SSE_EVENTS = [
  { name: 'sync', emitter: pollerEvents },
  { name: 'local-change', emitter: appEvents, payload: () => ({}) },
  { name: 'session-state', emitter: appEvents },
  { name: 'task-update', emitter: appEvents },
  { name: 'gh-rate-limit', emitter: appEvents },
  { name: 'rule-run', emitter: appEvents },
];

/**
 * Create and configure the Fastify server.
 * @returns {import('fastify').FastifyInstance}
 */
export async function createServer() {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  registerPRRoutes(app);
  registerSyncRoutes(app);
  registerConfigRoutes(app);
  registerWorkspaceRoutes(app);
  registerSessionRoutes(app);
  registerCheckRoutes(app);
  registerCommentRoutes(app);
  registerSetupRoutes(app);
  registerTaskRoutes(app);
  registerRuleRoutes(app);

  // MCP endpoint - one in-process server shared by all Claude sessions.
  // Stateless transport: each POST creates its own transport instance, but
  // the server itself (and all tool handlers) lives once inside this Fastify
  // app. Tools call routes via app.inject(), so there is no port to capture
  // and no separate child process to babysit.
  app.post('/mcp', async (request, reply) => {
    reply.hijack();
    const mcp = createMcpServer(app);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Tear down on response close (client disconnect), not request close -
    // Fastify drains request.raw before we get here, so 'close' fires
    // immediately on the request stream.
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: `MCP error: ${err.message}` },
            id: null,
          }),
        );
      }
    }
  });

  // SSE endpoint for live updates
  const sseConnections = new Set();
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    sseConnections.add(raw);

    const handlers = SSE_EVENTS.map(({ name, emitter, payload }) => {
      const handler = (data) => {
        const body = payload ? payload(data) : data;
        raw.write(`event: ${name}\ndata: ${JSON.stringify(body ?? {})}\n\n`);
      };
      emitter.on(name, handler);
      return { name, emitter, handler };
    });

    // Send current session states so the client doesn't miss events
    // that fired before it connected.
    for (const s of getSessionStates()) {
      raw.write(`event: session-state\ndata: ${JSON.stringify(s)}\n\n`);
    }
    // Replay current gh rate-limit state so a fresh tab knows it's throttled.
    raw.write(`event: gh-rate-limit\ndata: ${JSON.stringify(getGhRateLimitState())}\n\n`);
    request.raw.on('close', () => {
      for (const { name, emitter, handler } of handlers) {
        emitter.removeListener(name, handler);
      }
      sseConnections.delete(raw);
    });
  });

  // Expose a method to close all hijacked SSE connections so server.close() can finish
  app.decorate('closeSSE', () => {
    for (const conn of sseConnections) {
      conn.end();
    }
    sseConnections.clear();
  });

  // Serve frontend build if it exists
  const distPath = resolve(import.meta.dirname, '..', 'frontend', 'dist');
  if (existsSync(distPath)) {
    await app.register(fastifyStatic, { root: distPath, prefix: '/' });
    // SPA fallback - serve index.html for non-API routes
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.url.startsWith('/ws/')) {
        reply.code(404).send({ error: 'Not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  return app;
}
