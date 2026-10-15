# PulseChat

Real-time chat built with React, Node.js, Socket.IO, MongoDB, RabbitMQ and Redis. It has channels, direct messages, presence, typing indicators, @mention and DM notifications, and message history.

## Architecture

```
            ┌────────────── Nginx ──────────────┐
React  ───► │ /api/auth   /api/*   /api/notif.. │ ◄── /socket.io (WebSocket)
            └───┬──────────┬──────────┬─────────┘        │
          auth-service  chat-service  notification-svc  ws-service (×N)
                │          │   ▲          ▲   │          │   │
                └── MongoDB ◄──┤          │   └── MongoDB│   └── Redis (adapter + presence)
                               │          │              │
                     RabbitMQ topic exchange `pulsechat.events`
          message.created ──► chat-service (persist) + notification-service
          notification.created / room.created ──► ws-service ──► sockets
```

| Service | Responsibility |
|---|---|
| **auth** (`services/auth`) | Register and log in with bcrypt password hashes, and issue JWTs. Every other service verifies the JWT locally. |
| **chat** (`services/chat`) | Rooms, DMs, user directory and paginated history. Persists messages by consuming `message.created`. |
| **ws** (`services/ws`) | Socket.IO gateway. It broadcasts a message to the room first, then publishes to RabbitMQ, so delivery never waits on a DB write. Also handles presence, typing and pushing notifications. The Redis adapter fans events out across instances. |
| **notification** (`services/notification`) | Turns DMs and `@mentions` into stored notifications and announces them for real-time push. |

Each infrastructure dependency is pluggable (`shared/`). Without `MONGO_URL`, `AMQP_URL` or `REDIS_URL`, the service falls back to an in-memory store, an in-process bus or local presence. This lets the whole system run as one process (`server.js`).

## Run

```bash
# All-in-one (in-memory store/bus), http://localhost:4000
npm install && npm run build && npm start

# Full split deployment: 4 services + Nginx + MongoDB + RabbitMQ + Redis, http://localhost:8080
docker compose up --build

# Tests (spins up the server, drives two socket clients end to end)
npm test
```

Client dev server with hot reload: `cd client && npm run dev` (it proxies to `:4000`).

## Configuration

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 4000) |
| `JWT_SECRET` | JWT signing secret (**set in production**) |
| `MONGO_URL`, `MONGO_DB` | MongoDB connection, e.g. Atlas. In-memory if unset |
| `AMQP_URL` | RabbitMQ connection, e.g. CloudAMQP. In-process bus if unset |
| `REDIS_URL` | Redis for the Socket.IO adapter and shared presence |
| `CORS_ORIGIN` | Allowed origin when the client is hosted separately |
