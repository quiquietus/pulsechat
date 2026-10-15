import { bootstrap } from '../../shared/bootstrap.js';
import { createChatService } from './service.js';

await bootstrap({ name: 'chat-service', build: async ({ store, bus }) => [createChatService({ store, bus })] });
