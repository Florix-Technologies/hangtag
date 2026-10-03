// Business profile and capabilities (schema.sql section 3j): the type of business in the shop profile (the new keys and
// every value saved before them), the product's stock tracking, and the capability choices in the synced settings — an
// older copy of the settings (a phone that was offline, or an older app version) never wipes them, their shape is
// checked, members change them only with manage_settings, and a capability never grants a permission.
// PGlite with Supabase stand-ins (a member acts from its device through request.headers, as PostgREST sets it).
// Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';
import { BUSINESS_TYPE_KEYS, CAP_KEYS, keepNewerCaps } from '../../src/domain/shop/capabilities.js';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider text, email text);
CREATE TABLE auth.sessions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`;

/* who: an owner's id, or a member { id, key } asking from the device with that key */
async function as(db, who, sql, params) {
  const id = typeof who === 'string' ? who : who && who.id, key = who && typeof who === 'object' ? who.key : null;
  await db.exec(`SET ROLE ${id ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
    [id || '', key ? JSON.stringify({ authorization: 'Bearer x', 'x-hangtag-device': key }) : JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const tryDb = async (db, sql, params) => { try { return { r: await db.query(sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
/* equal as JSON, whatever the key order (jsonb keeps its own) */
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const eq = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
/* the settings upload the app makes (cloud-gateway saveSettings → PostgREST upsert on the primary key) */
const saveSettings = (db, who, value) => tryAs(db, who, `INSERT INTO public.hangtag_meta (key, value, updated_at) VALUES ('settings', $1::jsonb, now())
  ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at RETURNING value`, [JSON.stringify(value)]);
const settingsOf = async (db, shop) => (await db.query(`SELECT value FROM public.hangtag_meta WHERE owner_id = $1 AND key = 'settings'`, [shop])).rows[0]?.value;

const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CASHIER = { id: uid(1), key: 'key-cashier-0001-abcdefghijklmnop' }, MANAGER = { id: uid(2), key: 'key-manager-0002-abcdefghijklmnop' };

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
for (const m of [CASHIER, MANAGER]) await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"staff":true}')`, [m.id, m.id + '@staff.hangtag.invalid']);

// ---------- an older database: business types saved by earlier app versions, and one written through the API ----------
await db.exec(NEW);
await db.exec(`ALTER TABLE public.hangtag_profiles DROP CONSTRAINT hangtag_profiles_business_type_check`);
await db.query(`UPDATE public.hangtag_profiles SET business_type = 'Clothing boutique', shop_name = 'Aura Threads' WHERE id = $1`, [A]);
await db.query(`UPDATE public.hangtag_profiles SET business_type = 'Hotel Grand Café' WHERE id = $1`, [B]);
await db.exec(NEW); await db.exec(NEW);
console.log('=== the schema runs twice; older profiles keep their type ===');
{
  const rep = await report(db);
  check('migration report: 52 rows, all ok', rep.length === 52 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  check('report rows 30-32 are the business type, tracking and capability checks', rep.some((r) => /type of business/.test(r.check_name)) && rep.some((r) => /serial number or batch/.test(r.check_name))
    && rep.some((r) => /capabilities are all on or off/.test(r.check_name)));
  const types = Object.fromEntries((await db.query(`SELECT id::text, business_type FROM public.hangtag_profiles`)).rows.map((r) => [r.id, r.business_type]));
  check('a type saved by an earlier app version stays as it was (the app reads it as retail)', types[A] === 'Clothing boutique', types);
  check('a value no app wrote becomes the nearest type', types[B] === 'restaurant', types);
}

console.log('=== the type of business ===');
{
  for (const t of [...BUSINESS_TYPE_KEYS, 'Pop-up or exhibition stall', 'Retail store', 'Online seller', 'Wholesale', 'Other', null]) {
    const r = await tryAs(db, A, `UPDATE public.hangtag_profiles SET business_type = $2 WHERE id = $1 RETURNING business_type`, [A, t]);
    if (r.err || r.r.rows[0].business_type !== t) check('the owner saves business type ' + t, false, r);
  }
  check('the owner saves every type (and every older value, and none)', true);
  const r = await tryAs(db, A, `UPDATE public.hangtag_profiles SET business_type = 'Bakery' WHERE id = $1`, [A]);
  check('an unknown type is refused', r.code === '23514', r);
  await as(db, A, `UPDATE public.hangtag_profiles SET business_type = 'grocery' WHERE id = $1`, [A]);
}

console.log('=== products: stock tracking ===');
{
  await as(db, A, `INSERT INTO public.hangtag_products (id, name, price) VALUES ('p1', 'Rice 1 kg', 60)`);
  const p = (await as(db, A, `SELECT tracking FROM public.hangtag_products WHERE id = 'p1'`)).rows[0];
  check('a product saved without tracking (older app) is tracked by count', p.tracking === 'none', p);
  let r = await tryAs(db, A, `INSERT INTO public.hangtag_products (id, name, price, tracking) VALUES ('p2', 'Phone', 9999, 'serial'), ('p3', 'Milk', 30, 'batch') RETURNING tracking`);
  check('serial and batch tracking are saved', !r.err && eq(r.r.rows.map((x) => x.tracking), ['serial', 'batch']), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_products SET tracking = 'imei' WHERE id = 'p2'`);
  check('an unknown tracking is refused', r.code === '23514', r);
  r = await tryAs(db, A, `UPDATE public.hangtag_products SET tracking = NULL WHERE id = 'p2'`);
  check('tracking is never empty', !!r.err, r);
  await as(db, A, `DELETE FROM public.hangtag_products`);   // (products without variants would upset the report's first row)
}

console.log('=== capabilities in the synced settings ===');
{
  let r = await saveSettings(db, A, { lowStock: 3, prefix: 'INV-' });
  check('settings without capabilities save as before', !r.err && !('caps' in r.r.rows[0].value), r);
  r = await saveSettings(db, A, { lowStock: 3, prefix: 'INV-', caps: { uses_serials: true, uses_weight: false }, capsAt: 1000 });
  check('the owner saves capability choices', !r.err && eq((await settingsOf(db, A)).caps, { uses_serials: true, uses_weight: false }), r);
  r = await saveSettings(db, A, { lowStock: 5, prefix: 'BILL-' });
  let s = await settingsOf(db, A);
  check('an older app version (no capabilities in its copy) never wipes them; its other settings are saved', !r.err && eq(s.caps, { uses_serials: true, uses_weight: false }) && s.capsAt === 1000 && s.lowStock === 5 && s.prefix === 'BILL-', s);
  r = await saveSettings(db, A, { lowStock: 6, prefix: 'BILL-', caps: {}, capsAt: 500 });
  s = await settingsOf(db, A);
  check('a phone holding an older copy of the choices doesn\'t undo newer ones', !r.err && eq(s.caps, { uses_serials: true, uses_weight: false }) && s.capsAt === 1000 && s.lowStock === 6, s);
  r = await saveSettings(db, A, { lowStock: 6, prefix: 'BILL-', caps: { uses_tables: true }, capsAt: 2000 });
  s = await settingsOf(db, A);
  check('newer choices replace older ones', !r.err && eq(s.caps, { uses_tables: true }) && s.capsAt === 2000, s);
  r = await saveSettings(db, A, { lowStock: 6, caps: {}, capsAt: 3000 });
  s = await settingsOf(db, A);
  check('going back to the type\'s defaults (no choices) is kept too', !r.err && eq(s.caps, {}) && s.capsAt === 3000, s);
  r = await saveSettings(db, A, { lowStock: 6, caps: { uses_tables: 'yes' }, capsAt: 4000 });
  check('a capability that isn\'t on/off is refused', r.code === '23514' && /either on or off/.test(r.err), r);
  r = await saveSettings(db, A, { lowStock: 6, caps: ['uses_tables'], capsAt: 4000 });
  check('capabilities that aren\'t a set of switches are refused', r.code === '23514', r);
  r = await saveSettings(db, A, { lowStock: 6, caps: { uses_tables: true }, capsAt: 'now' });
  check('a change time that isn\'t a time is refused', r.code === '23514', r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_meta (key, value) VALUES ('logo', '"data:image/png;base64,AAAA"') ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value RETURNING key`);
  check('other settings rows (the logo) are untouched by the rule', !r.err, r);
  const rep = await report(db);
  check('the report stays all ok with choices saved', rep.length === 52 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
  // the app's download rule matches the database's
  const kept = { caps: { uses_tables: true }, capsAt: 2000 };
  check('app and database agree: an older copy keeps the newer choices, a newer copy wins',
    eq(keepNewerCaps({ lowStock: 1 }, kept).caps, kept.caps) && eq(keepNewerCaps({ caps: {}, capsAt: 1 }, kept).caps, kept.caps)
    && eq(keepNewerCaps({ caps: {}, capsAt: 3000 }, kept).caps, {}) && CAP_KEYS.length === 13);
}

console.log('=== team members: capabilities are settings (manage_settings), and never a permission ===');
{
  const svc = async (sql, params) => { await db.exec('SET ROLE service_role'); try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); } };
  for (const [m, role, n] of [[CASHIER, 'cashier', 1], [MANAGER, 'manager', 2]]) {
    await svc(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1, $2, $3, $4, $3, 'active', $2)`, [m.id, A, role, role + n]);
    await svc(`INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Phone', 'Android', $4)`, [A, 'device-00' + n, m.id, hash(m.key)]);
  }
  const read = await tryAs(db, CASHIER, `SELECT value FROM public.hangtag_meta WHERE key = 'settings'`);
  check('a cashier\'s phone reads the shop\'s capabilities (they decide what it shows)', !read.err && read.r.rows.length === 1 && eq(read.r.rows[0].value.caps, {}), read);
  let r = await saveSettings(db, CASHIER, { lowStock: 6, caps: { uses_kitchen: true }, capsAt: 5000 });
  check('a cashier can\'t change them (no manage_settings)', !!r.err && /row-level security/.test(r.err) && eq((await settingsOf(db, A)).caps, {}), r);
  r = await saveSettings(db, MANAGER, { lowStock: 6, caps: { uses_kitchen: true, uses_tables: true }, capsAt: 5000 });
  check('a manager (manage_settings) can', !r.err && eq((await settingsOf(db, A)).caps, { uses_kitchen: true, uses_tables: true }), r);
  const can = (await as(db, CASHIER, `SELECT public.hangtag_can('manage_kitchen') AS k, public.hangtag_can('manage_tables') AS t, public.hangtag_can('manage_settings') AS s`)).rows[0];
  check('switching the kitchen and tables on gives a cashier no new permission', can.k === false && can.t === true && can.s === false, can);
  r = await tryAs(db, MANAGER, `UPDATE public.hangtag_profiles SET business_type = 'restaurant' WHERE id = $1 RETURNING id`, [A]);
  const t = (await db.query(`SELECT business_type FROM public.hangtag_profiles WHERE id = $1`, [A])).rows[0].business_type;
  check('the type of business is the owner\'s: a manager can\'t change the shop profile', !r.err && r.r.rows.length === 0 && t === 'grocery', { r, t });
  const other = await tryAs(db, B, `SELECT value FROM public.hangtag_meta WHERE key = 'settings'`);
  check('another shop never sees them', !other.err && other.r.rows.length === 0, other);
  r = await saveSettings(db, B, { lowStock: 2, caps: { uses_serials: true }, capsAt: 1 });
  check('…and its own choices are its own', !r.err && eq((await settingsOf(db, B)).caps, { uses_serials: true }) && eq((await settingsOf(db, A)).caps, { uses_kitchen: true, uses_tables: true }), r);
}

const rep = await tryDb(db, 'SELECT 1');
check('database still answers', !rep.err);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
