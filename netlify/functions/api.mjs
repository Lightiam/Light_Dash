/**
 * Light Dash on Netlify: every /api/* request runs here.
 * All request handling lives in server/app.mjs; this file only converts
 * Netlify's web-standard Request into that shape and back.
 *
 * Needs a Postgres connection string in the site's environment
 * (NETLIFY_DB_URL from Netlify Database, or DATABASE_URL) - functions have no
 * lasting disk, so the SQLite file used locally cannot work here.
 */
import { getConnectionString } from '@netlify/database';
import { handle } from '../../server/app.mjs';
import { postgresTarget } from '../../server/db.mjs';

// Netlify Database may hand the connection string to the function through
// Netlify.env rather than process.env; @netlify/database reads both.
if (!postgresTarget()) {
  try {
    process.env.NETLIFY_DB_URL = getConnectionString();
  } catch {
    // No Netlify Database on this site - answered with 503 below.
  }
}

export default async (request, context) => {
  if (!postgresTarget()) {
    return new Response(
      JSON.stringify({ error: 'no database configured: set NETLIFY_DB_URL or DATABASE_URL for this site' }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }
  const url = new URL(request.url);
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  const body = ['POST', 'PATCH', 'PUT'].includes(request.method) ? await request.text() : '';

  const out = await handle({
    method: request.method,
    url,
    headers,
    body,
    ip: context.ip,
    // Netlify serves over HTTPS; local `netlify dev` is plain http.
    secure: url.protocol === 'https:',
  });
  return new Response(out.body, { status: out.status, headers: out.headers });
};

export const config = { path: '/api/*' };
