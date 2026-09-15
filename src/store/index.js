import { createMemoryStore } from './memory.js';
import { createPgStore } from './pg.js';

/**
 * Store selection: Postgres in production, memory in tests / when no DB URL
 * is configured (dev convenience — durability is the whole point of §1.2, so
 * production always requires AGENTIC_DB_URL).
 */
export function createStore({ config, log }) {
  if (config.databaseUrl) {
    return createPgStore({ databaseUrl: config.databaseUrl, log });
  }
  log?.warn('AGENTIC_DB_URL not set — using in-memory store (data is ephemeral!)');
  return createMemoryStore();
}
