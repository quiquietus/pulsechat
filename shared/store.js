// Persistence layer. MongoDB when MONGO_URL is set, otherwise an in-memory
// store with the identical async API. Ids are UUID strings in both.
import { randomUUID } from 'node:crypto';

export async function createStore(mongoUrl, dbName) {
  return mongoUrl ? createMongoStore(mongoUrl, dbName) : createMemoryStore();
}

export const dmRoomId = (a, b) => `dm:${[a, b].sort().join(':')}`;

const publicUser = (u) => u && { id: u._id, username: u.username, createdAt: u.createdAt };
const publicRoom = (r) =>
  r && { id: r._id, type: r.type, name: r.name, members: r.members, createdBy: r.createdBy, createdAt: r.createdAt };
const publicMessage = (m) =>
  m && { id: m._id, roomId: m.roomId, senderId: m.senderId, senderName: m.senderName, text: m.text, createdAt: m.createdAt };
const publicNotification = (n) =>
  n && {
    id: n._id, type: n.type, roomId: n.roomId, messageId: n.messageId,
    from: n.from, preview: n.preview, read: n.read, createdAt: n.createdAt,
  };

const DEFAULT_CHANNELS = ['general', 'random', 'engineering'];

async function createMemoryStore() {
  const users = new Map();
  const rooms = new Map();
  const messages = []; // kept sorted by createdAt (insertion order)
  const messageIds = new Set();
  const notifications = [];

  const store = {
    kind: 'memory',
    users: {
      async create({ username, passwordHash }) {
        const lower = username.toLowerCase();
        for (const u of users.values()) if (u.usernameLower === lower) return null;
        const doc = { _id: randomUUID(), username, usernameLower: lower, passwordHash, createdAt: new Date().toISOString() };
        users.set(doc._id, doc);
        return publicUser(doc);
      },
      async findByUsername(username) {
        const lower = username.toLowerCase();
        for (const u of users.values()) if (u.usernameLower === lower) return { ...publicUser(u), passwordHash: u.passwordHash };
        return null;
      },
      async findById(id) {
        return publicUser(users.get(id));
      },
      async list() {
        return [...users.values()].map(publicUser).sort((a, b) => a.username.localeCompare(b.username));
      },
    },
    rooms: {
      async createChannel({ name, createdBy }) {
        for (const r of rooms.values()) if (r.type === 'channel' && r.name === name) return null;
        const doc = { _id: randomUUID(), type: 'channel', name, members: null, createdBy, createdAt: new Date().toISOString() };
        rooms.set(doc._id, doc);
        return publicRoom(doc);
      },
      async ensureDM(a, b) {
        const id = dmRoomId(a, b);
        if (!rooms.has(id)) {
          rooms.set(id, { _id: id, type: 'dm', name: null, members: [a, b].sort(), createdBy: a, createdAt: new Date().toISOString() });
          return { room: publicRoom(rooms.get(id)), created: true };
        }
        return { room: publicRoom(rooms.get(id)), created: false };
      },
      async findById(id) {
        return publicRoom(rooms.get(id));
      },
      async listForUser(userId) {
        return [...rooms.values()]
          .filter((r) => r.type === 'channel' || r.members.includes(userId))
          .map(publicRoom);
      },
    },
    messages: {
      async insert(msg) {
        if (messageIds.has(msg.id)) return false; // idempotent on redelivery
        messageIds.add(msg.id);
        const { id, ...rest } = msg;
        messages.push({ _id: id, ...rest });
        return true;
      },
      async listByRoom(roomId, { before, limit = 50 } = {}) {
        let list = messages.filter((m) => m.roomId === roomId && (!before || m.createdAt < before));
        list = list.slice(-limit);
        return list.map(publicMessage);
      },
    },
    notifications: {
      async insert(n) {
        const doc = { _id: randomUUID(), read: false, createdAt: new Date().toISOString(), ...n };
        notifications.push(doc);
        return publicNotification(doc);
      },
      async listForUser(userId, limit = 30) {
        return notifications.filter((n) => n.userId === userId).slice(-limit).reverse().map(publicNotification);
      },
      async markRead(userId, ids) {
        for (const n of notifications) if (n.userId === userId && (!ids || ids.includes(n._id))) n.read = true;
      },
    },
    async close() {},
  };
  await seedChannels(store);
  return store;
}

