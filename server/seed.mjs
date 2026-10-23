/**
 * Demo data for trying Light Dash. Everything here is invented: the people,
 * the client companies and the numbers. Dates are relative to today so the
 * dashboard always has a current month to show.
 *
 *   node server/seed.mjs           seed an empty database
 *   node server/seed.mjs --reset   wipe the demo records and re-seed. Never touches
 *                                  user accounts, KPIs or executives.
 *
 * Records go in through the same validation and audit path as the app uses, so
 * the demo cannot contain anything the app itself would refuse.
 */
import { open, all, run } from './db.mjs';
import { create, patch } from './crud.mjs';

const RESET = process.argv.includes('--reset');
const db = open();
const actor = { userId: null, label: 'seed (demo data)' };

const TABLES = [
  'invoice_items', 'invoices', 'expenses', 'timesheets', 'tasks', 'projects',
  'deals', 'contacts', 'companies', 'goals', 'time_off', 'employees', 'departments',
];

if (RESET) {
  run(db, 'UPDATE users SET employee_id = NULL');
  for (const t of TABLES) run(db, `DELETE FROM ${t}`);
  // Only the demo records' history. KPIs and executives are real data, live in
  // their own tables, and are never touched here - nor is their audit trail.
  run(db, `DELETE FROM audit_log WHERE entity IN (${TABLES.map(() => '?').join(', ')})`, ...TABLES);
} else if (all(db, 'SELECT id FROM employees LIMIT 1').length) {
  console.log('The database already has records. Use --reset to replace them with demo data.');
  process.exit(0);
}

// ---------------------------------------------------------------- dates
const now = new Date();
const day = (offset) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset));
  return d.toISOString().slice(0, 10);
};
const monthDay = (monthsAgo, dom) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, dom));
  return d.toISOString().slice(0, 10);
};
const add = (resource, row) => create(db, resource, row, actor).id;

// ---------------------------------------------------------------- HR
const dept = {};
for (const name of ['Engineering', 'Sales', 'Operations', 'Finance', 'People']) dept[name] = add('departments', { name });

const people = [
  ['Amara', 'Okafor', 'Engineering', 'Engineering Lead', 'Full-time', -900],
  ['Daniel', 'Reyes', 'Engineering', 'Software Engineer', 'Full-time', -540],
  ['Mei', 'Tanaka', 'Engineering', 'Software Engineer', 'Full-time', -300],
  ['Jonas', 'Berg', 'Engineering', 'QA Engineer', 'Contractor', -120],
  ['Priya', 'Nair', 'Sales', 'Head of Sales', 'Full-time', -720],
  ['Tom', 'Walsh', 'Sales', 'Account Executive', 'Full-time', -410],
  ['Lena', 'Fischer', 'Sales', 'Account Executive', 'Part-time', -200],
  ['Kwame', 'Mensah', 'Operations', 'Operations Manager', 'Full-time', -820],
  ['Sofia', 'Rossi', 'Operations', 'Project Coordinator', 'Full-time', -260],
  ['Hannah', 'Cole', 'Finance', 'Finance Manager', 'Full-time', -650],
  ['Omar', 'Haddad', 'Finance', 'Accountant', 'Full-time', -330],
  ['Grace', 'Liu', 'People', 'People Partner', 'Full-time', -480],
];
const emp = {};
for (const [first, last, d, title, type, started] of people) {
  emp[first] = add('employees', {
    first_name: first,
    last_name: last,
    email: `${first}.${last}@example.com`.toLowerCase(),
    department_id: dept[d],
    job_title: title,
    employment_type: type,
    start_date: day(started),
    status: 'Active',
  });
}

add('time_off', { employee_id: emp.Mei, kind: 'Vacation', start_date: day(6), end_date: day(10), status: 'Approved' });
add('time_off', { employee_id: emp.Tom, kind: 'Vacation', start_date: day(20), end_date: day(27), status: 'Requested', note: 'Family trip' });
add('time_off', { employee_id: emp.Omar, kind: 'Sick', start_date: day(-3), end_date: day(-2), status: 'Approved' });
add('time_off', { employee_id: emp.Sofia, kind: 'Personal', start_date: day(12), end_date: day(12), status: 'Requested' });

const goal = (who, title, period, progress, status, note) =>
  add('goals', { employee_id: emp[who], title, period, progress, status, review_note: note });
