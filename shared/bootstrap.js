// Shared HTTP bootstrap used both by the all-in-one server (server.js) and by
// each service's standalone entry point (services/*/main.js).
import http from 'node:http';
import express from 'express';
import { config } from './config.js';
import { createStore } from './store.js';
import { createBus } from './bus.js';

export async function bootstrap({ name, build, staticDir }) {
  const store = await createStore(config.mongoUrl, config.mongoDb);
  const bus = await createBus(config.amqpUrl);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  const httpServer = http.createServer(app);
  const services = await build({ store, bus, httpServer, config });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: name, store: store.kind, bus: bus.kind, redis: Boolean(config.redisUrl), services: services.map((s) => s.name) });
  });
  for (const s of services) if (s.router) app.use(s.mount, s.router);
  for (const s of services) await s.start?.();

  if (staticDir) {
    app.use(express.static(staticDir, { maxAge: '1h', index: false }));
    app.get(/^\/(?!api|socket\.io).*/, (_req, res) => res.sendFile('index.html', { root: staticDir }));
  }

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    console.error(`[${name}]`, err);
    res.status(500).json({ error: 'Internal server error' });
  });

  await new Promise((resolve) => httpServer.listen(config.port, resolve));
  console.log(`[${name}] listening on :${config.port} (store=${store.kind}, bus=${bus.kind}, redis=${Boolean(config.redisUrl)})`);

  const shutdown = async () => {
    httpServer.close();
    await Promise.allSettled([bus.close(), store.close()]);
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  return { app, httpServer, store, bus, services };
}
