import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify from 'fastify';
import { appEvents } from './app-events.js';
import { createMcpServer } from './mcp-server.js';
import { pollerEvents } from './poller.js';
import { getSessionStates } from './pty-manager.js';
import { registerCheckRoutes } from './routes/checks.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerPRRoutes } from './routes/prs.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';

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

    const syncHandler = (data) => {
      raw.write(`event: sync\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const localHandler = () => {
      raw.write(`event: local-change\ndata: {}\n\n`);
    };
    const stateHandler = (data) => {
      raw.write(`event: session-state\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const summaryHandler = (data) => {
      raw.write(`event: summary-updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const taskHandler = (data) => {
      raw.write(`event: task-update\ndata: ${JSON.stringify(data)}\n\n`);
    };

    pollerEvents.on('sync', syncHandler);
    appEvents.on('local-change', localHandler);
    appEvents.on('session-state', stateHandler);
    appEvents.on('summary-updated', summaryHandler);
    appEvents.on('task-update', taskHandler);

    // Send current session states so the client doesn't miss events
    // that fired before it connected.
    for (const s of getSessionStates()) {
      raw.write(`event: session-state\ndata: ${JSON.stringify(s)}\n\n`);
    }
    request.raw.on('close', () => {
      pollerEvents.removeListener('sync', syncHandler);
      appEvents.removeListener('local-change', localHandler);
      appEvents.removeListener('session-state', stateHandler);
      appEvents.removeListener('summary-updated', summaryHandler);
      appEvents.removeListener('task-update', taskHandler);
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
