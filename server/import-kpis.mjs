/**
 * Import a KPI workbook into the KPI module.
 *
 *   node server/import-kpis.mjs <workbook.xlsx> [--dry-run] [--overwrite-manual]
 *
 * Expects a tracker sheet with one row per deliverable and these headers (the
 * order does not matter): Executive Name, Title / Role, Strategic KPI Objective,
 * Key Task / Deliverable, Month, Target Date, Priority, Status, % Complete,
 * Income / Revenue Impact Mechanism, Target Value / ARR Impact ($),
 * Verified Income Realized ($), Income Stage. An optional summary sheet with
 * "Executive Name" and "Total Attributed / Influenced Revenue ($)" columns is
 * read only to check the tracker against.
 *
 * The data lands in the local database (data/, gitignored). Neither the
 * workbook nor anything in it is ever written into the repository.
 *
 * Two rules:
 *   - Imported as written. Where the source breaks a rule (a target date before
 *     its own month, say) the row is kept and flagged on the KPI page, not
 *     quietly corrected.
 *   - A KPI someone has assessed in the app is theirs. Re-importing skips it
 *     unless --overwrite-manual is passed.
 */
import { basename } from 'node:path';
import { readWorkbook, excelSerialToISO } from './xlsx.mjs';
import { open, one } from './db.mjs';
import { create, patch } from './crud.mjs';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const OVERWRITE = argv.includes('--overwrite-manual');
const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node server/import-kpis.mjs <workbook.xlsx> [--dry-run] [--overwrite-manual]');
  process.exit(1);
}

const money = (v) => `$${Math.round(Number(v) || 0).toLocaleString('en-US')}`;
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

/** Excel gives dates as a dd/mm/yyyy string or as a bare serial number. */
function parseDate(raw) {
  if (raw == null || raw === '') return { iso: null, raw: null };
  const s = String(raw).trim();
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (dmy) return { iso: `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`, raw: s };
  if (/^\d+(\.\d+)?$/.test(s)) return { iso: excelSerialToISO(s), raw: s };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { iso: s, raw: s };
  return { iso: null, raw: s };
}
const num = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

// ---------------------------------------------------------------- read
const sheets = readWorkbook(file);
const findHeader = (sheet, needed) => {
  const idx = sheet.rows.findIndex((r) => needed.every((h) => r.some((c) => norm(c) === norm(h))));
  return idx < 0 ? null : { idx, row: sheet.rows[idx] };
};
const TRACKER_HEADERS = ['Executive Name', 'Key Task / Deliverable', 'Status'];
let tracker = null;
let header = null;
for (const s of sheets) {
  const h = findHeader(s, TRACKER_HEADERS);
  if (h) { tracker = s; header = h; break; }
}
if (!tracker) {
  console.error(`No sheet has the tracker headers (${TRACKER_HEADERS.join(', ')}). Sheets: ${sheets.map((s) => s.name).join(', ')}`);
  process.exit(1);
}
const col = (label) => header.row.findIndex((c) => norm(c) === norm(label));
const C = {
  name: col('Executive Name'), role: col('Title / Role'), objective: col('Strategic KPI Objective'),
  deliverable: col('Key Task / Deliverable'), month: col('Month'), target: col('Target Date'),
  priority: col('Priority'), status: col('Status'), percent: col('% Complete'),
  mechanism: col('Income / Revenue Impact Mechanism'), value: col('Target Value / ARR Impact ($)'),
  realized: col('Verified Income Realized ($)'), stage: col('Income Stage'),
};
const cellOf = (r, k) => (C[k] >= 0 ? r[C[k]] : null);
const text = (r, k) => String(cellOf(r, k) ?? '').trim() || null;

const records = [];
for (let i = header.idx + 1; i < tracker.rows.length; i += 1) {
  const r = tracker.rows[i];
  const name = text(r, 'name');
  if (!name) continue;
  const month = parseDate(cellOf(r, 'month'));
  const target = parseDate(cellOf(r, 'target'));
  const pct = num(cellOf(r, 'percent'));
  records.push({
    row: i + 1,
    name,
    role: text(r, 'role'),
    kpi: {
      objective: text(r, 'objective'),
      deliverable: text(r, 'deliverable'),
      month: month.iso ? month.iso.slice(0, 7) : null,
      target_date: target.iso,
      priority: text(r, 'priority'),
      status: text(r, 'status'),
      // The sheet stores 0..1; the app stores whole percent.
      percent_complete: pct === null ? 0 : Math.round(pct <= 1 ? pct * 100 : pct),
      mechanism: text(r, 'mechanism'),
      target_value: num(cellOf(r, 'value')),
      realized: num(cellOf(r, 'realized')),
      income_stage: text(r, 'stage'),
    },
    targetRaw: target.raw,
  });
}

// ---------------------------------------------------------------- checks
const totalTarget = records.reduce((a, r) => a + (r.kpi.target_value || 0), 0);
const totalRealized = records.reduce((a, r) => a + (r.kpi.realized || 0), 0);
const meanPct = records.reduce((a, r) => a + r.kpi.percent_complete, 0) / (records.length || 1);
const findings = [];

