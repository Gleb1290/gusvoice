import type { Config } from 'drizzle-kit';

// Optional: used only for `pnpm db:generate` / `pnpm db:studio` during development.
// At runtime the backend applies the SQL files in ./drizzle itself (see src/db/index.ts).
export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
} satisfies Config;
