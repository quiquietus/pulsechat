// Central configuration. Every external dependency is optional: when its URL is
// missing, the service falls back to an in-process implementation so the whole
// system can run as a single process (handy for demos and free hosting tiers).
const env = process.env;

if (!env.JWT_SECRET && env.NODE_ENV === 'production') {
  console.warn('[config] JWT_SECRET is not set; using an insecure default');
}

export const config = {
  port: Number(env.PORT) || 4000,
  jwtSecret: env.JWT_SECRET || 'pulsechat-dev-secret',
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  mongoUrl: env.MONGO_URL || '',
  mongoDb: env.MONGO_DB || 'pulsechat',
  amqpUrl: env.AMQP_URL || '',
  redisUrl: env.REDIS_URL || '',
  corsOrigin: env.CORS_ORIGIN || '*',
};
