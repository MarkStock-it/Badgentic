#!/usr/bin/env node
/**
 * Minimal migration runner (spec §8: migrations checked into repo).
 * Applies ./drizzle/*.sql in filename order inside one transaction each,
 * tracking applied files in schema_migrations.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'drizzle');

const databaseUrl = process.env.AGENTIC_DB_URL;
if (!databaseUrl) {
  console.error('AGENTIC_DB_URL is required to run migrations.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`);

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let applied = 0;
for (const file of files) {
  const { rowCount } = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file]);
  if (rowCount > 0) continue;
  const sql = readFileSync(join(migrationsDir, file), 'utf8');
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    await client.query('COMMIT');
    applied += 1;
    console.log(`applied: ${file}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`FAILED: ${file}: ${err.message}`);
    process.exitCode = 1;
    break;
  }
}

console.log(applied === 0 ? 'migrations: up to date' : `migrations: applied ${applied}`);
await client.end();
