/**
 * Apply the Postgres migrations in netlify/database/migrations/ to a Postgres
 * database that Netlify does not manage (Neon, Supabase, your own server...).
 *
 *   node server/migrate.mjs            apply anything not yet applied
 *   node server/migrate.mjs --status   list what is applied and what is pending
 *
 * Reads the connection string the same way the app does (see db.mjs).
 *
 * On Netlify Database, do not run this: Netlify applies these same files itself
 * on every deploy and checksums them, and warns against DDL over a direct
 * connection. This script refuses when the connection came from NETLIFY_DB_URL
 * or NETLIFY_DATABASE_URL.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, postgresTarget } from './db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, '..', 'netlify', 'database', 'migrations');
const STATUS = process.argv.includes('--status');

const target = postgresTarget();
if (!target) {
  console.error('No Postgres connection string is set. Set DATABASE_URL (or LIGHTDASH_DATABASE_URL) first.');
  console.error('(Running on SQLite needs no migrations: server/schema.sql is applied on start.)');
  process.exit(1);
}
if (['NETLIFY_DB_URL', 'NETLIFY_DATABASE_URL'].includes(target.from)) {
  console.error(`The connection comes from ${target.from}, i.e. Netlify Database.`);
  console.error('Netlify applies netlify/database/migrations/ itself on deploy - do not run this against it.');
  process.exit(1);
}

// Migrations are either NAME.sql or a NAME/ directory holding migration.sql.
const migrations = readdirSync(DIR)
  .sort()
  .map((name) => {
    const path = join(DIR, name);
    const file = statSync(path).isDirectory() ? join(path, 'migration.sql') : path;
    if (!file.endsWith('.sql')) return null;
    const sql = readFileSync(file, 'utf8');
    return { name: name.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
  })
  .filter(Boolean);

const db = await open();
console.log(`Target: ${db.describe()}`);
await db.run(`CREATE TABLE IF NOT EXISTS lightdash_migrations (
  name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
const applied = new Map((await db.all('SELECT name, checksum FROM lightdash_migrations')).map((r) => [r.name, r.checksum]));

let pending = 0;
for (const m of migrations) {
  const done = applied.get(m.name);
  if (done && done !== m.checksum) {
    console.error(`  ! ${m.name} was changed after it was applied. Add a new migration instead of editing this one.`);
    await db.close();
    process.exit(1);
  }
  if (done) {
    console.log(`  applied  ${m.name}`);
    continue;
  }
  pending += 1;
  if (STATUS) {
    console.log(`  pending  ${m.name}`);
    continue;
  }
  // One transaction per migration: it lands whole or not at all.
  await db.transaction(async (tx) => {
    await tx.run(m.sql);
    await tx.run('INSERT INTO lightdash_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
      m.name, m.checksum, new Date().toISOString());
  });
  console.log(`  APPLIED  ${m.name}`);
}
console.log(pending ? (STATUS ? `${pending} pending.` : `${pending} applied now.`) : 'Up to date.');
await db.close();
