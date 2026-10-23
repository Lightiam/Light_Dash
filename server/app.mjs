/**
 * Light Dash request handling, independent of how requests arrive.
 *
 *   handle({ method, url, headers, body, ip, secure }) -> { status, headers, body }
 *
 * Two thin adapters call this: server/server.mjs (node:http, for running on
 * your own machine) and netlify/functions/api.mjs (Netlify Functions). Neither
 * contains any application logic.
 */
import { open } from './db.mjs';
import { RESOURCES, localToday } from './resources.mjs';
import * as crud from './crud.mjs';
import { HttpError } from './crud.mjs';
import {
  verifyPassword, createSession, revokeSession, userForToken, hasScope,
  tokenFromRequest, sessionCookie, clearCookie, loginBlocked, noteFailure,
  clearFailures, SCOPES,
} from './auth.mjs';

const MAX_BODY = 1_000_000;

// ---------------------------------------------------------------- responses
const baseHeaders = (secure) => ({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
});

const json = (status, body, secure, extra = {}) => ({
  status,
  headers: {
    ...baseHeaders(secure),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  },
  body: JSON.stringify(body),
});

export const securityHeaders = baseHeaders;

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

/** YYYY-MM-DD plus n days, computed here so the SQL stays the same on both databases. */
const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------- dashboard
async function dashboard(db, user) {
  const out = {};
  const todayIso = localToday();
  const monthStart = `${todayIso.slice(0, 7)}-01`;
  const [yy, mm] = todayIso.split('-').map(Number);
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(yy, mm - 1 - i, 1));
    months.push(m.toISOString().slice(0, 7));
  }
  const n = async (sql, ...p) => (await db.one(sql, ...p)).n;

  if (hasScope(user, 'hr:read')) {
    out.hr = {
      headcount: await n("SELECT COUNT(*) AS n FROM employees WHERE status != 'Left'"),
      by_department: await db.all(
        `SELECT COALESCE(d.name, 'No department') AS label, COUNT(e.id) AS n
           FROM employees e LEFT JOIN departments d ON d.id = e.department_id
          WHERE e.status != 'Left' GROUP BY d.id, d.name ORDER BY n DESC`,
      ),
      time_off_pending: await n("SELECT COUNT(*) AS n FROM time_off WHERE status = 'Requested'"),
      out_next_14_days: await n(
        `SELECT COUNT(DISTINCT employee_id) AS n FROM time_off
          WHERE status = 'Approved' AND start_date <= ? AND end_date >= ?`,
        addDays(todayIso, 14), todayIso,
      ),
      goals_by_status: await db.all('SELECT status AS label, COUNT(*) AS n FROM goals GROUP BY status ORDER BY n DESC'),
    };
  }

  if (hasScope(user, 'crm:read')) {
    out.crm = {
      pipeline: await db.all(
        `SELECT stage AS label, COUNT(*) AS n, COALESCE(SUM(value), 0) AS value FROM deals
          WHERE stage IN ('Lead', 'Qualified', 'Proposal') GROUP BY stage
          ORDER BY CASE stage WHEN 'Lead' THEN 0 WHEN 'Qualified' THEN 1 ELSE 2 END`,
      ),
      open_value: (await db.one("SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage IN ('Lead','Qualified','Proposal')")).v,
      won_this_year: (await db.one(
        "SELECT COALESCE(SUM(value), 0) AS v FROM deals WHERE stage = 'Won' AND substr(COALESCE(expected_close, created_at), 1, 4) = ?",
        todayIso.slice(0, 4),
      )).v,
      companies: await n('SELECT COUNT(*) AS n FROM companies'),
    };
  }

  if (hasScope(user, 'projects:read')) {
    out.projects = {
      active: await n("SELECT COUNT(*) AS n FROM projects WHERE status = 'Active'"),
      overdue_tasks: await n("SELECT COUNT(*) AS n FROM tasks WHERE status != 'Done' AND due_date < ?", todayIso),
      open_tasks: await n("SELECT COUNT(*) AS n FROM tasks WHERE status != 'Done'"),
      hours_this_month: (await db.one('SELECT COALESCE(SUM(hours), 0) AS h FROM timesheets WHERE work_date >= ?', monthStart)).h,
      hours_by_project: await db.all(
        `SELECT COALESCE(p.name, 'No project') AS label, SUM(t.hours) AS hours
           FROM timesheets t LEFT JOIN projects p ON p.id = t.project_id
          WHERE t.work_date >= ? GROUP BY p.id, p.name ORDER BY hours DESC LIMIT 6`,
        monthStart,
      ),
    };
  }

  if (hasScope(user, 'finance:read')) {
    const byMonth = async (sql) => {
      const rows = new Map((await db.all(sql, `${months[0]}-01`)).map((r) => [r.month, r.total]));
      return months.map((m) => ({ month: m, total: rows.get(m) || 0 }));
    };
    out.finance = {
      // Invoices carry no payment date, so revenue is counted in the month the
      // paid invoice was issued. Good enough for a trend; not an accounting ledger.
      revenue: await byMonth(
        "SELECT substr(issue_date, 1, 7) AS month, SUM(total) AS total FROM invoices WHERE status = 'Paid' AND issue_date >= ? GROUP BY substr(issue_date, 1, 7)",
      ),
      expenses: await byMonth(
        "SELECT substr(spent_on, 1, 7) AS month, SUM(amount) AS total FROM expenses WHERE status IN ('Approved','Reimbursed') AND spent_on >= ? GROUP BY substr(spent_on, 1, 7)",
      ),
      outstanding: (await db.one("SELECT COALESCE(SUM(total), 0) AS v FROM invoices WHERE status = 'Sent'")).v,
      overdue: await db.one(
        "SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS v FROM invoices WHERE status = 'Sent' AND due_date < ?",
        todayIso,
      ),
      expenses_awaiting: await n("SELECT COUNT(*) AS n FROM expenses WHERE status = 'Submitted'"),
    };
  }
  return out;
}

