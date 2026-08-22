import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify from 'fastify';
import { createAppContext } from './app-context.js';
import { createMcpServer } from './mcp-server.js';
import { registerCheckRoutes } from './routes/checks.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerPeerReviewRoutes } from './routes/peer-reviews.js';
import { registerPRRoutes } from './routes/prs.js';
import { registerRuleRoutes } from './routes/rules.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerWorkItemRoutes } from './routes/work-items.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { AUTH_COOKIE, createSecurityPolicy, isOriginAllowed, isProtectedPath } from './security.js';

// Event types forwarded over the /api/events SSE stream.
// Each entry registers a listener on connect and tears it down on close,
// replacing per-event boilerplate. `payload` is optional - when present it
// transforms (or ignores) the emitter's args before serialization. Today only
// `local-change` uses it, since that event emits a constant `{}` regardless
// of what the producer passes.
function sseEvents(context) {
  return [
    { name: 'sync', emitter: context.pollerEvents },
    { name: 'local-change', emitter: context.appEvents, payload: () => ({}) },
    { name: 'session-state', emitter: context.appEvents },
    { name: 'task-update', emitter: context.appEvents },
    { name: 'gh-rate-limit', emitter: context.appEvents },
    { name: 'rule-run', emitter: context.appEvents },
    { name: 'peer-review-state', emitter: context.appEvents },
  ];
}

/**
 * Create and configure the Fastify server.
 * @returns {import('fastify').FastifyInstance}
 */
export async function createServer(options = {}) {
  const context = options.context ?? createAppContext();
  const config = options.config ?? context.getConfig?.() ?? {};
  const security = options.securityPolicy ?? createSecurityPolicy(config);
  const app = Fastify({ logger: false });
  app.decorate('appContext', context);
  if (!options.context) {
    for (const capability of Object.values(context.providerCapabilities)) capability.start();
  }

  await app.register(fastifyCors, {
    origin: security.allowedOrigins.length > 0 ? security.allowedOrigins : false,
    credentials: true,
  });
  await app.register(fastifyWebsocket);

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!isOriginAllowed(request, security.allowedOrigins) && isProtectedPath(path)) {
      return reply.code(403).send({ error: 'Origin not allowed' });
    }

    if (typeof request.query?.token === 'string' && security.hasValidToken(request)) {
      reply.header(
        'Set-Cookie',
        `${AUTH_COOKIE}=${encodeURIComponent(request.query?.token ?? '')}; HttpOnly; SameSite=Strict; Path=/`,
      );
    }

    if (isProtectedPath(path) && !security.authenticate(request)) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
  });

  registerPRRoutes(app);
  registerSyncRoutes(app);
  registerConfigRoutes(app);
  registerWorkspaceRoutes(app);
  registerWorkItemRoutes(app);
  registerSessionRoutes(app);
  registerCheckRoutes(app);
  registerPeerReviewRoutes(app);
  registerCommentRoutes(app);
  registerSetupRoutes(app);
  registerTaskRoutes(app);
  registerRuleRoutes(app);

  // One listener per backend event broadcasts to every browser connection.
  // This keeps EventEmitter listener counts constant as tabs are opened.
  const sseConnections = new Set();
  const broadcastHandlers = sseEvents(context).map(({ name, emitter, payload }) => {
    const handler = (data) => {
      const body = payload ? payload(data) : data;
      const message = `event: ${name}\ndata: ${JSON.stringify(body ?? {})}\n\n`;
      for (const connection of sseConnections) {
        try {
          connection.write(message);
        } catch {
          sseConnections.delete(connection);
        }
      }
    };
    emitter.on(name, handler);
    return { name, emitter, handler };
  });

  // MCP endpoint, scoped per session. The session id in the URL is the
  // server's only trustworthy source of caller identity. Tool handlers that
  // need to know who is calling (self-target checks, etc.) receive it via
  // the McpServer's per-request ctx. The handler is otherwise the same
  // stateless transport pattern: each POST creates its own transport, the
  // server is built per-request, tools call routes via app.inject().
  app.post('/mcp/:sessionId', async (request, reply) => {
    const callerSessionId = request.params.sessionId;
    const session = context
      .getDb()
      .prepare(
        `SELECT s.id
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
         WHERE s.id = ?
           AND s.work_item_id IS NULL
           AND (s.workspace_id IS NULL OR w.work_item_id IS NULL)
           AND s.status IN ('active', 'detached')`,
      )
      .get(callerSessionId);
    if (!session) {
      return reply.code(404).send({ error: 'unknown session' });
    }

    reply.hijack();
    const mcp = createMcpServer(app, { callerSessionId });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Tear down on response close (client disconnect), not request close.
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
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    sseConnections.add(raw);

    // Send current session states so the client doesn't miss events
    // that fired before it connected.
    for (const s of context.getSessionStates()) {
      raw.write(`event: session-state\ndata: ${JSON.stringify(s)}\n\n`);
    }
    // Replay current gh rate-limit state so a fresh tab knows it's throttled.
    raw.write(`event: gh-rate-limit\ndata: ${JSON.stringify(context.getGhRateLimitState())}\n\n`);
    request.raw.on('close', () => {
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

  app.addHook('onClose', async () => {
    for (const { name, emitter, handler } of broadcastHandlers) {
      emitter.removeListener(name, handler);
    }
    context.peerReviewCoordinator.close();
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
