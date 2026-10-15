import { bootstrap } from '../../shared/bootstrap.js';
import { createAuthService } from './service.js';

await bootstrap({ name: 'auth-service', build: async ({ store }) => [createAuthService({ store })] });
