/**
 * Database access: one async interface, two drivers.
 *
 *   SQLite (node:sqlite)  the default - a file in data/, for running on your own
 *                         machine with no dependencies
 *   Postgres (pg)         when a connection string is set - required on Netlify,
 *                         where functions have no lasting disk
 *
 * The connection string is read from the first of these that is set:
 *   LIGHTDASH_DATABASE_URL, NETLIFY_DB_URL, NETLIFY_DATABASE_URL, DATABASE_URL
 *
 * SQL is written once with `?` placeholders; the Postgres driver rewrites them
 * to $1, $2, ... The two places the dialects differ are exposed here (`ilike`,
 * `lock`) rather than scattered through the code.
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SQLITE_PATH = process.env.LIGHTDASH_DB || join(here, '..', 'data', 'lightdash.db');

const URL_VARS = ['LIGHTDASH_DATABASE_URL', 'NETLIFY_DB_URL', 'NETLIFY_DATABASE_URL', 'DATABASE_URL'];

/** Which Postgres to use, if any, and which variable named it. */
export function postgresTarget() {
  for (const name of URL_VARS) {
    if (process.env[name]) return { url: process.env[name], from: name };
  }
  return null;
}

// node:sqlite and pg both bind null, numbers and strings; normalise the rest.
function bindable(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** `?` -> `$n`, leaving question marks inside quoted literals alone. */
function toPostgres(sql) {
  let n = 0;
  let out = '';
  let quote = null;
  for (const ch of sql) {
    if (quote) {
      if (ch === quote) quote = null;
      out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
    } else if (ch === '?') {
      n += 1;
      out += `$${n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

const insertSql = (table, keys) =>
  `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
const updateSql = (table, keys) => `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;

// ---------------------------------------------------------------- SQLite
async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

  // One connection, many requests: every top-level operation queues here, and a
  // transaction holds the queue for its whole length, so no other request's
  // writes can land inside it (or be rolled back with it).
  let queue = Promise.resolve();
  const exclusive = (fn) => {
    const next = queue.then(() => fn());
    queue = next.catch(() => {});
    return next;
  };

  const direct = {
    dialect: 'sqlite',
    ilike: 'LIKE', // SQLite's LIKE is already case-insensitive for ASCII
    all: async (sql, ...p) => raw.prepare(sql).all(...p.map(bindable)),
    one: async (sql, ...p) => raw.prepare(sql).get(...p.map(bindable)) ?? null,
    run: async (sql, ...p) => ({ changes: Number(raw.prepare(sql).run(...p.map(bindable)).changes) }),
    insert: async (table, row) => {
      const keys = Object.keys(row);
      return Number(raw.prepare(insertSql(table, keys)).run(...keys.map((k) => bindable(row[k]))).lastInsertRowid);
    },
    update: async (table, id, patch) => {
      const keys = Object.keys(patch);
      if (!keys.length) return 0;
      return Number(raw.prepare(updateSql(table, keys)).run(...keys.map((k) => bindable(patch[k])), id).changes);
    },
    lock: async () => {}, // the queue already serialises everything
  };
  direct.transaction = (fn) => fn(direct); // nested: already inside one

  const db = { dialect: 'sqlite', ilike: 'LIKE', describe: () => `SQLite file ${path}` };
  for (const k of ['all', 'one', 'run', 'insert', 'update']) db[k] = (...a) => exclusive(() => direct[k](...a));
  db.transaction = (fn) => exclusive(async () => {
    raw.exec('BEGIN');
    try {
      const out = await fn(direct);
      raw.exec('COMMIT');
      return out;
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
  });
  db.close = async () => raw.close();
  return db;
}

// ---------------------------------------------------------------- Postgres
async function openPostgres({ url, from }) {
  const { default: pg } = await import('pg');
  // COUNT() and SUM() of integers come back as int8 and AVG() as numeric, which
  // pg returns as strings by default. Every such value here fits a JS number.
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));

  // Small per instance: on Netlify each function instance keeps its own pool.
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.LIGHTDASH_PG_POOL || 3),
    idleTimeoutMillis: 10_000,
  });

  const bind = (client) => {
    const q = async (sql, params) => client.query(toPostgres(sql), params.map(bindable));
    const ops = {
      dialect: 'postgres',
      ilike: 'ILIKE',
      all: async (sql, ...p) => (await q(sql, p)).rows,
      one: async (sql, ...p) => (await q(sql, p)).rows[0] ?? null,
      run: async (sql, ...p) => ({ changes: (await q(sql, p)).rowCount }),
      insert: async (table, row) => {
        const keys = Object.keys(row);
        const res = await q(`${insertSql(table, keys)} RETURNING id`, keys.map((k) => row[k]));
        return Number(res.rows[0].id);
      },
      update: async (table, id, patch) => {
        const keys = Object.keys(patch);
        if (!keys.length) return 0;
        return (await q(updateSql(table, keys), [...keys.map((k) => patch[k]), id])).rowCount;
      },
      // Serialise one kind of work (e.g. invoice numbering) across every
      // connection, until this transaction ends.
      lock: async (name) => { await q('SELECT pg_advisory_xact_lock(hashtext(?))', [name]); },
    };
    return ops;
  };

  const top = bind(pool);
  const db = { ...top, describe: () => `Postgres (${from}) at ${new URL(url).host}` };
  db.transaction = async (fn) => {
    const client = await pool.connect();
    const tx = bind(client);
    tx.transaction = (inner) => inner(tx);
    try {
      await client.query('BEGIN');
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  db.close = async () => pool.end();
  return db;
}

// ---------------------------------------------------------------- open
let opened = null;

/** Open the database once per process. Safe to call repeatedly. */
export function open() {
  if (!opened) {
    const target = postgresTarget();
    opened = target ? openPostgres(target) : openSqlite(SQLITE_PATH);
  }
  return opened;
}

// Thin helpers, so callers read `await one(db, sql, ...)` either way.
export const all = (db, sql, ...p) => db.all(sql, ...p);
export const one = (db, sql, ...p) => db.one(sql, ...p);
export const run = (db, sql, ...p) => db.run(sql, ...p);
export const insert = (db, table, row) => db.insert(table, row);
export const update = (db, table, id, patch) => db.update(table, id, patch);
export const transaction = (db, fn) => db.transaction(fn);
