// Notification service: turns chat events into notifications (direct messages
// and @mentions), stores them, and announces them on the bus so the WebSocket
// service can push them to connected users.
import express from 'express';
import { requireAuth, asyncRoute } from '../../shared/auth.js';
import { Events } from '../../shared/bus.js';

const MENTION_RE = /@([a-zA-Z0-9_]{3,20})/g;

export function createNotificationService({ store, bus }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/', asyncRoute(async (req, res) => {
    res.json({ notifications: await store.notifications.listForUser(req.user.id) });
  }));

  router.post('/read', asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : null;
    await store.notifications.markRead(req.user.id, ids);
    res.json({ ok: true });
  }));

  async function recipientsFor(msg) {
    const room = await store.rooms.findById(msg.roomId);
    if (!room) return [];
    if (room.type === 'dm') {
      return room.members.filter((id) => id !== msg.senderId).map((userId) => ({ userId, type: 'dm', roomName: null }));
    }
    const names = new Set([...msg.text.matchAll(MENTION_RE)].map((m) => m[1].toLowerCase()));
    const out = [];
    for (const name of names) {
      const user = await store.users.findByUsername(name);
      if (user && user.id !== msg.senderId) out.push({ userId: user.id, type: 'mention', roomName: room.name });
    }
    return out;
  }

  async function start() {
    await bus.subscribe('notification-service', Events.MessageCreated, async (msg) => {
      for (const { userId, type, roomName } of await recipientsFor(msg)) {
        const notification = await store.notifications.insert({
          userId,
          type,
          roomId: msg.roomId,
          messageId: msg.id,
          from: msg.senderName,
          preview: (roomName ? `#${roomName}: ` : '') + msg.text.slice(0, 120),
        });
        await bus.publish(Events.NotificationCreated, { userId, notification });
      }
    });
  }

  return { name: 'notification', mount: '/api/notifications', router, start };
}
