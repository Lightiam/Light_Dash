/**
 * Every record type in the ERP, described once. The API, validation, audit
 * trail and the forms in the browser are all generated from these definitions,
 * so adding a field or a whole record type is an edit here, not in five places.
 *
 * Field types: text, email, url, textarea, number, money, percent, date, enum,
 * ref (a link to another resource), items (invoice lines).
 *
 *   required   must be present on create, and cannot be cleared
 *   list       shown as a column in the table view
 *   search     matched by the table's search box
 *   readonly   computed by the server; never accepted from a client
 */

// The local calendar date, not UTC's: in the evening west of UTC, UTC is
// already tomorrow, and a timesheet defaulting to tomorrow is wrong.
export const localToday = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
const today = localToday;
const dateOrder = (a, b, msg) => (a && b && b < a ? msg : null);

export const MODULES = {
  hr: { label: 'HR', resources: ['employees', 'departments', 'time_off', 'goals'] },
  crm: { label: 'CRM', resources: ['deals', 'companies', 'contacts'] },
  projects: { label: 'Projects', resources: ['projects', 'tasks', 'timesheets'] },
  finance: { label: 'Finance', resources: ['invoices', 'expenses'] },
  kpis: { label: 'KPIs', resources: ['kpis', 'executives'], overview: true },
};

