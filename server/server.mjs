/**
 * Light Dash - a simple ERP. One process: JSON API + the web app.
 * No dependencies. Node 22.5+ (node:sqlite).
 *
 *   node server/server.mjs           -> http://127.0.0.1:4400
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, all, one } from './db.mjs';
import { RESOURCES, localToday } from './resources.mjs';
import * as crud from './crud.mjs';
import { HttpError } from './crud.mjs';
import {
  verifyPassword, createSession, revokeSession, userForToken, hasScope,
  tokenFromRequest, sessionCookie, clearCookie, loginBlocked, noteFailure,
  clearFailures, SCOPES,
} from './auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', 'web');
const PORT = Number(process.env.PORT || 4400);
const HOST = process.env.HOST || '127.0.0.1';
const SECURE_COOKIES = process.env.LIGHTDASH_SECURE_COOKIES === '1';

const db = open();

// ---------------------------------------------------------------- responses
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(SECURE_COOKIES ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
};

function send(res, code, body, extra = {}) {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(json);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

// ---------------------------------------------------------------- access
const readScope = (module) => `${module}:read`;
const writeScope = (module) => `${module}:write`;
const moduleOf = (resName) => crud.resourceOr404(resName).module;

/**
 * May this user pick from a resource's list in a form? Yes if they can read
 * that module, or can write a record type that links to it - a CRM user filling
 * in a deal's owner needs the employee names, not the HR module.
 */
function canPick(user, resName) {
  const target = crud.resourceOr404(resName);
  if (hasScope(user, readScope(target.module))) return true;
  return Object.values(RESOURCES).some(
    (r) => hasScope(user, writeScope(r.module)) && r.fields.some((f) => f.type === 'ref' && f.ref === resName),
  );
}

const actorOf = (user) => ({ userId: user.id, label: `${user.name} <${user.email}>` });
const userView = (u) => ({ name: u.name, email: u.email, role: u.role, scopes: u.scopes });

