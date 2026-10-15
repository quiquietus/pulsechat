// All-in-one mode: runs the four services in one process and serves the built
// React client. Used for single-container hosting; for the split deployment
// see docker-compose.yml, which runs each service on its own behind Nginx.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from './shared/bootstrap.js';
import { createAuthService } from './services/auth/service.js';
import { createChatService } from './services/chat/service.js';
import { createNotificationService } from './services/notification/service.js';
import { createWsService } from './services/ws/service.js';

const root = path.dirname(fileURLToPath(import.meta.url));

await bootstrap({
  name: 'pulsechat',
  staticDir: path.join(root, 'client', 'dist'),
  build: async ({ store, bus, httpServer, config }) => [
    createAuthService({ store }),
    // Notifications are mounted before chat: chat's router guards all of /api.
    createNotificationService({ store, bus }),
    createChatService({ store, bus }),
    await createWsService({ store, bus, httpServer, redisUrl: config.redisUrl, corsOrigin: config.corsOrigin }),
  ],
});
