/**
 * Copy what is in the local SQLite database into a hosted Postgres - for moving
 * an existing install onto Netlify.
 *
 *   DATABASE_URL=postgres://... node server/copy-to-postgres.mjs [options]
 *
 *   --from <file>     SQLite file to read (default data/lightdash.db)
 *   --include-demo    also copy HR, CRM, projects and finance records
 *                     (by default only accounts and the KPI module are copied,
 *                     so demo data does not end up in production)
 *   --dry-run         report what would be copied; write nothing
 *
 * Safe by construction:
 *   - refuses unless the target already has the schema (apply the migrations
 *     first: deploy to Netlify, or run server/migrate.mjs);
 *   - refuses if any table it would copy into already has rows - it never
 *     merges into or overwrites a live database;
 *   - copies inside one transaction: all of it lands, or none of it does;
 *   - keeps every id, so audit history still points at the right records, then
 *     moves each id counter past the copied rows;
 *   - checks the KPI totals on both sides match before committing.
 * Sessions and sign-in throttling are not copied; everyone signs in again.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { open, postgresTarget, SQLITE_PATH } from './db.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry-run');
const DEMO = argv.includes('--include-demo');
const from = opt('from', SQLITE_PATH);

if (!postgresTarget()) {
  console.error('Set the target Postgres connection string first (DATABASE_URL or LIGHTDASH_DATABASE_URL).');
  process.exit(1);
}
if (!existsSync(from)) {
  console.error(`No SQLite database at ${from}`);
  process.exit(1);
}

// In dependency order, so every foreign key's target is copied before it.
const DEMO_TABLES = [
  'departments', 'employees', 'companies', 'contacts', 'projects', 'deals', 'tasks',
  'timesheets', 'time_off', 'goals', 'invoices', 'invoice_items', 'expenses',
];
const CORE_TABLES = ['users', 'executives', 'kpis'];
const tables = DEMO ? ['departments', 'employees', ...CORE_TABLES, ...DEMO_TABLES.slice(2)] : CORE_TABLES;
// Audit rows go with the records they describe.
const auditEntities = DEMO ? [...CORE_TABLES, ...DEMO_TABLES] : ['executives', 'kpis'];

const src = new DatabaseSync(from, { readOnly: true });
const dst = await open();
console.log(`From: SQLite ${from}`);
// Every refusal after this point closes the connection before exiting.
const stop = async (msg) => { console.error(msg); await dst.close(); process.exit(1); };
console.log(`To:   ${dst.describe()}${DRY ? '   (dry run)' : ''}`);

const exists = await dst.one("SELECT 1 AS yes FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'kpis'");
if (!exists) {
  await stop('\nThe target has no Light Dash tables yet. Apply the migrations first (deploy to Netlify, or node server/migrate.mjs).');
}

const rowsOf = (t) => src.prepare(`SELECT * FROM ${t} ORDER BY id`).all();
const plan = [];
for (const t of tables) {
  const already = (await dst.one(`SELECT COUNT(*) AS n FROM ${t}`)).n;
  if (already) {
    await stop(`\nThe target already has ${already} row(s) in ${t}. This copies into an empty database only.`);
  }
  let rows = rowsOf(t);
  if (t === 'users' && !DEMO) rows = rows.map((u) => ({ ...u, employee_id: null })); // employees are not copied
  plan.push([t, rows]);
}
const audit = src.prepare(
  `SELECT * FROM audit_log WHERE entity IN (${auditEntities.map(() => '?').join(', ')}) ORDER BY id`,
).all(...auditEntities);
if ((await dst.one('SELECT COUNT(*) AS n FROM audit_log')).n) {
  await stop('\nThe target audit log is not empty. This copies into an empty database only.');
}

console.log('');
for (const [t, rows] of plan) console.log(`  ${t.padEnd(14)} ${rows.length}`);
console.log(`  ${'audit_log'.padEnd(14)} ${audit.length}  (history of ${auditEntities.join(', ')})`);
if (!DEMO) console.log('\n  HR, CRM, projects and finance records are not copied (add --include-demo to copy them).');
if (DRY) {
  console.log('\nDry run - nothing written.');
  await dst.close();
  process.exit(0);
}

const kpiTotals = (rows) => ({
  n: rows.length,
  target: rows.reduce((a, r) => a + (r.target_value || 0), 0),
  realized: rows.reduce((a, r) => a + (r.realized || 0), 0),
});
const want = kpiTotals(rowsOf('kpis'));

await dst.transaction(async (tx) => {
  const copy = async (t, rows) => {
    for (const row of rows) await tx.insert(t, { ...row });
    // Identity columns were given explicit ids, so move each counter past them.
    if (rows.length) {
      await tx.run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT MAX(id) FROM ${t}))`);
    }
  };
  for (const [t, rows] of plan) await copy(t, rows);
  // Audit rows written by accounts that are not being copied lose the link, not the label.
  const userIds = new Set((plan.find(([t]) => t === 'users')?.[1] || []).map((u) => u.id));
  await copy('audit_log', audit.map((e) => ({ ...e, actor_user_id: userIds.has(e.actor_user_id) ? e.actor_user_id : null })));

  const got = kpiTotals(await tx.all('SELECT target_value, realized FROM kpis'));
  if (got.n !== want.n || Math.abs(got.target - want.target) > 0.005 || Math.abs(got.realized - want.realized) > 0.005) {
    throw new Error(`KPI totals differ after copying (source ${JSON.stringify(want)}, target ${JSON.stringify(got)}) - rolled back`);
  }
});

console.log(`\nCopied. KPIs on the target: ${want.n}, target value ${want.target.toLocaleString('en-US')}, realised ${want.realized.toLocaleString('en-US')} - matching the source.`);
await dst.close();
src.close();
