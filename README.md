# Light Dash

A simple ERP: people, customers, projects and money in one place. Modelled on
the core of [ever-gauzy](https://github.com/ever-co/ever-gauzy), without the
weight — **no build step**. Locally it is one Node process and one SQLite file,
with nothing to install. Online it runs on [Netlify](#deploy-to-netlify) on
Postgres, and its only dependency is the `pg` driver.

| Module | What it holds |
|---|---|
| **HR** | employees, departments, time off, goals |
| **CRM** | companies, contacts, a deal pipeline |
| **Projects** | projects, tasks, timesheets |
| **Finance** | invoices with line items, expenses |
| **KPIs** | leadership KPIs per executive: overview, entry and assessment |
| **Dashboard** | pipeline, revenue against expenses, hours, headcount — only the parts you can see |
| **Audit log** | every create, change and delete, by whom (admins only) |

## Run it

Needs Node 22.5 or newer — nothing else.

```bash
node server/seed.mjs
node server/users.mjs create --email you@example.com --name "Your Name" --role admin
node server/server.mjs
```

Open <http://127.0.0.1:4400> and sign in. `seed.mjs` loads demo data; skip it
to start empty. `users.mjs create` writes the generated password to
`data/secrets/` rather than printing it — read it, then delete the file.

**The demo data is invented** — the people, the companies (Acme Corp, Example
Retail Ltd and so on) and every number. To reload fresh demo data later, run
`node server/seed.mjs --reset`; it wipes the demo records first. Accounts and
KPI data are never touched.

| Variable | Default | |
|---|---|---|
| `PORT` | `4400` | |
| `HOST` | `127.0.0.1` | localhost-only until you change it |
| `LIGHTDASH_DB` | `data/lightdash.db` | |
| `LIGHTDASH_SECURE_COOKIES` | off | set `1` when served over HTTPS |
| `LIGHTDASH_DATABASE_URL` | — | a Postgres connection string; when set, it is used instead of SQLite |

The database is chosen from the first of these that is set:
`LIGHTDASH_DATABASE_URL`, `NETLIFY_DB_URL`, `NETLIFY_DATABASE_URL`, `DATABASE_URL`.
If none is set, the SQLite file is used. Every script (`server.mjs`, `seed.mjs`,
`users.mjs`, `import-kpis.mjs`) prints which database it is using before it
writes anything.

## KPIs

The **KPIs** module holds real leadership data, so it is kept apart from the
demo: its own tables (`executives`, `kpis`), never touched by
`seed.mjs --reset`, nor is its audit history.

**Load a KPI workbook** — a tracker sheet with one row per deliverable:

```bash
node server/import-kpis.mjs "<KPI workbook.xlsx>" --dry-run
node server/import-kpis.mjs "<KPI workbook.xlsx>"
```

The data goes into your local database only (`data/`, which git ignores). The
workbook and its contents are never written into this repository.

- **Imported as written.** Where the workbook breaks a rule — a target date
  before its own reporting month, an executive on the summary sheet with no
  deliverables, a summary total that does not add up — the row is kept as the
  sheet has it and **flagged on the KPI overview**, not silently corrected. Fix
  it in the app and the flag clears.
- **After that, KPIs are entered by hand.** They are a judgment about someone's
  work. Changing % complete or status needs a new review note; a KPI marked
  Completed must be at 100%; Cash Realized needs the realised amount; a target
  date cannot fall before its reporting month.
- **Re-importing never overwrites an assessment.** A KPI someone has changed in
  the app is skipped and listed, unless `--overwrite-manual` is passed.
  Re-importing an unchanged workbook writes nothing.

The overview leads with **verified income realised against target value** —
target value is the stated impact, not booked revenue.

## Accounts and permissions

Each module has a read and a write permission (`hr:read`, `hr:write`,
`crm:…`, `projects:…`, `finance:…`, `kpis:…`), plus `admin`. Roles are bundles:

| Role | Can |
|---|---|
| `admin` | everything, including the audit log |
| `manager` | read and write every module, except entering KPIs |
| `member` | read HR, CRM, projects and KPIs; write projects and log time |
| `viewer` | read every module, change nothing |

`kpis:write` is held by admins only, so nobody rates their own work by default.
Grant it to someone with `users.mjs scopes`.

The server enforces this on every request, and refuses to start if any route
lacks a permission. The UI only mirrors it: tabs you cannot read are hidden, and
records you cannot change open read-only.

```bash
node server/users.mjs list
node server/users.mjs create --email a@b.c --name "A B" --role member
node server/users.mjs scopes --email a@b.c --scopes hr:read,projects:read,projects:write
node server/users.mjs token  --email a@b.c --label "Reporting script" --days 90
node server/users.mjs passwd --email a@b.c
node server/users.mjs disable --email a@b.c
```

Passwords are scrypt hashes; session and API tokens are stored as SHA-256 only;
sign-in locks out after eight failures; cross-site writes are refused; every
response carries a strict Content-Security-Policy.

## Rules the app enforces

- **Invoices** are numbered by the server (`INV-0001`…) and their subtotal, tax
  and total are calculated from the line items — a client cannot set them. Once
  an invoice is **Paid** or **Void**, only its status and notes can change, and
  only **Draft** invoices can be deleted.
- **Goals** are entered by hand. Changing a goal's progress or status needs a
  new review note explaining the assessment, and a goal marked Done must be at 100%.
- Dates must be real calendar dates; time off and projects cannot end before
  they start; timesheet hours are between 0.25 and 24.
- A record that other records still point at — a department with employees, a
  company with invoices — cannot be deleted.
- Every change is written to the **audit log** in the same transaction as the
  change, with the old and new value of every field. Nothing in the app edits or
  deletes audit entries.

## How it is built

```
server/
  resources.mjs   every record type, described once: fields, types, rules, module
  crud.mjs        list / read / create / update / delete / history for all of them
  app.mjs         the API: sign-in, permissions, dashboard, routes
  server.mjs      local HTTP server: the API plus the files in web/
  db.mjs          one interface over SQLite (local) and Postgres (hosted)
  auth.mjs        passwords, sessions, tokens, scopes
  schema.sql      tables (SQLite)
  migrate.mjs     apply the Postgres migrations to a non-Netlify Postgres
  copy-to-postgres.mjs  move a local install's accounts and KPIs online
  seed.mjs        demo data (never touches KPIs)
  import-kpis.mjs load a KPI workbook into the KPI module
  xlsx.mjs        a small .xlsx reader, no dependencies
  users.mjs       account administration
netlify/
  functions/api.mjs              the API as a Netlify Function
  database/migrations/*.sql      tables (Postgres)
test/schema-parity.mjs  fails if the SQLite and Postgres tables disagree
web/              the app: vanilla JS, inline SVG charts
```

The forms in the browser are generated from the same definitions the server
validates against (`/api/schema`), so **adding a field is one edit in
`resources.mjs`** plus a column in `schema.sql` — and a new migration in
`netlify/database/migrations/` for Postgres. Never edit a migration that has
been applied; add a new one. `npm run test:schema` checks the two agree.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/auth/login` | email + password; sets the session cookie |
| GET | `/api/schema` | the record types and modules this account can see |
| GET | `/api/dashboard` | dashboard figures, filtered to your permissions |
| GET | `/api/r/:type?q=&field=value` | list, with search and exact-match filters |
| GET | `/api/r/:type/:id` | one record (invoices include their lines) |
| POST / PATCH / DELETE | `/api/r/:type[/:id]` | change records |
| GET | `/api/r/:type/:id/history` | that record's audit trail |
| GET | `/api/audit` | the full audit log (admin) |
| GET | `/api/kpi-summary` | KPI overview figures and data-quality flags (`kpis:read`) |

`:type` is one of `employees`, `departments`, `time_off`, `goals`, `companies`,
`contacts`, `deals`, `projects`, `tasks`, `timesheets`, `invoices`, `expenses`,
`executives`, `kpis`.

## Deploy to Netlify

The pages in `web/` are served as static files, and every `/api/*` request
goes to one Netlify Function (`netlify/functions/api.mjs`) running the same
code as the local server. The data goes in Postgres, not in a file: functions
have no disk that lasts between requests. `netlify.toml` holds all the build
settings, so there is nothing to configure beyond the database.

1. In Netlify, choose **Add new project → Import an existing project** and
   pick this GitHub repository. Leave the build settings as they come from
   `netlify.toml`.
2. Give it a database — either option below.
3. Create the first account (or move your existing one) — see
   [Getting your data online](#getting-your-data-online).

Until a database is connected the site loads, but every API call answers
`503` with a message saying so.

### Option A: Netlify Database

Netlify's own Postgres needs a credit-based Netlify plan. It sets
`NETLIFY_DB_URL` for the function automatically, and it applies the files in
`netlify/database/migrations/` itself on every deploy — so you do not run
`migrate.mjs`, and the script refuses if you try.

**Deploy previews copy your production data.** Netlify gives each deploy
preview its own copy of the production database, and preview links are
public by default. Since this database holds staff records and KPI
assessments, either turn deploy previews off or put password protection on
them before your first pull request.

### Option B: any other Postgres

Neon, Supabase, RDS or your own server all work, on any Netlify plan.

1. Create the database and copy its connection string.
2. In the Netlify site, **Project configuration → Environment variables**, add
   `DATABASE_URL` with that string, available to **Functions**. Redeploy.
3. Create the tables from your own machine:

   ```bash
   DATABASE_URL='postgres://…' npm run migrate
   ```

   Run it again after pulling a change that adds a migration;
   `npm run migrate -- --status` shows what is applied and what is pending.

### Getting your data online

Run these on your own machine with the hosted connection string set as
`DATABASE_URL` in your shell. Each prints the database it is about to use —
check it says Postgres and the right host.

To start fresh, create the first admin exactly as you would locally:

```bash
DATABASE_URL='postgres://…' node server/users.mjs create --email you@example.com --name "Your Name" --role admin
```

To move an existing local install instead, copy it across:

```bash
DATABASE_URL='postgres://…' npm run copy-to-postgres -- --dry-run
DATABASE_URL='postgres://…' npm run copy-to-postgres
```

This copies accounts, executives, KPIs and their audit history. HR, CRM,
project and finance records are left behind unless you add
`--include-demo`, so invented demo data does not end up in production. The
copy only goes into an empty database, lands in one transaction, keeps every
id, and checks the KPI totals match before it commits. Your local SQLite file
is opened read-only. Everyone signs in again afterwards.

Online, HTTPS and the `Secure` cookie flag are automatic. Sessions and the
sign-in throttle live in the database, so they work across however many copies
of the function Netlify runs.

## Self-hosting

To run `server.mjs` on your own server instead, keep it on `127.0.0.1` until
all of these hold:

1. HTTPS terminates in front of it (Caddy, nginx, a cloud load balancer).
2. `LIGHTDASH_SECURE_COOKIES=1` is set.
3. On SQLite, it runs as **one** process — SQLite wants one writer. On
   Postgres, run as many as you like.
4. The database is backed up and access-controlled — it holds your records.

## Not built

No payments or bank feeds, no PDF invoices, no multi-currency, no inventory, no
payroll, no email, no file attachments, no multi-factor sign-in, and no
automated test suite in the repository yet beyond the schema check. Revenue on the dashboard is counted
by the month a paid invoice was *issued*, since invoices carry no payment date.