let summaryRows = [];
const summary = sheets.find((s) => s !== tracker && findHeader(s, ['Executive Name']));
if (summary) {
  const h = findHeader(summary, ['Executive Name']);
  const ci = (label) => h.row.findIndex((c) => norm(c).startsWith(norm(label)));
  const sc = { name: ci('Executive Name'), role: ci('Role'), revenue: ci('Total Attributed') };
  summaryRows = summary.rows.slice(h.idx + 1)
    .filter((r) => String(r[sc.name] ?? '').trim())
    .map((r) => ({ name: String(r[sc.name]).trim(), role: sc.role >= 0 ? String(r[sc.role] ?? '').trim() || null : null, revenue: Number(r[sc.revenue]) || 0 }));
}
const trackerNames = new Set(records.map((r) => r.name));
const summaryNames = new Set(summaryRows.map((r) => r.name));
if (summaryRows.length) {
  for (const n of summaryNames) {
    if (!trackerNames.has(n)) findings.push(`"${n}" is on the summary sheet but owns no deliverable in the tracker`);
  }
  for (const n of trackerNames) {
    if (!summaryNames.has(n)) {
      const v = records.filter((r) => r.name === n).reduce((a, r) => a + (r.kpi.target_value || 0), 0);
      findings.push(`"${n}" owns deliverables worth ${money(v)} but is missing from the summary sheet`);
    }
  }
  const sumRev = summaryRows.reduce((a, r) => a + r.revenue, 0);
  if (Math.abs(sumRev - totalTarget) > 1) {
    findings.push(`the summary sheet's revenue column sums to ${money(sumRev)}; the tracker sums to ${money(totalTarget)}`);
  }
}
for (const r of records) {
  const k = r.kpi;
  if (k.month && k.target_date && k.target_date.slice(0, 7) < k.month) {
    findings.push(`${r.name} — "${k.deliverable}": target date ${k.target_date} is before its month ${k.month} (sheet value "${r.targetRaw}")`);
  }
}

// ---------------------------------------------------------------- report
console.log(`\n${DRY ? 'Would import' : 'Importing'} ${basename(file)}  (sheet "${tracker.name}")`);
console.log(`  KPIs              ${records.length} across ${trackerNames.size} executives`);
console.log(`  target value      ${money(totalTarget)}`);
console.log(`  verified realised ${money(totalRealized)}  (${totalTarget ? ((totalRealized / totalTarget) * 100).toFixed(1) : 0}%)`);
console.log(`  mean % complete   ${meanPct.toFixed(1)}%`);
if (findings.length) {
  console.log(`\n  In the workbook — ${findings.length} issue(s), imported as written and flagged on the KPI page:`);
  for (const f of findings) console.log(`   · ${f}`);
}
if (DRY) {
  console.log('\nDry run — nothing written.\n');
  process.exit(0);
}

// ---------------------------------------------------------------- write
const db = await open();
// Say where the data is going: with a connection string set, this is the
// hosted database, not the file on this machine.
console.log(`  into              ${db.describe()}`);
const actor = { userId: null, label: `import:${basename(file)}` };
const counts = { executives: 0, created: 0, updated: 0, unchanged: 0, kept: [] };

const executiveId = async (name, role) => {
  const found = await one(db, 'SELECT id, role FROM executives WHERE name = ?', name);
  if (found) {
    if (role && !found.role) await patch(db, 'executives', found.id, { role }, actor);
    return found.id;
  }
  counts.executives += 1;
  return (await create(db, 'executives', { name, role }, actor)).id;
};

for (const r of records) {
  const execId = await executiveId(r.name, r.role);
  const payload = { executive_id: execId, ...r.kpi };
  const existing = await one(
    db,
    'SELECT id FROM kpis WHERE executive_id = ? AND objective = ? AND deliverable = ?',
    execId, r.kpi.objective, r.kpi.deliverable,
  );
  if (!existing) {
    await create(db, 'kpis', payload, actor, { enforceChecks: false, extra: { source_row: r.row } });
    counts.created += 1;
    continue;
  }
  // Has a person changed this KPI in the app? Then it is no longer the sheet's.
  const edited = await one(
    db,
    "SELECT 1 AS yes FROM audit_log WHERE entity = 'kpis' AND entity_id = ? AND action = 'update' AND actor_user_id IS NOT NULL",
    existing.id,
  );
  if (edited && !OVERWRITE) {
    counts.kept.push(`${r.name} — ${r.kpi.deliverable}`);
    continue;
  }
  const out = await patch(db, 'kpis', existing.id, payload, actor, { enforceChecks: false, requireNote: false });
  if (out.unchanged) counts.unchanged += 1;
  else counts.updated += 1;
}
// People on the summary sheet with no deliverables are still on the roster.
for (const s of summaryRows) if (!trackerNames.has(s.name)) await executiveId(s.name, s.role);

console.log(`\n  Written: ${counts.created} new KPIs, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.executives} new executives.`);
if (counts.kept.length) {
  console.log(`  Kept ${counts.kept.length} KPI(s) assessed in the app (use --overwrite-manual to replace):`);
  for (const k of counts.kept) console.log(`   · ${k}`);
}
console.log();
await db.close();