// ---------------------------------------------------------------- dashboard
function dashboard(user) {
  const out = {};
  const todayIso = localToday();
  const monthStart = `${todayIso.slice(0, 7)}-01`;
  const [yy, mm] = todayIso.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(yy, mm - 1 - i, 1));
    months.push(m.toISOString().slice(0, 7));
  }

  if (hasScope(user, 'hr:read')) {
    out.hr = {
      headcount: one(db, "SELECT COUNT(*) AS n FROM employees WHERE status != 'Left'").n,
      by_department: all(
        db,
        `SELECT COALESCE(d.name, 'No department') AS label, COUNT(e.id) AS n
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id
          WHERE e.status != 'Left' GROUP BY d.id ORDER BY n DESC`,
      ),
      time_off_pending: one(db, "SELECT COUNT(*) AS n FROM time_off WHERE status = 'Requested'").n,
      out_next_14_days: one(
        db,
        `SELECT COUNT(DISTINCT employee_id) AS n FROM time_off
          WHERE status = 'Approved' AND start_date <= date(?, '+14 days') AND end_date >= ?`,
        todayIso, todayIso,
      ).n,
      goals_by_status: all(db, 'SELECT status AS label, COUNT(*) AS n FROM goals GROUP BY status ORDER BY n DESC'),
    };
  }

  if (hasScope(user, 'crm:read')) {
    out.crm = {
      pipeline: all(
        db,
        `SELECT stage AS label, COUNT(*) AS n, COALESCE(SUM(value), 0) AS value FROM deals
          WHERE stage IN ('Lead', 'Qualified', 'Proposal') GROUP BY stage
          ORDER BY CASE stage WHEN 'Lead' THEN 0 WHEN 'Qualified' THEN 1 ELSE 2 END`,
      ),
      open_value: one(db, "SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage IN ('Lead','Qualified','Proposal')").v,
      won_this_year: one(
        db,
        "SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage = 'Won' AND substr(COALESCE(expected_close, created_at), 1, 4) = ?",
        todayIso.slice(0, 4),
      ).v,
      companies: one(db, 'SELECT COUNT(*) AS n FROM companies').n,
    };
  }

  if (hasScope(user, 'projects:read')) {
    out.projects = {
      active: one(db, "SELECT COUNT(*) AS n FROM projects WHERE status = 'Active'").n,
      overdue_tasks: one(db, "SELECT COUNT(*) AS n FROM tasks WHERE status != 'Done' AND due_date < ?", todayIso).n,
      open_tasks: one(db, "SELECT COUNT(*) AS n FROM tasks WHERE status != 'Done'").n,
      hours_this_month: one(db, 'SELECT COALESCE(SUM(hours), 0) AS h FROM timesheets WHERE work_date >= ?', monthStart).h,
      hours_by_project: all(
        db,
        `SELECT COALESCE(p.name, 'No project') AS label, SUM(t.hours) AS hours
           FROM timesheets t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.work_date >= ? GROUP BY p.id ORDER BY hours DESC LIMIT 6`,
        monthStart,
      ),
    };
  }

  if (hasScope(user, 'finance:read')) {
    const byMonth = (sql) => {
      const rows = new Map(all(db, sql, `${months[0]}-01`).map((r) => [r.month, r.total]));
      return months.map((m) => ({ month: m, total: rows.get(m) || 0 }));
    };
    out.finance = {
      // Invoices carry no payment date, so revenue is counted in the month the
      // paid invoice was issued. Good enough for a trend; not an accounting ledger.
      revenue: byMonth(
        "SELECT substr(issue_date, 1, 7) AS month, SUM(total) AS total FROM invoices WHERE status = 'Paid' AND issue_date >= ? GROUP BY month",
      ),
      expenses: byMonth(
        "SELECT substr(spent_on, 1, 7) AS month, SUM(amount) AS total FROM expenses WHERE status IN ('Approved','Reimbursed') AND spent_on >= ? GROUP BY month",
      ),
      outstanding: one(db, "SELECT COALESCE(SUM(total), 0) AS v FROM invoices WHERE status = 'Sent'").v,
      overdue: one(
        db,
        "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS v FROM invoices WHERE status = 'Sent' AND due_date < ?",
        todayIso,
      ),
      expenses_awaiting: one(db, "SELECT COUNT(*) AS n FROM expenses WHERE status = 'Submitted'").n,
    };
  }
  return out;
}

// ---------------------------------------------------------------- KPI overview
function kpiSummary() {
  const rows = all(
    db,
    `SELECT k.*, e.name AS executive FROM kpis k JOIN executives e ON e.id = k.executive_id`,
  );
  const sum = (f) => rows.reduce((a, r) => a + (r[f] || 0), 0);
  const group = (field) => all(
    db,
    `SELECT COALESCE(${field}, '(not set)') AS label, COUNT(*) AS n,
            COALESCE(SUM(target_value), 0) AS target, COALESCE(SUM(realized), 0) AS realized
       FROM kpis GROUP BY ${field} ORDER BY target DESC`,
  );

  // Problems in the data, recomputed from what is stored now - so editing a row
  // clears its flag, and nothing is presented as cleaner than it is.
  const checks = [];
  for (const r of rows) {
    if (r.month && r.target_date && r.target_date.slice(0, 7) < r.month) {
      checks.push({ kpi_id: r.id, who: r.executive, what: `"${r.deliverable}" has a target date (${r.target_date}) before its reporting month (${r.month})` });
    }
    if (r.status === 'Completed' && r.percent_complete < 100) {
      checks.push({ kpi_id: r.id, who: r.executive, what: `"${r.deliverable}" is Completed at ${r.percent_complete}%` });
    }
    if (r.income_stage === 'Cash Realized' && !(r.realized > 0)) {
      checks.push({ kpi_id: r.id, who: r.executive, what: `"${r.deliverable}" is at Cash Realized with nothing realised` });
    }
  }
  const byExecutive = all(
    db,
    `SELECT e.id, e.name, e.role, COUNT(k.id) AS kpis,
            SUM(CASE WHEN k.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
            AVG(k.percent_complete) AS mean_pct,
            COALESCE(SUM(k.target_value), 0) AS target,
            COALESCE(SUM(k.realized), 0) AS realized
       FROM executives e LEFT JOIN kpis k ON k.executive_id = e.id
      GROUP BY e.id ORDER BY target DESC, e.name`,
  );
  for (const e of byExecutive) {
    if (!e.kpis) checks.push({ who: e.name, what: 'is on the roster but has no KPIs recorded' });
  }

  const lastImport = one(
    db,
    "SELECT actor_label, MAX(at) AS at FROM audit_log WHERE entity = 'kpis' AND actor_label LIKE 'import:%'",
  );
  return {
    totals: {
      kpis: rows.length,
      executives: byExecutive.filter((e) => e.kpis).length,
      roster: byExecutive.length,
      target: sum('target_value'),
      realized: sum('realized'),
      mean_pct: rows.length ? sum('percent_complete') / rows.length : 0,
      completed: rows.filter((r) => r.status === 'Completed').length,
      high_priority: rows.filter((r) => ['Critical', 'High'].includes(r.priority)).length,
    },
    by_executive: byExecutive,
    by_stage: group('income_stage'),
    by_mechanism: group('mechanism'),
    checks,
    last_import: lastImport?.at ? { source: lastImport.actor_label.slice(7), at: lastImport.at } : null,
  };
}

