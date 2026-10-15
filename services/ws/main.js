import { bootstrap } from '../../shared/bootstrap.js';
import { createWsService } from './service.js';

await bootstrap({
  name: 'ws-service',
  build: async ({ store, bus, httpServer, config }) => [
    await createWsService({ store, bus, httpServer, redisUrl: config.redisUrl, corsOrigin: config.corsOrigin }),
  ],
});
