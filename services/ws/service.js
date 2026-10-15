// WebSocket service: Socket.IO gateway for real-time delivery, presence and
// typing indicators. A new message is broadcast to the room immediately and
// published to the bus; persistence and notifications happen downstream.
// With REDIS_URL set, the Redis adapter fans events out across instances.
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { verifyToken } from '../../shared/auth.js';
import { Events } from '../../shared/bus.js';
import { createPresence } from '../../shared/presence.js';

const MAX_MESSAGE = 2000;
const userRoom = (id) => `user:${id}`;

export async function createWsService({ store, bus, httpServer, redisUrl, corsOrigin }) {
  const io = new Server(httpServer, { cors: { origin: corsOrigin } });

  let presenceClient = null;
  if (redisUrl) {
    const { createClient } = await import('redis');
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const pub = createClient({ url: redisUrl });
    const sub = pub.duplicate();
    presenceClient = pub.duplicate();
    for (const c of [pub, sub, presenceClient]) c.on('error', (err) => console.error('[redis]', err.message));
    await Promise.all([pub.connect(), sub.connect(), presenceClient.connect()]);
    io.adapter(createAdapter(pub, sub));
    console.log('[ws] using Redis adapter');
  }
  const presence = createPresence(presenceClient);

  io.use((socket, next) => {
    try {
      socket.data.user = verifyToken(socket.handshake.auth?.token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  async function canAccess(roomId, userId) {
    const room = await store.rooms.findById(roomId);
    if (!room) return null;
    if (room.type === 'dm' && !room.members.includes(userId)) return null;
    return room;
  }

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(userRoom(user.id));

    // Handlers are registered synchronously so nothing the client sends right
    // after connecting is lost while the async setup below runs.
    const ready = (async () => {
      const rooms = await store.rooms.listForUser(user.id);
      socket.join(rooms.map((r) => r.id));
      if (await presence.connect(user.id)) io.emit('presence', { userId: user.id, online: true });
      socket.emit('presence:list', { online: await presence.online() });
    })().catch((err) => {
      console.error('[ws] connection setup failed', err);
      socket.disconnect(true);
    });

    socket.on('message:send', async (payload, ack = () => {}) => {
      try {
        const text = String(payload?.text || '').trim();
        if (!text) return ack({ error: 'Message is empty' });
        if (text.length > MAX_MESSAGE) return ack({ error: `Messages are limited to ${MAX_MESSAGE} characters` });
        const room = await canAccess(payload?.roomId, user.id);
        if (!room) return ack({ error: 'Room not found' });

        const message = {
          id: randomUUID(),
          roomId: room.id,
          senderId: user.id,
          senderName: user.username,
          text,
          createdAt: new Date().toISOString(),
        };
        io.to(room.id).emit('message:new', { ...message, clientId: payload.clientId });
        ack({ ok: true, message });
        await bus.publish(Events.MessageCreated, message);
      } catch (err) {
        console.error('[ws] message:send failed', err);
        ack({ error: 'Could not send message' });
      }
    });

    socket.on('typing', async (payload) => {
      const roomId = payload?.roomId;
      if (typeof roomId !== 'string' || !socket.rooms.has(roomId)) return;
      socket.to(roomId).emit('typing', { roomId, userId: user.id, username: user.username, isTyping: Boolean(payload.isTyping) });
    });

    socket.on('disconnect', async () => {
      await ready; // never decrement before the matching increment
      if (await presence.disconnect(user.id)) io.emit('presence', { userId: user.id, online: false });
    });
  });

  async function start() {
    // WS instances share one consumer group: a single instance handles each
    // event and the Redis adapter fans the emit out to every instance.
    // New rooms: put the right sockets in them.
    await bus.subscribe('ws-service', Events.RoomCreated, async (room) => {
      if (room.type === 'channel') {
        io.socketsJoin(room.id);
        io.emit('room:new', room);
      } else {
        for (const id of room.members) {
          io.in(userRoom(id)).socketsJoin(room.id);
          io.to(userRoom(id)).emit('room:new', room);
        }
      }
    });
    await bus.subscribe('ws-service', Events.NotificationCreated, async ({ userId, notification }) => {
      io.to(userRoom(userId)).emit('notification', notification);
    });
  }

  return { name: 'ws', io, start };
}
