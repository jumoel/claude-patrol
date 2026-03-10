import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { pollerEvents } from './poller.js';
import { registerPRRoutes } from './routes/prs.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerConfigRoutes } from './routes/config.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerCheckRoutes } from './routes/checks.js';

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

  // SSE endpoint for live updates
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const handler = (data) => {
      reply.raw.write(`event: sync\ndata: ${JSON.stringify(data)}\n\n`);
    };

    pollerEvents.on('sync', handler);
    request.raw.on('close', () => {
      pollerEvents.removeListener('sync', handler);
    });
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
