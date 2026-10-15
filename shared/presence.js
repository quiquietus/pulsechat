// Presence tracking. Counts live sockets per user so a user with several tabs
// only goes offline when the last one disconnects. Redis-backed when available
// so every WebSocket instance sees the same picture.
const KEY = 'pulsechat:presence';

export function createPresence(redis) {
  if (redis) {
    return {
      async connect(userId) {
        return (await redis.hIncrBy(KEY, userId, 1)) === 1; // true => just came online
      },
      async disconnect(userId) {
        const n = await redis.hIncrBy(KEY, userId, -1);
        if (n <= 0) {
          await redis.hDel(KEY, userId);
          return true; // just went offline
        }
        return false;
      },
      async online() {
        return Object.keys(await redis.hGetAll(KEY));
      },
      async isOnline(userId) {
        return Boolean(await redis.hExists(KEY, userId));
      },
    };
  }
  const counts = new Map();
  return {
    async connect(userId) {
      const n = (counts.get(userId) || 0) + 1;
      counts.set(userId, n);
      return n === 1;
    },
    async disconnect(userId) {
      const n = (counts.get(userId) || 1) - 1;
      if (n <= 0) {
        counts.delete(userId);
        return true;
      }
      counts.set(userId, n);
      return false;
    },
    async online() {
      return [...counts.keys()];
    },
    async isOnline(userId) {
      return counts.has(userId);
    },
  };
}
