import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pollerEvents } from './poller.js';
import { appEvents } from './app-events.js';
import { registerPRRoutes } from './routes/prs.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerCheckRoutes } from './routes/checks.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerSetupRoutes } from './routes/setup.js';

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
    const idleHandler = (data) => {
      raw.write(`event: session-idle\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const activeHandler = (data) => {
      raw.write(`event: session-active\ndata: ${JSON.stringify(data)}\n\n`);
    };

    pollerEvents.on('sync', syncHandler);
    appEvents.on('local-change', localHandler);
    appEvents.on('session-idle', idleHandler);
    appEvents.on('session-active', activeHandler);
    request.raw.on('close', () => {
      pollerEvents.removeListener('sync', syncHandler);
      appEvents.removeListener('local-change', localHandler);
      appEvents.removeListener('session-idle', idleHandler);
      appEvents.removeListener('session-active', activeHandler);
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