// ---------------------------------------------------------------- KPI overview
async function kpiSummary(db) {
  const rows = await db.all('SELECT k.*, e.name AS executive FROM kpis k JOIN executives e ON e.id = k.executive_id');
  const sum = (f) => rows.reduce((a, r) => a + (r[f] || 0), 0);
  const group = (field) => db.all(
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
  const byExecutive = await db.all(
    `SELECT e.id, e.name, e.role, COUNT(k.id) AS kpis,
            SUM(CASE WHEN k.status = 'Completed' THEN 1 ELSE 0 END) AS completed,
            AVG(k.percent_complete) AS mean_pct,
            COALESCE(SUM(k.target_value), 0) AS target,
            COALESCE(SUM(k.realized), 0) AS realized
       FROM executives e LEFT JOIN kpis k ON k.executive_id = e.id
      GROUP BY e.id, e.name, e.role ORDER BY target DESC, e.name`,
  );
  for (const e of byExecutive) {
    if (!e.kpis) checks.push({ who: e.name, what: 'is on the roster but has no KPIs recorded' });
  }

  const lastImport = await db.one(
    "SELECT actor_label, at FROM audit_log WHERE entity = 'kpis' AND actor_label LIKE 'import:%' ORDER BY at DESC LIMIT 1",
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
    by_stage: await group('income_stage'),
    by_mechanism: await group('mechanism'),
    checks,
    last_import: lastImport ? { source: lastImport.actor_label.slice(7), at: lastImport.at } : null,
  };
}

// ---------------------------------------------------------------- routes
// [method, pattern, scope, handler]. scope is null (public), '*' (any signed-in
// account), a scope name, or a function of the URL match returning one.
// Handlers receive (match, url, body, ctx) where ctx = { db, user, req, secure }.
const routes = [
  ['GET', /^\/api\/health$/, null, async (_m, _u, _b, ctx) => ({ ok: true, db: ctx.db.dialect })],

  ['POST', /^\/api\/auth\/login$/, null, async (_m, _url, body, ctx) => {
    const { db } = ctx;
    const email = String(body.email || '').trim().toLowerCase();
    const key = `${ctx.req.ip || '?'}|${email}`;
    if (await loginBlocked(db, key)) throw new HttpError(429, 'too many failed attempts; try again in 15 minutes');
    const user = await db.one('SELECT * FROM users WHERE lower(email) = ?', email);
    if (!(user && user.active && verifyPassword(body.password, user))) {
      await noteFailure(db, key);
      throw new HttpError(401, 'email or password is incorrect');
    }
    await clearFailures(db, key);
    const token = await createSession(db, user.id, { userAgent: String(ctx.req.headers['user-agent'] || '').slice(0, 200) });
    ctx.cookie = sessionCookie(token, { secure: ctx.secure });
    return { user: { name: user.name, email: user.email, role: user.role, scopes: JSON.parse(user.scopes) } };
  }],

  ['POST', /^\/api\/auth\/logout$/, '*', async (_m, _url, _b, ctx) => {
    const token = tokenFromRequest(ctx.req);
    if (token) await revokeSession(ctx.db, token);
    ctx.cookie = clearCookie();
    return { ok: true };
  }],

  ['GET', /^\/api\/auth\/me$/, '*', async (_m, _url, _b, ctx) => ({ user: userView(ctx.user) })],

  // What this account can see, for building the navigation and forms.
  ['GET', /^\/api\/schema$/, '*', async (_m, _url, _b, ctx) =>
    crud.publicSchema((mod) => hasScope(ctx.user, readScope(mod)), (mod) => hasScope(ctx.user, writeScope(mod)))],

  ['GET', /^\/api\/dashboard$/, '*', (_m, _url, _b, ctx) => dashboard(ctx.db, ctx.user)],

  ['GET', /^\/api\/kpi-summary$/, 'kpis:read', (_m, _url, _b, ctx) => kpiSummary(ctx.db)],

  ['GET', /^\/api\/audit$/, 'admin', async (_m, url, _b, ctx) => {
    const params = [];
    const where = [];
    for (const k of ['entity', 'action']) {
      const v = url.searchParams.get(k);
      if (v) { where.push(`${k} = ?`); params.push(v); }
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const rows = await ctx.db.all(
      `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY at DESC, id DESC LIMIT ?`,
      ...params, limit,
    );
    return { events: rows.map((e) => ({ ...e, changes: JSON.parse(e.changes || '{}') })) };
  }],

  ['GET', /^\/api\/options\/(\w+)$/, '*', async (m, _url, _b, ctx) => {
    if (!canPick(ctx.user, m[1])) throw new HttpError(403, `this account cannot list ${m[1]}`);
    return { options: await crud.options(ctx.db, m[1]) };
  }],

  ['GET', /^\/api\/r\/(\w+)$/, (m) => readScope(moduleOf(m[1])), (m, url, _b, ctx) => crud.list(ctx.db, m[1], url)],
  ['GET', /^\/api\/r\/(\w+)\/(\d+)$/, (m) => readScope(moduleOf(m[1])), (m, _u, _b, ctx) => crud.get(ctx.db, m[1], m[2])],
  ['GET', /^\/api\/r\/(\w+)\/(\d+)\/history$/, (m) => readScope(moduleOf(m[1])), async (m, _u, _b, ctx) => ({ events: await crud.history(ctx.db, m[1], m[2]) })],
  ['POST', /^\/api\/r\/(\w+)$/, (m) => writeScope(moduleOf(m[1])), (m, _url, body, ctx) => crud.create(ctx.db, m[1], body, actorOf(ctx.user))],
  ['PATCH', /^\/api\/r\/(\w+)\/(\d+)$/, (m) => writeScope(moduleOf(m[1])), (m, _url, body, ctx) => crud.patch(ctx.db, m[1], m[2], body, actorOf(ctx.user))],
  ['DELETE', /^\/api\/r\/(\w+)\/(\d+)$/, (m) => writeScope(moduleOf(m[1])), (m, _url, _b, ctx) => crud.remove(ctx.db, m[1], m[2], actorOf(ctx.user))],
];

// A route without a valid scope would be open to anyone, so refuse to load.
for (const route of routes) {
  const [method, pattern, scope, handler] = route;
  const where = `route ${method} ${pattern}`;
  if (route.length !== 4 || typeof handler !== 'function') {
    throw new Error(`${where} must be [method, pattern, scope, handler]`);
  }
  const ok = scope === null || scope === '*' || typeof scope === 'function' || Object.hasOwn(SCOPES, scope);
  if (!ok) throw new Error(`${where} declares unknown scope ${JSON.stringify(scope)}`);
}

// ---------------------------------------------------------------- handle
/**
 * @param {{method: string, url: URL, headers: Record<string,string>, body: string,
 *          ip?: string, secure: boolean}} req   headers lower-cased
 */
export async function handle(req) {
  const { secure } = req;
  try {
    const byPath = routes.filter(([, pattern]) => pattern.test(req.url.pathname));
    const route = byPath.find(([method]) => method === req.method);
    if (!route) {
      if (byPath.length) return json(405, { error: `use ${[...new Set(byPath.map(([m]) => m))].join(' or ')} on this path` }, secure);
      return json(404, { error: 'no such endpoint' }, secure);
    }

    const [, pattern, scopeDef, handler] = route;
    const match = req.url.pathname.match(pattern);
    const db = await open();
    const user = await userForToken(db, tokenFromRequest(req));
    const scope = typeof scopeDef === 'function' ? scopeDef(match) : scopeDef;
    if (scope !== null) {
      if (!user) return json(401, { error: 'authentication required' }, secure);
      if (scope !== '*' && !hasScope(user, scope)) {
        return json(403, { error: `this account does not have the "${scope}" permission` }, secure);
      }
    }
    // Cookie-authenticated writes must come from this origin. Bearer tokens are
    // never attached by a browser on its own, so they cannot be borrowed.
    if (user && user.session_kind === 'session' && req.method !== 'GET') {
      const origin = req.headers.origin;
      if (origin) {
        let same = false;
        try { same = new URL(origin).host === req.headers.host; } catch { same = false; }
        if (!same) return json(403, { error: 'cross-origin write refused' }, secure);
      }
    }

    let body = {};
    if (['POST', 'PATCH', 'PUT'].includes(req.method) && req.body) {
      if (Buffer.byteLength(req.body) > MAX_BODY) return json(413, { error: 'request body too large' }, secure);
      try {
        body = JSON.parse(req.body);
      } catch {
        return json(400, { error: 'body is not valid JSON' }, secure);
      }
    }

    const ctx = { db, user, req, secure };
    const out = await handler(match, req.url, body, ctx);
    return json(200, out, secure, ctx.cookie ? { 'set-cookie': ctx.cookie } : {});
  } catch (err) {
    const code = err.httpCode || 500;
    if (code === 500) console.error(err);
    return json(code, { error: code === 500 ? 'internal error' : err.message }, secure);
  }
}
