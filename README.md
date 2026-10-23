# Light Dash

A simple ERP: people, customers, projects and money in one place. Modelled on
the core of [ever-gauzy](https://github.com/ever-co/ever-gauzy), without the
weight — one Node process, one SQLite file, **no dependencies, no build step**.

| Module | What it holds |
|---|---|
| **HR** | employees, departments, time off, goals |
| **CRM** | companies, contacts, a deal pipeline |
| **Projects** | projects, tasks, timesheets |
| **Finance** | invoices with line items, expenses |
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
`node server/seed.mjs --reset`; it wipes every record first (accounts are kept).

| Variable | Default | |
|---|---|---|
| `PORT` | `4400` | |
| `HOST` | `127.0.0.1` | localhost-only until you change it |
| `LIGHTDASH_DB` | `data/lightdash.db` | |
| `LIGHTDASH_SECURE_COOKIES` | off | set `1` when served over HTTPS |

## Accounts and permissions

Each module has a read and a write permission (`hr:read`, `hr:write`,
`crm:…`, `projects:…`, `finance:…`), plus `admin`. Roles are bundles:

| Role | Can |
|---|---|
| `admin` | everything, including the audit log |
| `manager` | read and write every module |
| `member` | read HR, CRM and projects; write projects and log time |
| `viewer` | read every module, change nothing |

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
  server.mjs      HTTP, sign-in, permissions, dashboard, static files
  auth.mjs        passwords, sessions, tokens, scopes
  schema.sql      tables
  seed.mjs        demo data
  users.mjs       account administration
web/              the app: vanilla JS, inline SVG charts
```

The forms in the browser are generated from the same definitions the server
validates against (`/api/schema`), so **adding a field is one edit in
`resources.mjs`** plus a column in `schema.sql`.

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

`:type` is one of `employees`, `departments`, `time_off`, `goals`, `companies`,
`contacts`, `deals`, `projects`, `tasks`, `timesheets`, `invoices`, `expenses`.

## Hosting

Keep it on `127.0.0.1` until all of these hold:

1. HTTPS terminates in front of it (Caddy, nginx, a cloud load balancer).
2. `LIGHTDASH_SECURE_COOKIES=1` is set.
3. It runs as **one** process — the sign-in throttle is in memory and SQLite
   wants one writer.
4. `data/` is backed up and access-controlled — it holds your records.

## Not built

No payments or bank feeds, no PDF invoices, no multi-currency, no inventory, no
payroll, no email, no file attachments, no multi-factor sign-in, and no
automated test suite in the repository yet. Revenue on the dashboard is counted
by the month a paid invoice was *issued*, since invoices carry no payment date.
