// Message bus. RabbitMQ (topic exchange) when AMQP_URL is set, otherwise an
// in-process EventEmitter with the same publish/subscribe contract.
//
// subscribe(group, routingKey, handler): every distinct `group` receives each
// event once; instances sharing a group compete for messages (work queue).
import { EventEmitter } from 'node:events';

const EXCHANGE = 'pulsechat.events';

export const Events = {
  MessageCreated: 'message.created',
  RoomCreated: 'room.created',
  NotificationCreated: 'notification.created',
};

export async function createBus(amqpUrl) {
  return amqpUrl ? createRabbitBus(amqpUrl) : createMemoryBus();
}

function createMemoryBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return {
    kind: 'memory',
    async publish(key, payload) {
      // Async delivery so publishers never wait on consumers, like a real broker.
      setImmediate(() => emitter.emit(key, structuredClone(payload)));
    },
    async subscribe(_group, key, handler) {
      emitter.on(key, async (payload) => {
        try {
          await handler(payload);
        } catch (err) {
          console.error(`[bus] handler for ${key} failed:`, err);
        }
      });
    },
    async close() {},
  };
}

async function createRabbitBus(url) {
  const amqp = await import('amqplib');
  const conn = await connectWithRetry(() => amqp.connect(url));
  const channel = await conn.createChannel();
  await channel.assertExchange(EXCHANGE, 'topic', { durable: true });
  await channel.prefetch(20);

  return {
    kind: 'rabbitmq',
    async publish(key, payload) {
      channel.publish(EXCHANGE, key, Buffer.from(JSON.stringify(payload)), {
        persistent: true,
        contentType: 'application/json',
      });
    },
    async subscribe(group, key, handler) {
      const queue = `${group}.${key}`;
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, EXCHANGE, key);
      await channel.consume(queue, async (msg) => {
        if (!msg) return;
        try {
          await handler(JSON.parse(msg.content.toString()));
          channel.ack(msg);
        } catch (err) {
          console.error(`[bus] ${queue} handler failed, requeueing:`, err);
          // Requeue once; a redelivered message that fails again is dropped.
          channel.nack(msg, false, !msg.fields.redelivered);
        }
      });
    },
    async close() {
      await channel.close();
      await conn.close();
    },
  };
}

async function connectWithRetry(connect, attempts = 10) {
  for (let i = 1; ; i++) {
    try {
      return await connect();
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[bus] connect failed (${i}/${attempts}), retrying...`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}
