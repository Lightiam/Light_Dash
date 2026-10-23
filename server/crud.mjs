/**
 * The generic record engine: list, read, create, update, delete and history for
 * every resource in resources.mjs, with validation and an audit entry for every
 * write.
 *
 * Safety notes:
 * - Column names in SQL come only from the resource definitions, never from the
 *   request. Filter and search values are always bound parameters.
 * - Fields marked readonly are dropped from client input; the server sets them.
 * - Every write and its audit entry happen in one transaction: there is no
 *   change without a record of it.
 * - Works on SQLite and Postgres alike; see db.mjs for the two drivers.
 */
import { RESOURCES, MODULES } from './resources.mjs';
// Every function takes `db`: the database, or the transaction it is part of.
// Inside a transaction everything goes through `tx`, never the outer handle.

export class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.httpCode = code;
  }
}
const fail = (code, msg) => {
  throw new HttpError(code, msg);
};

export function resourceOr404(name) {
  const r = RESOURCES[name];
  if (!r) fail(404, `no such record type: ${name}`);
  return { name, ...r };
}

const fieldMap = (r) => new Map(r.fields.map((f) => [f.name, f]));
const isRealDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// ---------------------------------------------------------------- validation
/** Turn one submitted value into what gets stored, or throw a 400 saying why. */
async function coerce(db, r, f, raw) {
  let v = raw;
  if (typeof v === 'string') v = v.trim();
  if (v === '' || v === undefined) v = null;
  if (v === null) return null;
  const what = `${r.singular} ${f.label.toLowerCase()}`;

  switch (f.type) {
    case 'text':
    case 'textarea':
      v = String(v);
      if (v.length > (f.type === 'text' ? 300 : 5000)) fail(400, `${what} is too long`);
      return v;
    case 'email':
      v = String(v);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) fail(400, `${what} is not a valid email address`);
      return v.toLowerCase();
    case 'url':
      v = String(v);
      if (!/^https?:\/\/\S+$/i.test(v)) fail(400, `${what} must start with http:// or https://`);
      return v;
    case 'number':
    case 'money':
    case 'percent': {
      const n = Number(v);
      if (!Number.isFinite(n)) fail(400, `${what} must be a number`);
      const min = f.type === 'percent' ? 0 : f.min;
      const max = f.type === 'percent' ? 100 : f.max;
      if (min !== undefined && n < min) fail(400, `${what} must be at least ${min}`);
      if (max !== undefined && n > max) fail(400, `${what} must be at most ${max}`);
      if (f.type === 'percent') return Math.round(n);
      return f.type === 'money' ? round2(n) : n;
    }
    case 'date':
      v = String(v);
      if (!isRealDate(v)) fail(400, `${what} must be a real date, YYYY-MM-DD`);
      return v;
    case 'month':
      v = String(v);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v)) fail(400, `${what} must be a month, YYYY-MM`);
      return v;
    case 'enum':
      if (!f.options.includes(v)) fail(400, `${what} must be one of: ${f.options.join(', ')}`);
      return v;
    case 'ref': {
      const id = Number(v);
      if (!Number.isInteger(id)) fail(400, `${what} must be a record id`);
      const target = RESOURCES[f.ref];
      const tableName = f.ref;
      if (!(await db.one(`SELECT id FROM ${tableName} WHERE id = ?`, id))) {
        fail(400, `${what}: no ${target.singular.toLowerCase()} with id ${id}`);
      }
      return id;
    }
    default:
      return v;
  }
}

/** Validate a payload into a row of storable columns (items handled separately). */
async function prepareRow(db, r, payload, { creating }) {
  const row = {};
  for (const f of r.fields) {
    if (f.readonly || f.type === 'items') continue;
    if (!(f.name in payload)) continue;
    row[f.name] = await coerce(db, r, f, payload[f.name]);
    if (f.required && row[f.name] === null) fail(400, `${r.singular} ${f.label.toLowerCase()} is required`);
  }
  if (creating) {
    for (const f of r.fields) {
      if (f.readonly || f.type === 'items' || f.name in row) continue;
      if (f.default !== undefined) row[f.name] = typeof f.default === 'function' ? f.default() : f.default;
      if (f.required && (row[f.name] === null || row[f.name] === undefined)) {
        fail(400, `${r.singular} ${f.label.toLowerCase()} is required`);
      }
    }
  }
  return row;
}

