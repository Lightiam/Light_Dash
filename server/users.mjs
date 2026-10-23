/**
 * Account administration.
 *
 *   node server/users.mjs list
 *   node server/users.mjs create --email a@b.c --name "A B" --role admin [--employee 2]
 *   node server/users.mjs passwd --email a@b.c
 *   node server/users.mjs scopes --email a@b.c --scopes kpis:read,silicon:read
 *   node server/users.mjs token  --email a@b.c --label "Reporting script" [--days 90]
 *   node server/users.mjs revoke --email a@b.c [--all]
 *   node server/users.mjs disable --email a@b.c
 *   node server/users.mjs scope-list
 *
 * Secrets are written to a file, never printed to the terminal, so they do not
 * end up in scrollback, a screen share or a shell history file. The path is
 * reported; the file is gitignored.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { open, all, one, insert, update, run as exec } from './db.mjs';
import { hashPassword, createSession, ROLES, SCOPES, parseScopes } from './auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = join(here, '..', 'data', 'secrets');

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const db = open();
const need = (v, msg) => {
  if (!v) {
    console.error(msg);
    process.exit(1);
  }
  return v;
};

function writeSecret(name, lines) {
  mkdirSync(SECRETS_DIR, { recursive: true });
  const path = join(SECRETS_DIR, name);
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  return resolve(path);
}

function findUser(email) {
  return one(db, 'SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
}

const show = (u) =>
  `  ${String(u.id).padStart(3)}  ${u.email.padEnd(28)} ${u.name.padEnd(22)} ${String(u.role).padEnd(7)} ` +
  `${u.active ? 'active ' : 'DISABLED'}  ${parseScopes(u.scopes).join(' ') || '(no scopes)'}`;

switch (cmd) {
  case 'list': {
    const users = all(db, 'SELECT * FROM users ORDER BY id');
    if (!users.length) console.log('No accounts yet.');
    else {
      console.log(`\n  ${'id'.padStart(3)}  ${'email'.padEnd(28)} ${'name'.padEnd(22)} ${'role'.padEnd(7)} status    scopes`);
      for (const u of users) console.log(show(u));
      console.log();
      for (const u of users) {
        const toks = all(
          db,
          `SELECT kind, label, created_at, expires_at, last_used_at
             FROM sessions WHERE user_id = ? ORDER BY created_at`,
          u.id,
        );
        for (const t of toks) {
          console.log(
            `       ${u.email} · ${t.kind}${t.label ? ` "${t.label}"` : ''}` +
              ` · created ${String(t.created_at).slice(0, 10)}` +
              (t.expires_at ? ` · expires ${String(t.expires_at).slice(0, 10)}` : ' · no expiry') +
              (t.last_used_at ? ` · last used ${String(t.last_used_at).slice(0, 16)}` : ' · never used'),
          );
        }
      }
    }
    break;
  }

  case 'scope-list': {
    console.log('\n  Scopes');
    for (const [s, d] of Object.entries(SCOPES)) console.log(`    ${s.padEnd(16)} ${d}`);
    console.log('\n  Role bundles');
    for (const [r, s] of Object.entries(ROLES)) {
      console.log(`    ${r.padEnd(8)} ${s.length ? s.join(' ') : '(none - assign scopes explicitly)'}`);
    }
    console.log();
    break;
  }

  case 'create': {
    const email = need(opt('email'), '--email is required').toLowerCase();
    const name = need(opt('name'), '--name is required');
    const role = opt('role', 'viewer');
    if (!ROLES[role]) need(null, `--role must be one of ${Object.keys(ROLES).join(', ')}`);
    if (findUser(email)) need(null, `an account already exists for ${email}`);

    const scopes = opt('scopes') ? opt('scopes').split(',').map((s) => s.trim()).filter(Boolean) : ROLES[role];
    for (const s of scopes) {
      if (!SCOPES[s]) need(null, `unknown scope "${s}". Run: node server/users.mjs scope-list`);
    }

    // A token-only account (for a script or integration) gets no password: there is no
    // credential for a person to phish, reuse or leave in a browser.
    const tokenOnly = flag('no-password');
    let secretLines = [];
    let creds = { password_hash: null, password_salt: null };
    let password = null;
    if (!tokenOnly) {
      password = opt('password') || randomBytes(18).toString('base64url');
      creds = hashPassword(password);
    }

    const id = insert(db, 'users', {
      email,
      name,
      role,
      scopes: JSON.stringify(scopes),
      ...creds,
      employee_id: opt('employee') ? Number(opt('employee')) : null,
      active: 1,
      created_at: new Date().toISOString(),
      note: opt('note'),
    });

    secretLines.push(`Light Dash - credentials for ${email}`);
    secretLines.push(`created ${new Date().toISOString()}`);
    secretLines.push(`role    ${role}`);
    secretLines.push(`scopes  ${scopes.join(' ')}`);
    if (password) {
      secretLines.push('');
      secretLines.push(`password: ${password}`);
      secretLines.push('Change it after first sign-in: node server/users.mjs passwd --email ' + email);
    }
    if (flag('token')) {
      const days = opt('days') ? Number(opt('days')) : null;
      const token = createSession(db, id, {
        kind: 'api',
        label: opt('label') || 'api token',
        days,
      });
      secretLines.push('');
      secretLines.push(`token: ${token}`);
      secretLines.push('');
      secretLines.push('Use it as an HTTP header:');
      secretLines.push('  Authorization: Bearer <token>');
      secretLines.push(days ? `Expires in ${days} days.` : 'No expiry - revoke with: node server/users.mjs revoke --email ' + email);
    }

    const path = writeSecret(`${email.replace(/[^a-z0-9]+/gi, '_')}.txt`, secretLines);
    console.log(`\n  Created ${email} (${role}) with scopes: ${scopes.join(' ')}`);
    console.log(`  Credentials written to:\n    ${path}`);
    console.log('  That file is gitignored. Hand it over securely, then delete it.\n');
    break;
  }

  case 'passwd': {
    const email = need(opt('email'), '--email is required').toLowerCase();
    const user = need(findUser(email), `no account for ${email}`);
    const password = opt('password') || randomBytes(18).toString('base64url');
    update(db, 'users', user.id, hashPassword(password));
    // Changing a password invalidates existing browser sessions.
    exec(db, "DELETE FROM sessions WHERE user_id = ? AND kind = 'session'", user.id);
    const path = writeSecret(`${email.replace(/[^a-z0-9]+/gi, '_')}_password.txt`, [
      `New password for ${email}`,
      `set ${new Date().toISOString()}`,
      '',
      `password: ${password}`,
    ]);
    console.log(`\n  Password changed; browser sessions for ${email} were signed out.`);
    console.log(`  Written to:\n    ${path}\n`);
    break;
  }

  case 'scopes': {
    const email = need(opt('email'), '--email is required').toLowerCase();
    const user = need(findUser(email), `no account for ${email}`);
    const scopes = need(opt('scopes'), '--scopes is required (comma separated)')
      .split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of scopes) {
      if (!SCOPES[s]) need(null, `unknown scope "${s}". Run: node server/users.mjs scope-list`);
    }
    update(db, 'users', user.id, { scopes: JSON.stringify(scopes) });
    console.log(`\n  ${email} now has: ${scopes.join(' ')}\n`);
    break;
  }

  case 'token': {
    const email = need(opt('email'), '--email is required').toLowerCase();
    const user = need(findUser(email), `no account for ${email}`);
    const days = opt('days') ? Number(opt('days')) : null;
    const token = createSession(db, user.id, {
      kind: 'api',
      label: opt('label') || 'api token',
      days,
    });
    const path = writeSecret(`${email.replace(/[^a-z0-9]+/gi, '_')}_token.txt`, [
      `API token for ${email}`,
      `issued ${new Date().toISOString()}`,
      `scopes ${parseScopes(user.scopes).join(' ')}`,
      days ? `expires in ${days} days` : 'no expiry',
      '',
      `token: ${token}`,
      '',
      'Use it as an HTTP header:',
      '  Authorization: Bearer <token>',
    ]);
    console.log(`\n  Token issued for ${email}${days ? ` (${days} days)` : ' (no expiry)'}.`);
    console.log(`  Written to:\n    ${path}`);
    console.log('  It is shown only here - the database stores a hash.\n');
    break;
  }

  case 'revoke': {
    const email = need(opt('email'), '--email is required').toLowerCase();
    const user = need(findUser(email), `no account for ${email}`);
    const n = flag('all')
      ? exec(db, 'DELETE FROM sessions WHERE user_id = ?', user.id)
      : exec(db, "DELETE FROM sessions WHERE user_id = ? AND kind = 'api'", user.id);
    console.log(`\n  Revoked ${n.changes} credential(s) for ${email}.\n`);
    break;
  }

  case 'disable': {
    const email = need(opt('email'), '--email is required').toLowerCase();
    const user = need(findUser(email), `no account for ${email}`);
    update(db, 'users', user.id, { active: 0 });
    exec(db, 'DELETE FROM sessions WHERE user_id = ?', user.id);
    console.log(`\n  ${email} disabled and all its credentials revoked.\n`);
    break;
  }

  default:
    console.error(
      'usage: node server/users.mjs <list|create|passwd|scopes|token|revoke|disable|scope-list> [options]\n'
      + 'See the comment at the top of this file for the full list.',
    );
    process.exit(1);
}

db.close();
