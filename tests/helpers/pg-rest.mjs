// A small PostgREST + Supabase Auth stand-in for browser tests, backed by PGlite running the real supabase/schema.sql.
// Every request runs as the signed-in user (role authenticated, auth.uid() = the session's user), so row-level
// security, CHECKs, triggers, unique indexes and RPCs behave like the real database.
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
export const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS,HEAD', 'Access-Control-Expose-Headers': 'content-range' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

export async function createPgRest(schemaPath, { uid, email }) {
  const db = new PGlite();
  await db.exec(SUPABASE);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [uid, email]);
  await db.exec(fs.readFileSync(schemaPath, 'utf8'));
  const colType = {}, pk = {};
  (await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'hangtag_%'`)).rows
    .forEach((r) => { (colType[r.table_name] = colType[r.table_name] || {})[r.column_name] = r.data_type; });
  (await db.query(`SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' ORDER BY kcu.ordinal_position`)).rows
    .forEach((r) => { (pk[r.table_name] = pk[r.table_name] || []).push(r.column_name); });
  const session = () => ({ access_token: b64({ alg: 'HS256' }) + '.' + b64({ sub: uid, email, role: 'authenticated', exp: now() + 3600 }) + '.x', token_type: 'bearer', expires_in: 3600, expires_at: now() + 3600, refresh_token: 'r1',
    user: { id: uid, aud: 'authenticated', role: 'authenticated', email, user_metadata: { full_name: 'Owner' }, identities: [{ provider: 'google' }], created_at: '2026-01-01T00:00:00Z' } });
  /* run SQL as a user (default: the signed-in one); one statement */
  async function as(sql, params, who = uid) {
    await db.exec('SET ROLE authenticated');
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [who]);
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
      else { const op = { eq: '=', neq: '<>', ilike: 'ILIKE', gt: '>', gte: '>=', lt: '<', lte: '<=' }[m[1]]; parts.push(`${col}::text ${op} $${params.push(m[2])}`); }
    }
    return parts.length ? ' WHERE ' + parts.join(' AND ') : '';
  }
  const json = (r, status, body, headers = {}) => r.respond({ status, contentType: 'application/json', headers: { ...CORS, ...headers }, body: body === undefined ? '' : JSON.stringify(body) });
  const pgErr = (r, e) => json(r, e.code === '42501' ? 403 : 400, { code: e.code, message: e.message, details: e.detail || null, hint: e.hint || null });
  const calls = [];
  /* puppeteer request handler for https://<project>.supabase.co/... (returns false for anything else) */
  async function handle(r, extra = {}) {
    const u = new URL(r.url()), m = r.method();
    if (m === 'OPTIONS') { r.respond({ status: 204, headers: CORS }); return true; }
    if (extra[u.pathname]) { await extra[u.pathname](r); return true; }
    if (u.pathname.startsWith('/auth/v1/token')) { json(r, 200, session()); return true; }
    if (u.pathname.startsWith('/auth/v1/user')) { json(r, 200, session().user); return true; }
    if (u.pathname.startsWith('/auth/v1/settings')) { json(r, 200, { external: { google: true, email: true } }); return true; }
    if (u.pathname.startsWith('/auth/v1/')) { json(r, 200, {}); return true; }
    if (u.pathname.startsWith('/realtime')) { r.abort(); return true; }
    const mt = /^\/rest\/v1\/(rpc\/)?(\w+)$/.exec(u.pathname); if (!mt) return false;
    const t = mt[2], q = [...u.searchParams.entries()], body = r.postData() ? JSON.parse(r.postData()) : null;
    calls.push({ m, t, rpc: !!mt[1] });
    try {
      if (mt[1]) {   // RPC: named arguments
        const keys = Object.keys(body || {}), params = keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]));
        const res = await as(`SELECT public.${ident(t)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) AS r`, params);
        json(r, 200, res.rows[0].r); return true;
      }
      if (m === 'HEAD' || m === 'GET') {
        const params = [], w = where(t, q, params);
        const sel = (q.find(([k]) => k === 'select') || [])[1];
        const cols = !sel || sel === '*' ? '*' : sel.split(',').map((c) => ident(c.trim())).join(', ');
        const ord = (q.find(([k]) => k === 'order') || [])[1];
        const order = ord ? ' ORDER BY ' + ord.split(',').map((x) => { const [c, d] = x.split('.'); return ident(c) + (d === 'desc' ? ' DESC' : ''); }).join(', ') : '';
        const lim = (q.find(([k]) => k === 'limit') || [])[1], off = (q.find(([k]) => k === 'offset') || [])[1];
        const rows = (await as(`SELECT ${cols} FROM public.${ident(t)}${w}${order}${lim ? ' LIMIT ' + (+lim) : ''}${off ? ' OFFSET ' + (+off) : ''}`, params)).rows;
        if (m === 'HEAD') { r.respond({ status: 200, headers: { ...CORS, 'content-range': '*/' + rows.length } }); return true; }
        const obj = /vnd\.pgrst\.object/.test(r.headers()['accept'] || '');
        json(r, 200, obj ? rows[0] ?? null : rows, { 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` }); return true;
      }
      if (m === 'POST') {
        const rows = Array.isArray(body) ? body : [body]; if (!rows.length) { json(r, 201, []); return true; }
        const cols = [...new Set(rows.flatMap(Object.keys))];
        const oc = (q.find(([k]) => k === 'on_conflict') || [])[1];
        const target = oc ? oc.split(',') : pk[t];
        const params = [], values = rows.map((row) => '(' + cols.map((c) => `$${params.push(val(t, c, row[c] === undefined ? null : row[c]))}`).join(', ') + ')').join(', ');
        const upd = cols.filter((c) => !target.includes(c));
        const prefer = r.headers()['prefer'] || '';
        const conflict = /resolution=merge-duplicates/.test(prefer) ? ` ON CONFLICT (${target.map(ident).join(', ')}) DO ${upd.length ? 'UPDATE SET ' + upd.map((c) => `${ident(c)} = EXCLUDED.${ident(c)}`).join(', ') : 'NOTHING'}` : '';
        await as(`INSERT INTO public.${ident(t)} (${cols.map(ident).join(', ')}) VALUES ${values}${conflict}`, params);
        json(r, 201, []); return true;
      }
      if (m === 'PATCH') {
        const params = [], set = Object.keys(body).map((c) => `${ident(c)} = $${params.push(val(t, c, body[c]))}`).join(', ');
        await as(`UPDATE public.${ident(t)} SET ${set}${where(t, q, params)}`, params); json(r, 204); return true;
      }
      if (m === 'DELETE') { const params = []; await as(`DELETE FROM public.${ident(t)}${where(t, q, params)}`, params); json(r, 204); return true; }
    } catch (e) { pgErr(r, e); return true; }
    return false;
  }
  return { db, as, handle, session, calls };
}