// ---------------------------------------------------------------- invoices
function prepareItems(payload) {
  if (!('items' in payload)) return null;
  if (!Array.isArray(payload.items)) fail(400, 'invoice items must be a list');
  if (payload.items.length > 200) fail(400, 'an invoice can have at most 200 lines');
  return payload.items.map((it, i) => {
    const description = String(it?.description ?? '').trim();
    const quantity = Number(it?.quantity);
    const unit = Number(it?.unit_price);
    if (!description) fail(400, `line ${i + 1}: a description is required`);
    if (!(quantity > 0)) fail(400, `line ${i + 1}: quantity must be more than 0`);
    if (!Number.isFinite(unit) || unit < 0) fail(400, `line ${i + 1}: unit price must be 0 or more`);
    return { position: i + 1, description, quantity, unit_price: round2(unit), amount: round2(quantity * unit) };
  });
}

function totals(items, taxRate) {
  const subtotal = round2(items.reduce((a, it) => a + it.amount, 0));
  const tax = round2((subtotal * Number(taxRate || 0)) / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

const itemsOf = (db, invoiceId) =>
  db.all('SELECT description, quantity, unit_price, amount FROM invoice_items WHERE invoice_id = ? ORDER BY position', invoiceId);

async function nextInvoiceNumber(tx) {
  // Two invoices created at the same moment must not both get the same number.
  await tx.lock('invoice-number');
  const last = await tx.one("SELECT number FROM invoices WHERE number LIKE 'INV-%' ORDER BY CAST(substr(number, 5) AS INTEGER) DESC LIMIT 1");
  const n = last ? Number(last.number.slice(4)) + 1 : 1;
  return `INV-${String(n).padStart(4, '0')}`;
}

// ---------------------------------------------------------------- audit
function audit(db, actor, entity, entityId, action, changes) {
  return db.insert('audit_log', {
    at: new Date().toISOString(),
    actor_user_id: actor.userId ?? null,
    actor_label: actor.label,
    entity,
    entity_id: entityId,
    action,
    changes: JSON.stringify(changes),
  });
}

/** Turn constraint errors from either database into messages a person can act on. */
function friendly(err, r) {
  const msg = String(err?.message || '');
  const code = err?.code;
  const label = (col) => (r.fields.find((x) => x.name === col)?.label || col).toLowerCase();

  const sqliteUnique = /UNIQUE constraint failed: \w+\.(\w+)/.exec(msg);
  const pgUnique = code === '23505' ? /Key \((?:lower\()?(\w+)/.exec(String(err.detail || '')) : null;
  if (sqliteUnique || pgUnique) {
    const noun = r.singular.toLowerCase();
    fail(409, `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun} with this ${label((sqliteUnique || pgUnique)[1])} already exists`);
  }
  if (code === '23505') fail(409, `that ${r.singular.toLowerCase()} already exists`);
  if (/FOREIGN KEY constraint failed/.test(msg) || code === '23503') {
    fail(409, `this ${r.singular.toLowerCase()} is still used by other records, so it cannot be deleted`);
  }
  if (/CHECK constraint failed/.test(msg) || code === '23514') {
    fail(400, `a value is out of range for this ${r.singular.toLowerCase()}`);
  }
  throw err;
}

// ---------------------------------------------------------------- reads
/** Display labels for every linked record in these rows, in one query per link. */
async function withLabels(db, r, rows) {
  for (const f of r.fields.filter((x) => x.type === 'ref')) {
    const ids = [...new Set(rows.map((row) => row[f.name]).filter((v) => v != null))];
    if (!ids.length) continue;
    const target = RESOURCES[f.ref];
    const labels = new Map(
      (await db.all(`SELECT id, ${target.titleSql} AS t FROM ${f.ref} WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids))
        .map((x) => [x.id, x.t]),
    );
    for (const row of rows) {
      if (row[f.name] == null) continue;
      (row._labels ||= {})[f.name] = labels.get(row[f.name]) ?? `#${row[f.name]}`;
    }
  }
  return rows;
}

export async function list(db, name, url) {
  const r = resourceOr404(name);
  const fields = fieldMap(r);
  const where = [];
  const params = [];

  const q = String(url.searchParams.get('q') || '').trim();
  const searchable = r.fields.filter((f) => f.search).map((f) => f.name);
  if (q && searchable.length) {
    // Case-insensitive on both databases: LIKE on SQLite, ILIKE on Postgres.
    where.push(`(${searchable.map((c) => `${c} ${db.ilike} ?`).join(' OR ')})`);
    for (let i = 0; i < searchable.length; i += 1) params.push(`%${q}%`);
  }
  // Exact-match filters, only on declared columns.
  for (const [k, v] of url.searchParams) {
    if (k === 'q' || k === 'limit' || k === 'offset') continue;
    if (!fields.has(k) || fields.get(k).type === 'items') fail(400, `cannot filter ${name} by ${k}`);
    where.push(`${k} = ?`);
    params.push(v);
  }

  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.one(`SELECT COUNT(*) AS n FROM ${name} ${sqlWhere}`, ...params)).n;
  const rows = await db.all(`SELECT * FROM ${name} ${sqlWhere} ORDER BY ${r.order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return { rows: await withLabels(db, r, rows), total, limit, offset };
}

export async function get(db, name, id) {
  const r = resourceOr404(name);
  const row = await db.one(`SELECT * FROM ${name} WHERE id = ?`, Number(id));
  if (!row) fail(404, `no ${r.singular.toLowerCase()} with id ${id}`);
  if (name === 'invoices') row.items = await itemsOf(db, row.id);
  return (await withLabels(db, r, [row]))[0];
}

/** id + display title, for the link pickers in forms. */
export async function options(db, name) {
  const r = resourceOr404(name);
  return db.all(`SELECT id, ${r.titleSql} AS title FROM ${name} ORDER BY ${r.order} LIMIT 2000`);
}

export async function history(db, name, id) {
  resourceOr404(name);
  const rows = await db.all(
    'SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY at DESC, id DESC',
    name,
    Number(id),
  );
  return rows.map((e) => ({ ...e, changes: JSON.parse(e.changes || '{}') }));
}

// ---------------------------------------------------------------- writes
/**
 * Options for importers only - never reachable from the HTTP API:
 *   enforceChecks: false   store a record exactly as its source wrote it, even
 *                          where it breaks a cross-field rule, so problems in a
 *                          source file are flagged rather than silently fixed
 *   extra                  server-set columns that are not form fields
 */
export async function create(db, name, payload, actor, { enforceChecks = true, extra = {} } = {}) {
  const r = resourceOr404(name);
  const row = await prepareRow(db, r, payload, { creating: true });
  const items = name === 'invoices' ? prepareItems(payload) || [] : null;
  if (r.check && enforceChecks) {
    const problem = r.check(row, new Set(Object.keys(row)));
    if (problem) fail(400, problem);
  }

  return db.transaction(async (tx) => {
    if (name === 'invoices') Object.assign(row, { number: await nextInvoiceNumber(tx), ...totals(items, row.tax_rate) });
    Object.assign(row, extra);
    row.created_at = new Date().toISOString();
    let id;
    try {
      id = await tx.insert(name, row);
    } catch (err) {
      friendly(err, r);
    }
    if (items) for (const it of items) await tx.insert('invoice_items', { invoice_id: id, ...it });

    const changes = {};
    for (const [k, v] of Object.entries(row)) if (k !== 'created_at' && v !== null) changes[k] = [null, v];
    if (items) changes.items = [null, items.map(({ position, ...rest }) => rest)];
    await audit(tx, actor, name, id, 'create', changes);
    return get(tx, name, id);
  });
}

export async function patch(db, name, id, payload, actor, { enforceChecks = true, requireNote = true } = {}) {
  const r = resourceOr404(name);
  const before = await db.one(`SELECT * FROM ${name} WHERE id = ?`, Number(id));
  if (!before) fail(404, `no ${r.singular.toLowerCase()} with id ${id}`);

  const incoming = await prepareRow(db, r, payload, { creating: false });
  const changes = {};
  for (const [k, v] of Object.entries(incoming)) {
    if ((before[k] ?? null) !== (v ?? null)) changes[k] = [before[k] ?? null, v];
  }

  let items = null;
  if (name === 'invoices') {
    items = prepareItems(payload);
    if (items) {
      const old = await itemsOf(db, before.id);
      if (JSON.stringify(old) !== JSON.stringify(items.map(({ position, ...rest }) => rest))) {
        changes.items = [old, items.map(({ position, ...rest }) => rest)];
      } else {
        items = null; // resent unchanged - not a change
      }
    }
    // A paid or voided invoice is a financial record: only its status and notes
    // may change, so the amounts on it stay what was actually billed. Judged on
    // what actually changed, so a form that resends the whole record still works.
    if (['Paid', 'Void'].includes(before.status)) {
      const locked = Object.keys(changes).filter((k) => !['status', 'notes'].includes(k));
      if (locked.length) {
        fail(409, `invoice ${before.number} is ${before.status.toLowerCase()}; only its status and notes can change`);
      }
    }
  }

  if (!Object.keys(changes).length) return { ...(await get(db, name, id)), unchanged: true };

  if (requireNote && r.requireNote && r.requireNote.when.some((f) => f in changes)) {
    const nf = r.requireNote.field;
    const note = String(payload[nf] ?? '').trim();
    if (!note || note === String(before[nf] ?? '').trim()) {
      const names = r.requireNote.when.map((f) => r.fields.find((x) => x.name === f)?.label.toLowerCase() || f);
      fail(400, `changing ${names.join(' or ')} needs a new ${nf.replace(/_/g, ' ')} explaining it`);
    }
  }

  // Rules see which fields this change touched, so a rule about two fields is
  // only enforced when one of them changes - fixing a typo is never blocked by
  // an older, unrelated problem in the same record.
  const merged = { ...before, ...incoming };
  if (r.check && enforceChecks) {
    const problem = r.check(merged, new Set(Object.keys(changes)));
    if (problem) fail(400, problem);
  }

  return db.transaction(async (tx) => {
    const write = Object.fromEntries(Object.keys(changes).filter((k) => k !== 'items').map((k) => [k, incoming[k]]));
    if (name === 'invoices' && (items || 'tax_rate' in write)) {
      const lines = items || await itemsOf(tx, before.id);
      const t = totals(lines, merged.tax_rate);
      for (const k of ['subtotal', 'tax', 'total']) {
        if (before[k] !== t[k]) changes[k] = [before[k], t[k]];
      }
      Object.assign(write, t);
      if (items) {
        await tx.run('DELETE FROM invoice_items WHERE invoice_id = ?', before.id);
        for (const it of items) await tx.insert('invoice_items', { invoice_id: before.id, ...it });
      }
    }
    try {
      await tx.update(name, before.id, write);
    } catch (err) {
      friendly(err, r);
    }
    await audit(tx, actor, name, before.id, 'update', changes);
    return get(tx, name, before.id);
  });
}

export async function remove(db, name, id, actor) {
  const r = resourceOr404(name);
  const before = await db.one(`SELECT * FROM ${name} WHERE id = ?`, Number(id));
  if (!before) fail(404, `no ${r.singular.toLowerCase()} with id ${id}`);
  if (name === 'invoices' && before.status !== 'Draft') {
    fail(409, `invoice ${before.number} has been ${before.status.toLowerCase()}; void it instead of deleting it`);
  }
  return db.transaction(async (tx) => {
    const snapshot = {};
    for (const [k, v] of Object.entries(before)) if (v !== null && k !== 'id') snapshot[k] = [v, null];
    if (name === 'invoices') snapshot.items = [await itemsOf(tx, before.id), null];
    try {
      await tx.run(`DELETE FROM ${name} WHERE id = ?`, before.id);
    } catch (err) {
      friendly(err, r);
    }
    await audit(tx, actor, name, before.id, 'delete', snapshot);
    return { deleted: true, id: before.id };
  });
}

// ---------------------------------------------------------------- schema for the UI
export function publicSchema(canRead, canWrite) {
  const out = {};
  for (const [name, r] of Object.entries(RESOURCES)) {
    if (!canRead(r.module)) continue;
    out[name] = {
      name,
      module: r.module,
      label: r.label,
      singular: r.singular,
      requireNote: r.requireNote || null,
      canWrite: canWrite(r.module),
      fields: r.fields.map(({ name: n, label, type, options: o, ref, required, list: l, readonly, min, max, step, placeholder, default: d }) => ({
        name: n, label, type, options: o, ref, required: !!required, list: !!l, readonly: !!readonly,
        min, max, step, placeholder, default: typeof d === 'function' ? d() : d,
      })),
    };
  }
  const modules = Object.fromEntries(
    Object.entries(MODULES)
      .filter(([m]) => canRead(m))
      .map(([m, def]) => [m, { label: def.label, resources: def.resources, overview: !!def.overview }]),
  );
  return { modules, resources: out };
}
