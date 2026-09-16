import { firstPlaceholderSecret } from '@gusvoice/shared';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Та же проверка, что в backend env.ts: заглушка из .env.example вместо секрета — не стартуем (shared/secretRules.ts).
const placeholder = firstPlaceholderSecret({
  JWT_SECRET: process.env.JWT_SECRET,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
});
if (placeholder) {
  throw new Error(`${placeholder} is a placeholder from .env.example — generate a real one: openssl rand -hex 32`);
}

export const env = {
  port: Number(process.env.PRESENCE_PORT ?? 4001),
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  jwtSecret: required('JWT_SECRET'),
  // Internal backend base URL — used to ask which voice channels a user may VIEW.
  backendUrlInternal: process.env.BACKEND_URL_INTERNAL ?? 'http://backend:4000',
  livekit: {
    apiKey: required('LIVEKIT_API_KEY'),
    apiSecret: required('LIVEKIT_API_SECRET'),
    urlInternal: process.env.LIVEKIT_URL_INTERNAL ?? 'http://livekit:7880',
  },
};
