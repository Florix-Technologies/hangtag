// A small PostgREST + Supabase Auth stand-in for browser tests, backed by PGlite running the real supabase/schema.sql.
// Every request runs as the user its Authorization bearer token names (role authenticated, auth.uid() = the token's
// sub), with request.headers set to the request's headers (lower-case keys, as PostgREST does), so row-level security,
// team devices (x-hangtag-device), CHECKs, triggers, unique indexes and RPCs behave like the real database.
//
// createPgRest(schema, { uid, email, users }): uid/email is the shop owner (the signed-in user of every single-owner
// test); users are more accounts ({ id, email, password?, meta? }: staff, a second shop …), also addable later with
// addUser(). With no extra users a request without a user token still runs as the owner (what the single-owner tests
// rely on); with extra users it runs as a signed-out visitor (anon).
// Auth: /auth/v1/token answers the password grant (email + password of a known user; any password for the owner or a
// user without one) and the refresh grant (the refresh token of a session made here); /auth/v1/verify answers a
// token_hash made by magicLink(email) (the team function's QR sign-in) or a known email; /auth/v1/user is the token's user.
// A password grant's token says so in its amr ("password"), a link sign-in's doesn't ("otp"), as Supabase Auth does.
// Writes honour Prefer: return=representation (the rows written, e.g. .update().select('id')) and
// resolution=ignore-duplicates (upsert with ignoreDuplicates).
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id), provider text, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;`;
export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS,HEAD', 'Access-Control-Expose-Headers': 'content-range' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
/* the sub of a "Bearer <jwt>" header, or null (no header, the publishable key, anything that isn't a JWT) */
export function subOf(authorization) {
  const t = String(authorization || '').replace(/^Bearer\s+/i, '').split('.');
  if (t.length !== 3) return null;
  try { const c = JSON.parse(Buffer.from(t[1], 'base64url').toString('utf8')); return typeof c.sub === 'string' && c.sub ? c.sub : null; } catch { return null; }
}

export async function createPgRest(schemaPath, { uid, email, users = [] }) {
  const db = new PGlite();
  await db.exec(SUPABASE);
  const people = new Map([[uid, { id: uid, email, password: null, meta: { full_name: 'Owner' }, provider: 'google' }]]);
  const multi = () => people.size > 1;
  const insertUser = (u) => db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, $3)`, [u.id, u.email, JSON.stringify(u.meta || {})]);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uid, email]);
  for (const u of users) { people.set(u.id, { password: null, meta: {}, provider: 'email', ...u }); await insertUser(u); }
  await db.exec(fs.readFileSync(schemaPath, 'utf8'));
  /* another account after start-up (e.g. a staff account the stubbed team function "created") */
  async function addUser(u) { people.set(u.id, { password: null, meta: {}, provider: 'email', ...u }); await insertUser(u); return u; }
  /* a new password for an account (the stubbed team function's reset_access) */
  const setPassword = (id, password) => { const p = people.get(id); if (p) p.password = password; };
  const byEmail = (e) => [...people.values()].find((p) => String(p.email || '').toLowerCase() === String(e || '').toLowerCase().trim()) || null;
  const colType = {}, pk = {};
  (await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'hangtag_%'`)).rows
    .forEach((r) => { (colType[r.table_name] = colType[r.table_name] || {})[r.column_name] = r.data_type; });
  (await db.query(`SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' ORDER BY kcu.ordinal_position`)).rows
    .forEach((r) => { (pk[r.table_name] = pk[r.table_name] || []).push(r.column_name); });
  const refresh = new Map(), otps = new Map();
  const userOf = (who) => { const p = people.get(who) || people.get(uid);
    return { id: p.id, aud: 'authenticated', role: 'authenticated', email: p.email, user_metadata: p.meta || {}, app_metadata: { provider: p.provider },
      identities: [{ provider: p.provider }], created_at: '2026-01-01T00:00:00Z' }; };
  /* a session for a user (default: the owner); the owner's refresh token stays 'r1'. method: how the person signed in
     (the token's amr; a refresh keeps the sign-in's own method and time) */
  const signIns = new Map();
  const session = (who = uid, method = 'password') => {
    const p = people.get(who) || people.get(uid), rt = p.id === uid ? 'r1' : 'r:' + p.id;
    refresh.set(rt, p.id);
    const amr = method === 'refresh' ? (signIns.get(p.id) || [{ method: 'password', timestamp: now() }]) : [{ method, timestamp: now() }];
    signIns.set(p.id, amr);
    return { access_token: b64({ alg: 'HS256' }) + '.' + b64({ sub: p.id, email: p.email, role: 'authenticated', iat: now(), exp: now() + 3600,
      amr }) + '.x', token_type: 'bearer', expires_in: 3600, expires_at: now() + 3600, refresh_token: rt, user: userOf(p.id) };
  };
  /* the token_hash of a one-time sign-in for this email (what admin.generateLink gives the team function) */
  const magicLink = (mail) => { const p = byEmail(mail); if (!p) throw new Error('no user ' + mail); const h = 'th_' + Math.random().toString(36).slice(2) + Date.now().toString(36); otps.set(h, p.id); return h; };
  /* run SQL as a user (default: the owner; null = signed out), with the request's headers (e.g. { 'x-hangtag-device': key }); one statement */
  async function as(sql, params, who = uid, headers = null) {
    await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify(headers || {})]);
    try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
  }
  const val = (t, c, v) => (colType[t] && colType[t][c] === 'jsonb' && v !== null && v !== undefined ? JSON.stringify(v) : v);
  const ident = (c) => { if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error('bad column ' + c); return '"' + c + '"'; };
  function where(t, q, params) {
    const parts = [];
    for (const [k, v] of q) {
      if (['select', 'order', 'offset', 'limit', 'on_conflict', 'columns'].includes(k)) continue;
      const m = /^(eq|neq|in|ilike|is|gt|gte|lt|lte)\.(.*)$/s.exec(v); if (!m) continue;
      const col = ident(k);
      if (m[1] === 'in') { const items = m[2].replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')); parts.push(`${col} = ANY($${params.push(items)}::text[])`); }
      else if (m[1] === 'is') parts.push(`${col} IS ${m[2] === 'null' ? 'NULL' : m[2] === 'true' ? 'TRUE' : 'FALSE'}`);
      else if (['gt', 'gte', 'lt', 'lte'].includes(m[1]) && /timestamp|date|numeric|integer|bigint|smallint|double|real/.test((colType[t] || {})[k] || '')) {
        // a time or a number is compared as one (as PostgREST does), not as text
        parts.push(`${col} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[m[1]]} $${params.push(m[2])}`);
      }
      else { const op = { eq: '=', neq: '<>', ilike: 'ILIKE', gt: '>', gte: '>=', lt: '<', lte: '<=' }[m[1]]; parts.push(`${col}::text ${op} $${params.push(m[2])}`); }
    }
    return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
  }
  const json = (r, status, body, headers = {}) => r.respond({ status, contentType: 'application/json', headers: { ...CORS, ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
  const pgErr = (r, e) => json(r, e.code === '42501' ? 403 : 400, { code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null });
  const badLogin = (r) => json(r, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials', error: 'invalid_grant', error_description: 'Invalid login credentials' });
  const calls = [];
  /* puppeteer request handler for https://<project>.supabase.co/... (returns false for anything else) */
  async function handle(r, extra = {}) {
    const u = new URL(r.url()), m = r.method();
    if (m === 'OPTIONS') { r.respond({ status: 204, headers: CORS }); return true; }
    if (extra[u.pathname]) { await extra[u.pathname](r); return true; }
    const hdrs = r.headers(), sub = subOf(hdrs['authorization']);
    let body = null;
    try { body = r.postData() ? JSON.parse(r.postData()) : null; } catch { body = null; }
    if (u.pathname.startsWith('/auth/v1/token')) {
      const grant = u.searchParams.get('grant_type');
      if (!multi()) { json(r, 200, session()); return true; }
      if (grant === 'password') {
        const p = byEmail(body && body.email);
        if (!p || (p.password && p.password !== (body && body.password))) { badLogin(r); return true; }
        json(r, 200, session(p.id)); return true;
      }
      if (grant === 'refresh_token') {
        const who = refresh.get(body && body.refresh_token);
        if (!who) { json(r, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }); return true; }
        json(r, 200, session(who, 'refresh')); return true;
      }
      json(r, 200, session()); return true;
    }
    if (u.pathname.startsWith('/auth/v1/verify')) {
      const th = (body && (body.token_hash || body.token)) || u.searchParams.get('token_hash') || u.searchParams.get('token');
      const who = otps.get(th) || (body && body.email && (byEmail(body.email) || {}).id);
      if (!who) { json(r, 403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' }); return true; }
      otps.delete(th);
      json(r, 200, session(who, 'otp')); return true;
    }
    if (u.pathname.startsWith('/auth/v1/user')) { json(r, 200, userOf(sub || uid)); return true; }
    if (u.pathname.startsWith('/auth/v1/logout')) { r.respond({ status: 204, headers: CORS }); return true; }
    if (u.pathname.startsWith('/auth/v1/settings')) { json(r, 200, { external: { google: true, email: true } }); return true; }
    if (u.pathname.startsWith('/auth/v1/')) { json(r, 200, {}); return true; }
    if (u.pathname.startsWith('/realtime')) { r.abort(); return true; }
    const mt = /^\/rest\/v1\/(rpc\/)?(\w+)$/.exec(u.pathname); if (!mt) return false;
    const t = mt[2], q = [...u.searchParams.entries()];
    // the request runs as its token's user; without one, as the owner (single-owner tests) or signed out (multi-user)
    const who = sub || (multi() ? null : uid);
    const run = (sql, params) => as(sql, params, who, hdrs);
    calls.push({ m, t, rpc: !!mt[1], who });
    // Prefer: return=representation (supabase-js .select() after an insert, update or delete): the written rows come back
    const prefer = hdrs['prefer'] || '', sel0 = (q.find(([k]) => k === 'select') || [])[1];
    const returning = /return=representation/.test(prefer) ? ' RETURNING ' + (!sel0 || sel0 === '*' ? '*' : sel0.split(',').map((c) => ident(c.trim())).join(', ')) : '';
    try {
      if (mt[1]) {   // RPC: named arguments
        const keys = Object.keys(body || {}), params = keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]));
        const res = await run(`SELECT public.${ident(t)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) AS r`, params);
        json(r, 200, res.rows[0].r); return true;
      }
      if (m === 'HEAD' || m === 'GET') {
        const params = [], w = where(t, q, params);
        const sel = (q.find(([k]) => k === 'select') || [])[1];
        const cols = !sel || sel === '*' ? '*' : sel.split(',').map((c) => ident(c.trim())).join(', ');
        const ord = (q.find(([k]) => k === 'order') || [])[1];
        const order = ord ? ' ORDER BY ' + ord.split(',').map((x) => { const [c, d] = x.split('.'); return ident(c) + (d === 'desc' ? ' DESC' : ''); }).join(', ') : '';
        const lim = (q.find(([k]) => k === 'limit') || [])[1], off = (q.find(([k]) => k === 'offset') || [])[1];
        const rows = (await run(`SELECT ${cols} FROM public.${ident(t)}${w}${order}${lim ? ' LIMIT ' + (+lim) : ''}${off ? ' OFFSET ' + (+off) : ''}`, params)).rows;
        if (m === 'HEAD') { r.respond({ status: 200, headers: { ...CORS, 'content-range': '*/' + rows.length } }); return true; }
        const obj = /vnd\.pgrst\.object/.test(hdrs['accept'] || '');
        json(r, 200, obj ? rows[0] ?? null : rows, { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` }); return true;
      }
      if (m === 'POST') {
        const rows = Array.isArray(body) ? body : [body]; if (!rows.length) { json(r, 201, []); return true; }
        const cols = [...new Set(rows.flatMap(Object.keys))];
        const oc = (q.find(([k]) => k === 'on_conflict') || [])[1];
        const target = oc ? oc.split(',') : pk[t];
        const params = [], values = rows.map((row) => '(' + cols.map((c) => `$${params.push(val(t, c, row[c] === undefined ? null : row[c]))}`).join(', ') + ')').join(', ');
        const upd = cols.filter((c) => !target.includes(c));
        const conflict = /resolution=merge-duplicates/.test(prefer) ? ` ON CONFLICT (${target.map(ident).join(', ')}) DO ${upd.length ? 'UPDATE SET ' + upd.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ') : 'NOTHING'}`
          : /resolution=ignore-duplicates/.test(prefer) ? ` ON CONFLICT (${target.map(ident).join(', ')}) DO NOTHING` : '';
        const out = await run(`INSERT INTO public.${ident(t)} (${cols.map(ident).join(', ')}) VALUES ${values}${conflict}${returning}`, params);
        json(r, 201, returning ? out.rows : []); return true;
      }
      if (m === 'PATCH') {
        const params = [], set = Object.keys(body).map((c) => `${ident(c)} = $${params.push(val(t, c, body[c]))}`).join(', ');
        const out = await run(`UPDATE public.${ident(t)} SET ${set}${where(t, q, params)}${returning}`, params);
        if (returning) json(r, 200, out.rows); else json(r, 204); return true;
      }
      if (m === 'DELETE') {
        const params = [], out = await run(`DELETE FROM public.${ident(t)}${where(t, q, params)}${returning}`, params);
        if (returning) json(r, 200, out.rows); else json(r, 204); return true;
      }
    } catch (e) { pgErr(r, e); return true; }
    return false;
  }
  return { db, as, handle, session, calls, addUser, setPassword, magicLink, subOf };
}
