import { bootstrap } from '../../shared/bootstrap.js';
import { createNotificationService } from './service.js';

await bootstrap({ name: 'notification-service', build: async ({ store, bus }) => [createNotificationService({ store, bus })] });