export const RESOURCES = {
  // ------------------------------------------------------------------ HR
  departments: {
    module: 'hr',
    label: 'Departments',
    singular: 'Department',
    titleSql: 'name',
    order: 'name',
    fields: [{ name: 'name', label: 'Name', type: 'text', required: true, list: true, search: true }],
  },

  employees: {
    module: 'hr',
    label: 'Employees',
    singular: 'Employee',
    titleSql: "first_name || ' ' || last_name",
    order: 'last_name, first_name',
    fields: [
      { name: 'first_name', label: 'First name', type: 'text', required: true, list: true, search: true },
      { name: 'last_name', label: 'Last name', type: 'text', required: true, list: true, search: true },
      { name: 'email', label: 'Email', type: 'email', list: true, search: true },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'department_id', label: 'Department', type: 'ref', ref: 'departments', list: true },
      { name: 'job_title', label: 'Job title', type: 'text', list: true, search: true },
      { name: 'employment_type', label: 'Type', type: 'enum', options: ['Full-time', 'Part-time', 'Contractor'], default: 'Full-time' },
      { name: 'start_date', label: 'Start date', type: 'date' },
      { name: 'status', label: 'Status', type: 'enum', options: ['Active', 'On leave', 'Left'], default: 'Active', list: true },
    ],
  },

  time_off: {
    module: 'hr',
    label: 'Time off',
    singular: 'Time-off request',
    titleSql: "kind || ' ' || start_date",
    order: 'start_date DESC',
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'ref', ref: 'employees', required: true, list: true },
      { name: 'kind', label: 'Kind', type: 'enum', options: ['Vacation', 'Sick', 'Personal', 'Other'], default: 'Vacation', list: true },
      { name: 'start_date', label: 'From', type: 'date', required: true, list: true },
      { name: 'end_date', label: 'To', type: 'date', required: true, list: true },
      { name: 'status', label: 'Status', type: 'enum', options: ['Requested', 'Approved', 'Rejected'], default: 'Requested', list: true },
      { name: 'note', label: 'Note', type: 'textarea' },
    ],
    check: (r) => dateOrder(r.start_date, r.end_date, 'the end date is before the start date'),
  },

  goals: {
    module: 'hr',
    label: 'Goals',
    singular: 'Goal',
    titleSql: 'title',
    order: 'period DESC, id',
    // A goal's progress and status are a manager's judgment of someone's work.
    // Changing either needs a review note, recorded with the change.
    requireNote: { when: ['progress', 'status'], field: 'review_note' },
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'ref', ref: 'employees', required: true, list: true },
      { name: 'title', label: 'Goal', type: 'text', required: true, list: true, search: true },
      { name: 'period', label: 'Period', type: 'text', placeholder: '2026-Q4', list: true },
      { name: 'progress', label: 'Progress', type: 'percent', default: 0, list: true },
      { name: 'status', label: 'Status', type: 'enum', options: ['Not started', 'On track', 'At risk', 'Done'], default: 'Not started', list: true },
      { name: 'review_note', label: 'Review note', type: 'textarea' },
    ],
    check: (r) => (r.status === 'Done' && Number(r.progress) < 100 ? 'a goal marked Done must be at 100%' : null),
  },

  // ------------------------------------------------------------------ CRM
  companies: {
    module: 'crm',
    label: 'Companies',
    singular: 'Company',
    titleSql: 'name',
    order: 'name',
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true, search: true },
      { name: 'industry', label: 'Industry', type: 'text', list: true, search: true },
      { name: 'website', label: 'Website', type: 'url', list: true },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'address', label: 'Address', type: 'textarea' },
    ],
  },

  contacts: {
    module: 'crm',
    label: 'Contacts',
    singular: 'Contact',
    titleSql: "first_name || ' ' || last_name",
    order: 'last_name, first_name',
    fields: [
      { name: 'first_name', label: 'First name', type: 'text', required: true, list: true, search: true },
      { name: 'last_name', label: 'Last name', type: 'text', required: true, list: true, search: true },
      { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies', list: true },
      { name: 'job_title', label: 'Job title', type: 'text', list: true },
      { name: 'email', label: 'Email', type: 'email', list: true, search: true },
      { name: 'phone', label: 'Phone', type: 'text' },
    ],
  },

  deals: {
    module: 'crm',
    label: 'Deals',
    singular: 'Deal',
    titleSql: 'title',
    order: "CASE stage WHEN 'Lead' THEN 0 WHEN 'Qualified' THEN 1 WHEN 'Proposal' THEN 2 WHEN 'Won' THEN 3 ELSE 4 END, value DESC",
    fields: [
      { name: 'title', label: 'Deal', type: 'text', required: true, list: true, search: true },
      { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies', list: true },
      { name: 'contact_id', label: 'Contact', type: 'ref', ref: 'contacts' },
      { name: 'owner_id', label: 'Owner', type: 'ref', ref: 'employees', list: true },
      { name: 'value', label: 'Value', type: 'money', default: 0, list: true },
      { name: 'stage', label: 'Stage', type: 'enum', options: ['Lead', 'Qualified', 'Proposal', 'Won', 'Lost'], default: 'Lead', list: true },
      { name: 'expected_close', label: 'Expected close', type: 'date', list: true },
    ],
  },

  // ------------------------------------------------------------------ Projects
  projects: {
    module: 'projects',
    label: 'Projects',
    singular: 'Project',
    titleSql: 'name',
    order: "CASE status WHEN 'Active' THEN 0 WHEN 'Planned' THEN 1 WHEN 'On hold' THEN 2 ELSE 3 END, name",
    fields: [
      { name: 'name', label: 'Name', type: 'text', required: true, list: true, search: true },
      { name: 'company_id', label: 'Client', type: 'ref', ref: 'companies', list: true },
      { name: 'manager_id', label: 'Manager', type: 'ref', ref: 'employees', list: true },
      { name: 'status', label: 'Status', type: 'enum', options: ['Planned', 'Active', 'On hold', 'Done'], default: 'Planned', list: true },
      { name: 'start_date', label: 'Start', type: 'date', list: true },
      { name: 'end_date', label: 'End', type: 'date', list: true },
      { name: 'budget', label: 'Budget', type: 'money', list: true },
    ],
    check: (r) => dateOrder(r.start_date, r.end_date, 'the end date is before the start date'),
  },

  tasks: {
    module: 'projects',
    label: 'Tasks',
    singular: 'Task',
    titleSql: 'title',
    order: "CASE status WHEN 'In progress' THEN 0 WHEN 'To do' THEN 1 ELSE 2 END, CASE priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END, due_date",
    fields: [
      { name: 'title', label: 'Task', type: 'text', required: true, list: true, search: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', required: true, list: true },
      { name: 'assignee_id', label: 'Assignee', type: 'ref', ref: 'employees', list: true },
      { name: 'status', label: 'Status', type: 'enum', options: ['To do', 'In progress', 'Done'], default: 'To do', list: true },
      { name: 'priority', label: 'Priority', type: 'enum', options: ['Low', 'Medium', 'High'], default: 'Medium', list: true },
      { name: 'due_date', label: 'Due', type: 'date', list: true },
    ],
  },

  timesheets: {
    module: 'projects',
    label: 'Timesheets',
    singular: 'Time entry',
    titleSql: "work_date || ' · ' || hours || 'h'",
    order: 'work_date DESC, id DESC',
    fields: [
      { name: 'employee_id', label: 'Employee', type: 'ref', ref: 'employees', required: true, list: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', list: true },
      { name: 'work_date', label: 'Date', type: 'date', required: true, default: today, list: true },
      { name: 'hours', label: 'Hours', type: 'number', required: true, min: 0.25, max: 24, step: 0.25, list: true },
      { name: 'note', label: 'Note', type: 'text', list: true, search: true },
    ],
  },

  // ------------------------------------------------------------------ Finance
  invoices: {
    module: 'finance',
    label: 'Invoices',
    singular: 'Invoice',
    titleSql: 'number',
    order: 'issue_date DESC, id DESC',
    fields: [
      { name: 'number', label: 'Number', type: 'text', readonly: true, list: true, search: true },
      { name: 'company_id', label: 'Client', type: 'ref', ref: 'companies', required: true, list: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects' },
      { name: 'issue_date', label: 'Issued', type: 'date', required: true, default: today, list: true },
      { name: 'due_date', label: 'Due', type: 'date', list: true },
      { name: 'status', label: 'Status', type: 'enum', options: ['Draft', 'Sent', 'Paid', 'Void'], default: 'Draft', list: true },
      { name: 'tax_rate', label: 'Tax %', type: 'number', min: 0, max: 100, step: 0.01, default: 0 },
      { name: 'items', label: 'Line items', type: 'items' },
      { name: 'subtotal', label: 'Subtotal', type: 'money', readonly: true },
      { name: 'tax', label: 'Tax', type: 'money', readonly: true },
      { name: 'total', label: 'Total', type: 'money', readonly: true, list: true },
      { name: 'notes', label: 'Notes', type: 'textarea' },
    ],
    check: (r) => dateOrder(r.issue_date, r.due_date, 'the due date is before the issue date'),
  },

  expenses: {
    module: 'finance',
    label: 'Expenses',
    singular: 'Expense',
    titleSql: "spent_on || ' · ' || category",
    order: 'spent_on DESC, id DESC',
    fields: [
      { name: 'spent_on', label: 'Date', type: 'date', required: true, default: today, list: true },
      { name: 'category', label: 'Category', type: 'enum', options: ['Travel', 'Software', 'Equipment', 'Office', 'Services', 'Other'], required: true, default: 'Other', list: true },
      { name: 'vendor', label: 'Vendor', type: 'text', list: true, search: true },
      { name: 'amount', label: 'Amount', type: 'money', required: true, min: 0, list: true },
      { name: 'project_id', label: 'Project', type: 'ref', ref: 'projects', list: true },
      { name: 'employee_id', label: 'Spent by', type: 'ref', ref: 'employees' },
      { name: 'status', label: 'Status', type: 'enum', options: ['Submitted', 'Approved', 'Reimbursed', 'Rejected'], default: 'Submitted', list: true },
      { name: 'note', label: 'Note', type: 'text', search: true },
    ],
  },
};

// ------------------------------------------------------------------ KPIs
RESOURCES.executives = {
  module: 'kpis',
  label: 'Executives',
  singular: 'Executive',
  titleSql: 'name',
  order: 'name',
  fields: [
    { name: 'name', label: 'Name', type: 'text', required: true, list: true, search: true },
    { name: 'role', label: 'Role', type: 'text', list: true, search: true },
    { name: 'email', label: 'Email', type: 'email', list: true },
  ],
};

RESOURCES.kpis = {
  module: 'kpis',
  label: 'KPIs',
  singular: 'KPI',
  titleSql: 'deliverable',
  order: "CASE priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, target_date",
  // % complete and status are an assessment of someone's work; each change
  // needs a new review note saying why.
  requireNote: { when: ['percent_complete', 'status'], field: 'review_note' },
  fields: [
    { name: 'executive_id', label: 'Executive', type: 'ref', ref: 'executives', required: true, list: true },
    { name: 'objective', label: 'Objective', type: 'text', required: true, search: true },
    { name: 'deliverable', label: 'Deliverable', type: 'text', required: true, list: true, search: true },
    { name: 'priority', label: 'Priority', type: 'enum', options: ['Critical', 'High', 'Medium', 'Low'], default: 'High', list: true },
    { name: 'status', label: 'Status', type: 'enum', options: ['Not Started', 'In Progress', 'On Track', 'At Risk', 'Pending Review', 'Completed'], default: 'Not Started', list: true },
    { name: 'percent_complete', label: '% complete', type: 'percent', default: 0, list: true },
    { name: 'month', label: 'Reporting month', type: 'month' },
    { name: 'target_date', label: 'Target date', type: 'date', list: true },
    { name: 'mechanism', label: 'Revenue mechanism', type: 'text', search: true },
    { name: 'target_value', label: 'Target value', type: 'money', min: 0, list: true },
    { name: 'realized', label: 'Realised', type: 'money', min: 0, list: true },
    { name: 'income_stage', label: 'Income stage', type: 'enum', options: ['Pipeline', 'Contract Signed', 'Cash Realized'], list: true },
    { name: 'review_note', label: 'Review note', type: 'textarea' },
  ],
  // Rules that tie two fields together apply when either of them changes.
  check: (r, touched) => {
    const hit = (...f) => !touched || f.some((x) => touched.has(x));
    if (hit('status', 'percent_complete') && r.status === 'Completed' && Number(r.percent_complete) < 100) {
      return 'a KPI marked Completed must be at 100%';
    }
    if (hit('income_stage', 'realized') && r.income_stage === 'Cash Realized' && !(Number(r.realized) > 0)) {
      return 'a KPI at Cash Realized needs the realised amount';
    }
    if (hit('target_date', 'month') && r.target_date && r.month && r.target_date.slice(0, 7) < r.month) {
      return `the target date ${r.target_date} is before its reporting month ${r.month}`;
    }
    return null;
  },
};

// Fail at startup, not at request time, if a definition is inconsistent.
for (const [name, r] of Object.entries(RESOURCES)) {
  if (!MODULES[r.module]?.resources.includes(name)) {
    throw new Error(`resource ${name} is not listed under module ${r.module}`);
  }
  for (const f of r.fields) {
    if (f.type === 'ref' && !RESOURCES[f.ref]) throw new Error(`${name}.${f.name} refers to unknown resource ${f.ref}`);
    if (f.type === 'enum' && !f.options?.length) throw new Error(`${name}.${f.name} is an enum with no options`);
  }
}
