-- Light Dash - a simple ERP.
-- Portable SQL: runs on node:sqlite, maps to Postgres with minor edits.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Accounts and access
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer',  -- admin | manager | member | viewer
  scopes        TEXT    NOT NULL DEFAULT '[]',      -- JSON array; what is actually enforced
  password_hash TEXT,
  password_salt TEXT,
  employee_id   INTEGER REFERENCES employees(id),   -- optional link to an HR record
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL,
  last_seen_at  TEXT,
  note          TEXT                               -- what the account is for
);

-- Browser sessions and API tokens. Only a SHA-256 of each token is stored.
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  kind         TEXT    NOT NULL DEFAULT 'session',  -- session | api
  label        TEXT,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT,
  last_used_at TEXT,
  user_agent   TEXT
);

-- Every create, update and delete, for every module. Append-only: nothing in
-- the app updates or deletes a row here. The changed values are copied in, so a
-- record's history survives the record being deleted.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY,
  at            TEXT    NOT NULL,
  actor_user_id INTEGER REFERENCES users(id),
  actor_label   TEXT    NOT NULL,
  entity        TEXT    NOT NULL,                   -- resource name, e.g. invoices
  entity_id     INTEGER NOT NULL,
  action        TEXT    NOT NULL,                   -- create | update | delete
  changes       TEXT    NOT NULL                    -- JSON {field: [from, to]}
);

-- ---------------------------------------------------------------------------
-- HR
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employees (
  id              INTEGER PRIMARY KEY,
  first_name      TEXT NOT NULL,
  last_name       TEXT NOT NULL,
  email           TEXT UNIQUE COLLATE NOCASE,
  phone           TEXT,
  department_id   INTEGER REFERENCES departments(id),
  job_title       TEXT,
  employment_type TEXT NOT NULL DEFAULT 'Full-time',  -- Full-time | Part-time | Contractor
  start_date      TEXT,
  status          TEXT NOT NULL DEFAULT 'Active',     -- Active | On leave | Left
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS time_off (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  kind        TEXT NOT NULL DEFAULT 'Vacation',       -- Vacation | Sick | Personal | Other
  start_date  TEXT NOT NULL,
  end_date    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'Requested',      -- Requested | Approved | Rejected
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- Goals are entered by hand: a manager's judgment of someone's work, not a
-- number the system computes. Changing progress or status needs a review note.
CREATE TABLE IF NOT EXISTS goals (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  title       TEXT NOT NULL,
  period      TEXT,                                   -- e.g. 2026-Q4
  progress    INTEGER NOT NULL DEFAULT 0,             -- 0..100
  status      TEXT NOT NULL DEFAULT 'Not started',    -- Not started | On track | At risk | Done
  review_note TEXT,
  created_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  industry   TEXT,
  website    TEXT,
  phone      TEXT,
  address    TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name  TEXT NOT NULL,
  email      TEXT,
  phone      TEXT,
  job_title  TEXT,
  company_id INTEGER REFERENCES companies(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deals (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  company_id     INTEGER REFERENCES companies(id),
  contact_id     INTEGER REFERENCES contacts(id),
  owner_id       INTEGER REFERENCES employees(id),
  value          REAL NOT NULL DEFAULT 0,
  stage          TEXT NOT NULL DEFAULT 'Lead',        -- Lead | Qualified | Proposal | Won | Lost
  expected_close TEXT,
  created_at     TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  company_id INTEGER REFERENCES companies(id),        -- the client, if any
  manager_id INTEGER REFERENCES employees(id),
  status     TEXT NOT NULL DEFAULT 'Planned',         -- Planned | Active | On hold | Done
  start_date TEXT,
  end_date   TEXT,
  budget     REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id),
  title       TEXT NOT NULL,
  assignee_id INTEGER REFERENCES employees(id),
  status      TEXT NOT NULL DEFAULT 'To do',          -- To do | In progress | Done
  priority    TEXT NOT NULL DEFAULT 'Medium',         -- Low | Medium | High
  due_date    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timesheets (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  project_id  INTEGER REFERENCES projects(id),
  work_date   TEXT NOT NULL,
  hours       REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Finance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id         INTEGER PRIMARY KEY,
  number     TEXT NOT NULL UNIQUE,                    -- INV-0001, assigned by the server
  company_id INTEGER NOT NULL REFERENCES companies(id),
  project_id INTEGER REFERENCES projects(id),
  issue_date TEXT NOT NULL,
  due_date   TEXT,
  status     TEXT NOT NULL DEFAULT 'Draft',           -- Draft | Sent | Paid | Void
  tax_rate   REAL NOT NULL DEFAULT 0,                 -- percent, e.g. 7.5
  subtotal   REAL NOT NULL DEFAULT 0,                 -- computed from the lines, never typed in
  tax        REAL NOT NULL DEFAULT 0,
  total      REAL NOT NULL DEFAULT 0,
  notes      TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          INTEGER PRIMARY KEY,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  description TEXT    NOT NULL,
  quantity    REAL    NOT NULL,
  unit_price  REAL    NOT NULL,
  amount      REAL    NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY,
  spent_on    TEXT NOT NULL,
  category    TEXT NOT NULL,                          -- Travel | Software | Equipment | Office | Services | Other
  vendor      TEXT,
  amount      REAL NOT NULL CHECK (amount >= 0),
  project_id  INTEGER REFERENCES projects(id),
  employee_id INTEGER REFERENCES employees(id),
  status      TEXT NOT NULL DEFAULT 'Submitted',      -- Submitted | Approved | Reimbursed | Rejected
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_entity   ON audit_log(entity, entity_id, at);
CREATE INDEX IF NOT EXISTS idx_audit_at       ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_employees_dept ON employees(department_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage    ON deals(stage);
CREATE INDEX IF NOT EXISTS idx_tasks_project  ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_time_date      ON timesheets(work_date);
CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoices(status, issue_date);
CREATE INDEX IF NOT EXISTS idx_items_invoice  ON invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date  ON expenses(spent_on);
