// End-to-end test against a running server (all-in-one mode by default).
// Starts server.js on a random port unless BASE_URL is given.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';

let BASE = process.env.BASE_URL;
let server;

before(async () => {
  if (BASE) return;
  const port = 40000 + Math.floor(Math.random() * 10000);
  BASE = `http://localhost:${port}`;
  server = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(port) }, stdio: 'pipe' });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => d.toString().includes('listening') && resolve());
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});
after(() => server?.kill());

const api = async (path, { token, body, method } = {}) => {
  const res = await fetch(BASE + path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
};
const once = (socket, event, pred = () => true, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const h = (p) => { if (pred(p)) { clearTimeout(t); socket.off(event, h); resolve(p); } };
    socket.on(event, h);
  });
const connect = (token) => {
  const s = io(BASE, { auth: { token }, transports: ['websocket'] });
  return new Promise((resolve, reject) => { s.once('connect', () => resolve(s)); s.once('connect_error', reject); });
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('full chat flow', async () => {
  const suffix = Date.now().toString(36).slice(-6);
  const a = await api('/api/auth/register', { body: { username: `alice_${suffix}`, password: 'secret123' } });
  const b = await api('/api/auth/register', { body: { username: `bob_${suffix}`, password: 'secret123' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  assert.equal((await api('/api/auth/register', { body: { username: `ALICE_${suffix}`, password: 'secret123' } })).status, 409);
  assert.equal((await api('/api/auth/login', { body: { username: `alice_${suffix}`, password: 'nope123' } })).status, 401);
  assert.equal((await api('/api/rooms')).status, 401);
  const login = await api('/api/auth/login', { body: { username: `alice_${suffix}`, password: 'secret123' } });
  assert.equal(login.status, 200);

  const rooms = (await api('/api/rooms', { token: a.data.token })).data.rooms;
  const general = rooms.find((r) => r.name === 'general');
  assert.ok(general);

  const sa = await connect(a.data.token);
  const bobOnline = once(sa, 'presence', (p) => p.userId === b.data.user.id && p.online);
  const sb = await connect(b.data.token);
  await bobOnline;
  await sleep(100);

  // Channel message + typing + @mention notification
  const typing = once(sa, 'typing', (p) => p.roomId === general.id);
  sb.emit('typing', { roomId: general.id, isTyping: true });
  assert.equal((await typing).username, `bob_${suffix}`);

  const received = once(sb, 'message:new', (m) => m.roomId === general.id);
  const mention = once(sb, 'notification', (n) => n.type === 'mention');
  const ack = await sa.emitWithAck('message:send', { roomId: general.id, text: `hey @bob_${suffix}!`, clientId: 'c1' });
  assert.ok(ack.ok);
  assert.equal((await received).text, `hey @bob_${suffix}!`);
  assert.match((await mention).preview, /#general/);

  // Direct message: room is created, both sockets join it, recipient is notified
  const dmNew = once(sb, 'room:new', (r) => r.type === 'dm');
  const dm = await api('/api/rooms/dm', { token: a.data.token, body: { userId: b.data.user.id } });
  assert.equal(dm.status, 201);
  await dmNew;
  const dmMsg = once(sb, 'message:new', (m) => m.roomId === dm.data.room.id);
  const dmNotif = once(sb, 'notification', (n) => n.type === 'dm');
  assert.ok((await sa.emitWithAck('message:send', { roomId: dm.data.room.id, text: 'private hello' })).ok);
  await dmMsg;
  assert.equal((await dmNotif).from, `alice_${suffix}`);

  // A third user cannot read or post into the DM
  const c = await api('/api/auth/register', { body: { username: `carol_${suffix}`, password: 'secret123' } });
  assert.equal((await api(`/api/rooms/${dm.data.room.id}/messages`, { token: c.data.token })).status, 404);
  const sc = await connect(c.data.token);
  assert.ok((await sc.emitWithAck('message:send', { roomId: dm.data.room.id, text: 'intrude' })).error);

  // Persistence happened asynchronously via the bus
  await sleep(200);
  const hist = await api(`/api/rooms/${dm.data.room.id}/messages`, { token: b.data.token });
  assert.deepEqual(hist.data.messages.map((m) => m.text), ['private hello']);
  const notifs = await api('/api/notifications', { token: b.data.token });
  assert.equal(notifs.data.notifications.length, 2);
  await api('/api/notifications/read', { token: b.data.token, body: {} });
  assert.ok((await api('/api/notifications', { token: b.data.token })).data.notifications.every((n) => n.read));

  // New channel is pushed to everyone
  const chNew = once(sc, 'room:new', (r) => r.name === `ch-${suffix}`);
  assert.equal((await api('/api/rooms', { token: a.data.token, body: { name: `ch-${suffix}` } })).status, 201);
  await chNew;

  // Presence: offline after disconnect
  const bobOffline = once(sa, 'presence', (p) => p.userId === b.data.user.id && !p.online);
  sb.disconnect();
  await bobOffline;

  sa.disconnect();
  sc.disconnect();
});