async function createMongoStore(url, dbName) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);
  const Users = db.collection('users');
  const Rooms = db.collection('rooms');
  const Messages = db.collection('messages');
  const Notifications = db.collection('notifications');

  await Promise.all([
    Users.createIndex({ usernameLower: 1 }, { unique: true }),
    Rooms.createIndex({ type: 1, name: 1 }, { unique: true, partialFilterExpression: { type: 'channel' } }),
    Rooms.createIndex({ members: 1 }),
    Messages.createIndex({ roomId: 1, createdAt: -1 }),
    Notifications.createIndex({ userId: 1, createdAt: -1 }),
  ]);

  const isDup = (err) => err?.code === 11000;

  const store = {
    kind: 'mongodb',
    users: {
      async create({ username, passwordHash }) {
        const doc = { _id: randomUUID(), username, usernameLower: username.toLowerCase(), passwordHash, createdAt: new Date().toISOString() };
        try {
          await Users.insertOne(doc);
        } catch (err) {
          if (isDup(err)) return null;
          throw err;
        }
        return publicUser(doc);
      },
      async findByUsername(username) {
        const u = await Users.findOne({ usernameLower: username.toLowerCase() });
        return u && { ...publicUser(u), passwordHash: u.passwordHash };
      },
      async findById(id) {
        return publicUser(await Users.findOne({ _id: id }));
      },
      async list() {
        return (await Users.find().sort({ usernameLower: 1 }).toArray()).map(publicUser);
      },
    },
    rooms: {
      async createChannel({ name, createdBy }) {
        const doc = { _id: randomUUID(), type: 'channel', name, members: null, createdBy, createdAt: new Date().toISOString() };
        try {
          await Rooms.insertOne(doc);
        } catch (err) {
          if (isDup(err)) return null;
          throw err;
        }
        return publicRoom(doc);
      },
      async ensureDM(a, b) {
        const id = dmRoomId(a, b);
        const res = await Rooms.updateOne(
          { _id: id },
          { $setOnInsert: { type: 'dm', name: null, members: [a, b].sort(), createdBy: a, createdAt: new Date().toISOString() } },
          { upsert: true },
        );
        return { room: publicRoom(await Rooms.findOne({ _id: id })), created: res.upsertedCount === 1 };
      },
      async findById(id) {
        return publicRoom(await Rooms.findOne({ _id: id }));
      },
      async listForUser(userId) {
        return (await Rooms.find({ $or: [{ type: 'channel' }, { members: userId }] }).toArray()).map(publicRoom);
      },
    },
    messages: {
      async insert(msg) {
        const { id, ...rest } = msg;
        try {
          await Messages.insertOne({ _id: id, ...rest });
          return true;
        } catch (err) {
          if (isDup(err)) return false;
          throw err;
        }
      },
      async listByRoom(roomId, { before, limit = 50 } = {}) {
        const q = { roomId, ...(before && { createdAt: { $lt: before } }) };
        const list = await Messages.find(q).sort({ createdAt: -1 }).limit(limit).toArray();
        return list.reverse().map(publicMessage);
      },
    },
    notifications: {
      async insert(n) {
        const doc = { _id: randomUUID(), read: false, createdAt: new Date().toISOString(), ...n };
        await Notifications.insertOne(doc);
        return publicNotification(doc);
      },
      async listForUser(userId, limit = 30) {
        return (await Notifications.find({ userId }).sort({ createdAt: -1 }).limit(limit).toArray()).map(publicNotification);
      },
      async markRead(userId, ids) {
        await Notifications.updateMany({ userId, ...(ids && { _id: { $in: ids } }) }, { $set: { read: true } });
      },
    },
    async close() {
      await client.close();
    },
  };
  await seedChannels(store);
  return store;
}

async function seedChannels(store) {
  for (const name of DEFAULT_CHANNELS) await store.rooms.createChannel({ name, createdBy: null });
}