const quarter = `${now.getUTCFullYear()}-Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
goal('Amara', 'Ship the customer portal v2', quarter, 70, 'On track', 'Core flows done; payments integration in review.');
goal('Priya', 'Close three new enterprise accounts', quarter, 33, 'At risk', 'One closed, two stalled in procurement.');
goal('Kwame', 'Cut order turnaround to two days', quarter, 100, 'Done', 'Hit two days for six straight weeks.');
goal('Hannah', 'Monthly close in five working days', quarter, 60, 'On track', 'Down from nine days; reconciliations next.');
goal('Grace', 'Run the annual engagement survey', quarter, 0, 'Not started', null);

// ---------------------------------------------------------------- CRM
const co = {};
for (const [name, industry, website] of [
  ['Acme Corp', 'Manufacturing', 'https://acme.example.com'],
  ['Example Retail Ltd', 'Retail', 'https://retail.example.com'],
  ['Sample Logistics Co', 'Logistics', 'https://logistics.example.com'],
  ['Demo Health Group', 'Healthcare', 'https://health.example.com'],
  ['Placeholder Studios', 'Media', 'https://studios.example.com'],
]) co[name] = add('companies', { name, industry, website });

const contact = (first, last, company, title) =>
  add('contacts', { first_name: first, last_name: last, company_id: co[company], job_title: title, email: `${first}@${company.split(' ')[0].toLowerCase()}.example.com`.toLowerCase() });
const ct = {
  ruth: contact('Ruth', 'Adler', 'Acme Corp', 'COO'),
  marco: contact('Marco', 'Silva', 'Example Retail Ltd', 'IT Director'),
  ines: contact('Ines', 'Moreau', 'Sample Logistics Co', 'Head of Operations'),
  sam: contact('Sam', 'Kowalski', 'Demo Health Group', 'Procurement Lead'),
  ada: contact('Ada', 'Brennan', 'Placeholder Studios', 'Producer'),
};

for (const [title, company, c, owner, value, stage, close] of [
  ['Acme plant rollout', 'Acme Corp', 'ruth', 'Priya', 48000, 'Proposal', day(21)],
  ['Retail loyalty integration', 'Example Retail Ltd', 'marco', 'Tom', 26000, 'Qualified', day(40)],
  ['Logistics tracking pilot', 'Sample Logistics Co', 'ines', 'Lena', 12000, 'Lead', day(60)],
  ['Health records migration', 'Demo Health Group', 'sam', 'Priya', 72000, 'Proposal', day(30)],
  ['Studio asset library', 'Placeholder Studios', 'ada', 'Tom', 9500, 'Lead', day(75)],
  ['Acme support renewal', 'Acme Corp', 'ruth', 'Tom', 18000, 'Won', day(-20)],
  ['Retail analytics add-on', 'Example Retail Ltd', 'marco', 'Lena', 7000, 'Won', day(-45)],
  ['Logistics fleet module', 'Sample Logistics Co', 'ines', 'Priya', 31000, 'Lost', day(-10)],
]) {
  add('deals', { title, company_id: co[company], contact_id: ct[c], owner_id: emp[owner], value, stage, expected_close: close });
}

// ---------------------------------------------------------------- projects
const pr = {};
for (const [name, company, manager, status, start, end, budget] of [
  ['Customer portal v2', null, 'Amara', 'Active', day(-75), day(45), 90000],
  ['Acme plant rollout', 'Acme Corp', 'Kwame', 'Planned', day(25), day(140), 48000],
  ['Retail loyalty integration', 'Example Retail Ltd', 'Sofia', 'Active', day(-30), day(60), 26000],
  ['Office move', null, 'Kwame', 'On hold', day(-10), day(50), 15000],
  ['Analytics add-on', 'Example Retail Ltd', 'Daniel', 'Done', day(-120), day(-50), 7000],
]) pr[name] = add('projects', { name, company_id: company ? co[company] : null, manager_id: emp[manager], status, start_date: start, end_date: end, budget });

for (const [title, project, who, status, priority, due] of [
  ['Payments integration', 'Customer portal v2', 'Daniel', 'In progress', 'High', day(7)],
  ['Accessibility review', 'Customer portal v2', 'Jonas', 'To do', 'Medium', day(14)],
  ['Account settings page', 'Customer portal v2', 'Mei', 'Done', 'Medium', day(-5)],
  ['Load testing', 'Customer portal v2', 'Jonas', 'To do', 'High', day(-2)],
  ['Loyalty API mapping', 'Retail loyalty integration', 'Mei', 'In progress', 'High', day(5)],
  ['Staging environment', 'Retail loyalty integration', 'Daniel', 'Done', 'Medium', day(-12)],
  ['Client sign-off on scope', 'Retail loyalty integration', 'Sofia', 'To do', 'High', day(-4)],
  ['Site survey', 'Acme plant rollout', 'Kwame', 'To do', 'Medium', day(28)],
  ['Lease review', 'Office move', 'Hannah', 'To do', 'Low', day(30)],
]) add('tasks', { title, project_id: pr[project], assignee_id: emp[who], status, priority, due_date: due });

// Roughly the last six weeks of weekday time for the people on active projects.
const logging = [
  ['Daniel', 'Customer portal v2', 6], ['Mei', 'Retail loyalty integration', 5],
  ['Jonas', 'Customer portal v2', 4], ['Amara', 'Customer portal v2', 3],
  ['Sofia', 'Retail loyalty integration', 4], ['Kwame', 'Office move', 2],
];
for (let offset = -42; offset <= 0; offset += 1) {
  const date = day(offset);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) continue;
  logging.forEach(([who, project, hours], i) => {
    if ((offset + i) % 5 === 0) return; // not every person logs every day
    add('timesheets', { employee_id: emp[who], project_id: pr[project], work_date: date, hours, note: 'Project work' });
  });
}

// ---------------------------------------------------------------- finance
const invoice = (company, project, monthsAgo, lines, finalStatus, taxRate = 7.5) => {
  const issue = monthDay(monthsAgo, 5);
  const due = monthDay(monthsAgo, 5 + 30);
  const id = add('invoices', {
    company_id: co[company],
    project_id: project ? pr[project] : null,
    issue_date: issue,
    due_date: due,
    tax_rate: taxRate,
    items: lines.map(([description, quantity, unit_price]) => ({ description, quantity, unit_price })),
  });
  // Walk it through the real lifecycle so the audit trail looks like real use.
  if (finalStatus !== 'Draft') patch(db, 'invoices', id, { status: 'Sent' }, actor);
  if (finalStatus === 'Paid') patch(db, 'invoices', id, { status: 'Paid' }, actor);
  return id;
};
invoice('Example Retail Ltd', 'Analytics add-on', 5, [['Analytics add-on, phase 1', 1, 3500]], 'Paid');
invoice('Example Retail Ltd', 'Analytics add-on', 4, [['Analytics add-on, phase 2', 1, 3500]], 'Paid');
invoice('Acme Corp', null, 4, [['Support plan, quarterly', 1, 4500]], 'Paid');
invoice('Example Retail Ltd', 'Retail loyalty integration', 3, [['Discovery workshop', 2, 1800], ['Integration design', 1, 4200]], 'Paid');
invoice('Acme Corp', null, 2, [['Support plan, quarterly', 1, 4500]], 'Paid');
invoice('Example Retail Ltd', 'Retail loyalty integration', 2, [['Integration build, sprint 1', 1, 6500]], 'Paid');
invoice('Example Retail Ltd', 'Retail loyalty integration', 1, [['Integration build, sprint 2', 1, 6500]], 'Sent');
invoice('Acme Corp', null, 2, [['On-site training day', 1, 2200]], 'Sent'); // overdue by now
invoice('Placeholder Studios', null, 0, [['Asset library scoping', 8, 150]], 'Draft');

for (const [monthsAgo, dom, category, vendor, amount, project, who, status] of [
  [5, 8, 'Software', 'Example Cloud Hosting', 1200, null, 'Hannah', 'Approved'],
  [5, 15, 'Travel', 'Rail operator', 320, 'Analytics add-on', 'Daniel', 'Reimbursed'],
  [4, 8, 'Software', 'Example Cloud Hosting', 1250, null, 'Hannah', 'Approved'],
  [4, 21, 'Equipment', 'Hardware supplier', 2400, null, 'Kwame', 'Approved'],
  [3, 8, 'Software', 'Example Cloud Hosting', 1300, null, 'Hannah', 'Approved'],
  [3, 12, 'Services', 'Design agency', 3800, 'Customer portal v2', 'Amara', 'Approved'],
  [2, 8, 'Software', 'Example Cloud Hosting', 1310, null, 'Hannah', 'Approved'],
  [2, 19, 'Travel', 'Airline', 640, 'Retail loyalty integration', 'Sofia', 'Reimbursed'],
  [1, 8, 'Software', 'Example Cloud Hosting', 1340, null, 'Hannah', 'Approved'],
  [1, 14, 'Office', 'Office supplies', 180, null, 'Grace', 'Approved'],
  [0, 3, 'Software', 'Example Cloud Hosting', 1360, null, 'Hannah', 'Approved'],
  [0, 4, 'Travel', 'Hotel', 410, 'Acme plant rollout', 'Kwame', 'Submitted'],
]) {
  add('expenses', {
    spent_on: monthDay(monthsAgo, dom),
    category,
    vendor,
    amount,
    project_id: project ? pr[project] : null,
    employee_id: emp[who],
    status,
  });
}

const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
console.log('Seeded demo data:', Object.fromEntries(
  ['departments', 'employees', 'time_off', 'goals', 'companies', 'contacts', 'deals',
    'projects', 'tasks', 'timesheets', 'invoices', 'expenses', 'audit_log'].map((t) => [t, count(t)]),
));
db.close();
