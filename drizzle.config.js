import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/store/schema.js',
  out: './drizzle',
  dbCredentials: {
    url: process.env.AGENTIC_DB_URL || 'postgres://localhost:5432/betterclss_agentic',
  },
});
