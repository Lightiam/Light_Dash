/**
 * Light Dash on your own machine: the API plus the web app from one process.
 * All request handling lives in app.mjs; this file only does HTTP and files.
 *
 *   node server/server.mjs           -> http://127.0.0.1:4400
 *
 * Uses SQLite in data/ unless a Postgres connection string is set (see db.mjs).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './db.mjs';
import { handle, securityHeaders } from './app.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, '..', 'web');
const PORT = Number(process.env.PORT || 4400);
const HOST = process.env.HOST || '127.0.0.1';
// Set when served over HTTPS (behind a TLS proxy), so the session cookie is Secure.
const SECURE = process.env.LIGHTDASH_SECURE_COOKIES === '1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function write(res, { status, headers, body }) {
  res.writeHead(status, { ...headers, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = normalize(join(WEB, rel));
  const notFound = { status: 404, headers: { ...securityHeaders(SECURE), 'content-type': 'text/plain' }, body: 'not found' };
  if (!target.startsWith(normalize(WEB))) return write(res, { ...notFound, status: 403, body: 'forbidden' });
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(target);
    res.writeHead(200, {
      ...securityHeaders(SECURE),
      'content-type': TYPES[extname(target)] || 'application/octet-stream',
      'content-length': data.length,
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    write(res, notFound);
  }
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) break; // app.mjs answers 413
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return write(res, { status: 405, headers: securityHeaders(SECURE), body: 'GET only' });
    return serveStatic(url.pathname, res);
  }
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : '';
  const out = await handle({
    method: req.method,
    url,
    headers: req.headers, // node:http already lower-cases header names
    body,
    ip: req.socket.remoteAddress,
    secure: SECURE,
  });
  write(res, out);
});

const db = await open();
server.listen(PORT, HOST, async () => {
  console.log(`Light Dash  ->  http://${HOST}:${PORT}   (${db.describe()})`);
  const users = await db.one('SELECT COUNT(*) AS n FROM users WHERE active = 1').catch(() => null);
  if (users && !users.n) {
    console.log('  No accounts yet. Create one:');
    console.log('    node server/users.mjs create --email you@example.com --name "Your Name" --role admin');
  }
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !SECURE) {
    console.warn('  WARNING: listening beyond localhost without LIGHTDASH_SECURE_COOKIES=1. Put TLS in front first.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    server.close();
    await db.close();
    process.exit(0);
  });
}