// ---------------------------------------------------------------- routes
// [method, pattern, scope, handler]. scope is null (public), '*' (any signed-in
// account), a scope name, or a function of the URL match returning one.
const routes = [
  ['GET', /^\/api\/health$/, null, () => ({ ok: true })],

  ['POST', /^\/api\/auth\/login$/, null, (_m, _url, body, ctx) => {
    const email = String(body.email || '').trim().toLowerCase();
    const key = `${ctx.req.socket.remoteAddress || '?'}|${email}`;
    if (loginBlocked(key)) throw new HttpError(429, 'too many failed attempts; try again in 15 minutes');
    const user = one(db, 'SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
    if (!(user && user.active && verifyPassword(body.password, user))) {
      noteFailure(key);
      throw new HttpError(401, 'email or password is incorrect');
    }
    clearFailures(key);
    const token = createSession(db, user.id, { userAgent: String(ctx.req.headers['user-agent'] || '').slice(0, 200) });
    ctx.cookie = sessionCookie(token, { secure: SECURE_COOKIES });
    return { user: { name: user.name, email: user.email, role: user.role, scopes: JSON.parse(user.scopes) } };
  }],

  ['POST', /^\/api\/auth\/logout$/, '*', (_m, _url, _b, ctx) => {
    const token = tokenFromRequest(ctx.req);
    if (token) revokeSession(db, token);
    ctx.cookie = clearCookie();
    return { ok: true };
  }],

  ['GET', /^\/api\/auth\/me$/, '*', (_m, _url, _b, ctx) => ({ user: userView(ctx.user) })],

  // What this account can see, for building the navigation and forms.
  ['GET', /^\/api\/schema$/, '*', (_m, _url, _b, ctx) =>
    crud.publicSchema((mod) => hasScope(ctx.user, readScope(mod)), (mod) => hasScope(ctx.user, writeScope(mod)))],

  ['GET', /^\/api\/dashboard$/, '*', (_m, _url, _b, ctx) => dashboard(ctx.user)],

  ['GET', /^\/api\/kpi-summary$/, 'kpis:read', () => kpiSummary()],

  ['GET', /^\/api\/audit$/, 'admin', (_m, url) => {
    const params = [];
    const where = [];
    for (const k of ['entity', 'action']) {
      const v = url.searchParams.get(k);
      if (v) { where.push(`${k} = ?`); params.push(v); }
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    return {
      events: all(
        db,
        `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY at DESC, id DESC LIMIT ?`,
        ...params, limit,
      ).map((e) => ({ ...e, changes: JSON.parse(e.changes || '{}') })),
    };
  }],

  ['GET', /^\/api\/options\/(\w+)$/, '*', (m, _url, _b, ctx) => {
    if (!canPick(ctx.user, m[1])) throw new HttpError(403, `this account cannot list ${m[1]}`);
    return { options: crud.options(db, m[1]) };
  }],

  ['GET', /^\/api\/r\/(\w+)$/, (m) => readScope(moduleOf(m[1])), (m, url) => crud.list(db, m[1], url)],
  ['GET', /^\/api\/r\/(\w+)\/(\d+)$/, (m) => readScope(moduleOf(m[1])), (m) => crud.get(db, m[1], m[2])],
  ['GET', /^\/api\/r\/(\w+)\/(\d+)\/history$/, (m) => readScope(moduleOf(m[1])), (m) => ({ events: crud.history(db, m[1], m[2]) })],
  ['POST', /^\/api\/r\/(\w+)$/, (m) => writeScope(moduleOf(m[1])), (m, _url, body, ctx) => crud.create(db, m[1], body, actorOf(ctx.user))],
  ['PATCH', /^\/api\/r\/(\w+)\/(\d+)$/, (m) => writeScope(moduleOf(m[1])), (m, _url, body, ctx) => crud.patch(db, m[1], m[2], body, actorOf(ctx.user))],
  ['DELETE', /^\/api\/r\/(\w+)\/(\d+)$/, (m) => writeScope(moduleOf(m[1])), (m, _url, _b, ctx) => crud.remove(db, m[1], m[2], actorOf(ctx.user))],
];

// A route without a valid scope would be open to anyone, so refuse to start.
for (const route of routes) {
  const [method, pattern, scope, handler] = route;
  const where = `route ${method} ${pattern}`;
  if (route.length !== 4 || typeof handler !== 'function') {
    throw new Error(`${where} must be [method, pattern, scope, handler]`);
  }
  const ok = scope === null || scope === '*' || typeof scope === 'function' || Object.hasOwn(SCOPES, scope);
  if (!ok) throw new Error(`${where} declares unknown scope ${JSON.stringify(scope)}`);
}

// ---------------------------------------------------------------- static files
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(WEB, rel));
  if (!target.startsWith(normalize(WEB))) return send(res, 403, { error: 'forbidden' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
      return await serveStatic(url.pathname, res);
    }

    const byPath = routes.filter(([, pattern]) => pattern.test(url.pathname));
    const route = byPath.find(([method]) => method === req.method);
    if (!route) {
      if (byPath.length) return send(res, 405, { error: `use ${[...new Set(byPath.map(([m]) => m))].join(' or ')} on this path` });
      return send(res, 404, { error: 'no such endpoint' });
    }

    const [, pattern, scopeDef, handler] = route;
    const match = url.pathname.match(pattern);
    const user = userForToken(db, tokenFromRequest(req));
    const scope = typeof scopeDef === 'function' ? scopeDef(match) : scopeDef;
    if (scope !== null) {
      if (!user) return send(res, 401, { error: 'authentication required' });
      if (scope !== '*' && !hasScope(user, scope)) {
        return send(res, 403, { error: `this account does not have the "${scope}" permission` });
      }
    }
    // Cookie-authenticated writes must come from this origin. Bearer tokens are
    // never attached by a browser on its own, so they cannot be borrowed.
    if (user && user.session_kind === 'session' && req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin) {
        let same = false;
        try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
        if (!same) return send(res, 403, { error: 'cross-origin write refused' });
      }
    }

    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const ctx = { user, req };
    const out = await handler(match, url, body, ctx);
    return send(res, 200, out, ctx.cookie ? { 'set-cookie': ctx.cookie } : {});
  } catch (err) {
    const code = err.httpCode || 500;
    if (code === 500) console.error(err);
    return send(res, code, { error: code === 500 ? 'internal error' : err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Light Dash  ->  http://${HOST}:${PORT}`);
  if (!one(db, 'SELECT COUNT(*) AS n FROM users WHERE active = 1').n) {
    console.log('  No accounts yet. Create one:');
    console.log('    node server/users.mjs create --email you@example.com --name "Your Name" --role admin');
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !SECURE_COOKIES) {
    console.warn('  WARNING: listening beyond localhost without LIGHTDASH_SECURE_COOKIES=1. Put TLS in front first.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
