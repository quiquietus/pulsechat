// Chat service: rooms, users directory and message history. Messages are
// persisted asynchronously by consuming `message.created` from the bus, so
// real-time delivery never waits on a database write.
import express from 'express';
import { requireAuth, asyncRoute } from '../../shared/auth.js';
import { Events } from '../../shared/bus.js';

const CHANNEL_RE = /^[a-z0-9-]{2,24}$/;

export function createChatService({ store, bus }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get('/users', asyncRoute(async (_req, res) => {
    res.json({ users: await store.users.list() });
  }));

  router.get('/rooms', asyncRoute(async (req, res) => {
    res.json({ rooms: await store.rooms.listForUser(req.user.id) });
  }));

  router.post('/rooms', asyncRoute(async (req, res) => {
    const name = String(req.body?.name || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (!CHANNEL_RE.test(name)) {
      return res.status(400).json({ error: 'Channel names are 2-24 lowercase letters, numbers or dashes' });
    }
    const room = await store.rooms.createChannel({ name, createdBy: req.user.id });
    if (!room) return res.status(409).json({ error: 'A channel with that name already exists' });
    await bus.publish(Events.RoomCreated, room);
    res.status(201).json({ room });
  }));

  router.post('/rooms/dm', asyncRoute(async (req, res) => {
    const otherId = req.body?.userId;
    if (!otherId || otherId === req.user.id) return res.status(400).json({ error: 'Pick another user' });
    if (!(await store.users.findById(otherId))) return res.status(404).json({ error: 'User not found' });
    const { room, created } = await store.rooms.ensureDM(req.user.id, otherId);
    if (created) await bus.publish(Events.RoomCreated, room);
    res.status(created ? 201 : 200).json({ room });
  }));

  router.get('/rooms/:roomId/messages', asyncRoute(async (req, res) => {
    const room = await store.rooms.findById(req.params.roomId);
    if (!room || (room.type === 'dm' && !room.members.includes(req.user.id))) {
      return res.status(404).json({ error: 'Room not found' });
    }
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const messages = await store.messages.listByRoom(room.id, { before: req.query.before, limit });
    res.json({ messages });
  }));

  async function start() {
    await bus.subscribe('chat-service', Events.MessageCreated, async (msg) => {
      await store.messages.insert(msg);
    });
  }

  return { name: 'chat', mount: '/api', router, start };
}
