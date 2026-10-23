/**
 * The SQLite schema (server/schema.sql) and the Postgres migrations
 * (netlify/database/migrations/) describe the same tables twice. This fails if
 * they disagree on which tables exist or which columns each one has.
 *
 *   LIGHTDASH_DATABASE_URL=postgres://... node test/schema-parity.mjs
 *
 * Point it at a Postgres that has had the migrations applied - never production
 * is needed, a scratch database is fine.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, postgresTarget } from '../server/db.mjs';

const here = dirname(fileURLToPath(import.meta.url));
if (!postgresTarget()) {
  console.error('Set LIGHTDASH_DATABASE_URL to a Postgres with the migrations applied.');
  process.exit(1);
}

// SQLite side: apply schema.sql to an in-memory database and read it back.
const lite = new DatabaseSync(':memory:');
lite.exec(readFileSync(join(here, '..', 'server', 'schema.sql'), 'utf8'));
const liteTables = {};
for (const { name } of lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()) {
  liteTables[name] = lite.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name).sort();
}

// Postgres side: what the migrations actually created.
const pg = await open();
const pgTables = {};
for (const r of await pg.all(
  `SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> 'lightdash_migrations'
    ORDER BY table_name, column_name`,
)) {
  (pgTables[r.table_name] ||= []).push(r.column_name);
}
await pg.close();

const problems = [];
for (const t of new Set([...Object.keys(liteTables), ...Object.keys(pgTables)])) {
  if (!liteTables[t]) { problems.push(`table ${t} exists only in Postgres`); continue; }
  if (!pgTables[t]) { problems.push(`table ${t} exists only in SQLite`); continue; }
  for (const c of liteTables[t]) if (!pgTables[t].includes(c)) problems.push(`${t}.${c} is missing from Postgres`);
  for (const c of pgTables[t]) if (!liteTables[t].includes(c)) problems.push(`${t}.${c} is missing from SQLite`);
}

const tables = Object.keys(liteTables).length;
const columns = Object.values(liteTables).reduce((a, c) => a + c.length, 0);
if (problems.length) {
  console.error(`Schemas disagree (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Schemas match: ${tables} tables, ${columns} columns.`);
