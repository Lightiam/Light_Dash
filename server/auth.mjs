/**
 * Authentication and authorisation. Node built-ins only.
 *
 * Design notes, because the choices matter more than the code:
 *
 * - Passwords are hashed with scrypt and a 16-byte random salt per user, and
 *   compared with timingSafeEqual. scrypt is memory-hard, so a stolen hash is
 *   expensive to attack; the cost parameters are named constants below.
 * - Session and API tokens are random 32-byte values. Only their SHA-256 digest
 *   is stored, so the database never holds a usable credential. A token is
 *   shown exactly once, when it is created.
 * - Sessions are opaque rows, not signed blobs, so revocation is a DELETE and
 *   takes effect immediately. Signed stateless tokens cannot be withdrawn.
 * - Scopes are explicit strings on the user. A role is only a bundle; the check
 *   always reads the scope list.
 */
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';

// scrypt cost. N must be a power of two; 2^15 with r=8 is a reasonable 2026
// interactive-login cost. maxmem has to be raised to match, or Node refuses.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

export const SESSION_COOKIE = 'ld_session';
export const SESSION_DAYS = 14;

/** Every scope the app knows about, with what it means. One pair per module. */
export const SCOPES = {
  'hr:read': 'Read employees, departments, time off and goals',
  'hr:write': 'Change employees, departments, time off and goals',
  'crm:read': 'Read companies, contacts and deals',
  'crm:write': 'Change companies, contacts and deals',
  'projects:read': 'Read projects, tasks and timesheets',
  'projects:write': 'Change projects and tasks, and log time',
  'finance:read': 'Read invoices and expenses',
  'finance:write': 'Change invoices and expenses',
  'kpis:read': 'Read the KPI page',
  'kpis:write': 'Enter and assess KPIs',
  admin: 'Everything, plus the audit log and account management',
};

/**
 * Roles are a convenience bundle; the stored scope list is what is enforced.
 * kpis:write is held back from everyone but admin: KPIs rate people's work, so
 * nobody rates their own by default.
 */
export const ROLES = {
  admin: Object.keys(SCOPES),
  manager: Object.keys(SCOPES).filter((s) => s !== 'admin' && s !== 'kpis:write'),
  // Day-to-day staff: see the directory, the work and the KPIs; log their time.
  member: ['hr:read', 'crm:read', 'projects:read', 'projects:write', 'kpis:read'],
  viewer: ['hr:read', 'crm:read', 'projects:read', 'finance:read', 'kpis:read'],
};

// ---------------------------------------------------------------- passwords
export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('password must be at least 12 characters');
  }
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return { password_hash: hash.toString('base64'), password_salt: salt.toString('base64') };
}

export function verifyPassword(password, user) {
  if (!user?.password_hash || !user?.password_salt) return false;
  const salt = Buffer.from(user.password_salt, 'base64');
  const expected = Buffer.from(user.password_hash, 'base64');
  let actual;
  try {
    actual = scryptSync(String(password ?? ''), salt, expected.length, SCRYPT);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------- tokens
export const tokenDigest = (token) => createHash('sha256').update(String(token)).digest('hex');

/** A fresh bearer token. Returned once to the caller and never stored as-is. */
export function newToken(prefix = 'ld') {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export async function createSession(db, userId, { kind = 'session', label = null, days = SESSION_DAYS, userAgent = null } = {}) {
  const token = newToken(kind === 'api' ? 'ldk' : 'lds');
  const now = new Date();
  const expires = days ? new Date(now.getTime() + days * 86400_000).toISOString() : null;
  await db.run(
    `INSERT INTO sessions (user_id, token_hash, kind, label, created_at, expires_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    userId, tokenDigest(token), kind, label, now.toISOString(), expires, userAgent,
  );
  return token; // the only time it exists in plaintext
}

export async function revokeSession(db, token) {
  return (await db.run('DELETE FROM sessions WHERE token_hash = ?', tokenDigest(token))).changes;
}

// "Last used" is for spotting stale credentials, not an access log, so it is
// written at most every few minutes rather than on every request - on a hosted
// database that is one fewer round trip per call.
const TOUCH_EVERY_MS = 5 * 60_000;

/** Resolve a bearer token to its user, or null. Expired rows are cleaned up. */
export async function userForToken(db, token) {
  if (!token) return null;
  const row = await db.one(
    `SELECT s.id AS session_id, s.expires_at, s.kind, s.last_used_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    tokenDigest(token),
  );
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    await db.run('DELETE FROM sessions WHERE id = ?', row.session_id);
    return null;
  }
  if (!row.active) return null;
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > TOUCH_EVERY_MS) {
    const now = new Date().toISOString();
    await db.run('UPDATE sessions SET last_used_at = ? WHERE id = ?', now, row.session_id);
    await db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, row.id);
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    scopes: parseScopes(row.scopes),
    employee_id: row.employee_id,
    session_kind: row.kind,
  };
}

export function parseScopes(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export const hasScope = (user, scope) =>
  !!user && (user.scopes.includes('admin') || user.scopes.includes(scope));

// ---------------------------------------------------------------- requests
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Bearer header first, then the session cookie. */
export function tokenFromRequest(req) {
  const auth = req.headers.authorization || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null;
}

export function sessionCookie(token, { secure, days = SESSION_DAYS } = {}) {
  const bits = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${days * 86400}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export const clearCookie = () =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

// ---------------------------------------------------------------- lockout
// Kept in the database, not in memory: on Netlify every request may land on a
// different short-lived instance, so an in-memory counter would never add up.
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 8;

export async function loginBlocked(db, key) {
  const rec = await db.one('SELECT first_at, count FROM login_attempts WHERE key = ?', key);
  if (!rec) return false;
  if (Date.now() - Date.parse(rec.first_at) > WINDOW_MS) return false;
  return rec.count >= MAX_ATTEMPTS;
}

export async function noteFailure(db, key) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - WINDOW_MS).toISOString();
  // One statement, so two failures arriving at once cannot both read "0".
  await db.run(
    `INSERT INTO login_attempts (key, first_at, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN login_attempts.first_at < ? THEN 1 ELSE login_attempts.count + 1 END,
       first_at = CASE WHEN login_attempts.first_at < ? THEN excluded.first_at ELSE login_attempts.first_at END`,
    key, now.toISOString(), windowStart, windowStart,
  );
}

export const clearFailures = (db, key) => db.run('DELETE FROM login_attempts WHERE key = ?', key);
