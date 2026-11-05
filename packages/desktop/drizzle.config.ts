import { defineConfig } from 'drizzle-kit';

// Génère les migrations SQL versionnées : npm run db:generate -w desktop
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
});
