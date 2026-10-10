// Upgrading a live database to this release: migrations 20261010120000 (section 3x, the Platform Console's operations)
// and 20261011120000 (section 3y, billing integrity) on a database that has the previous release's schema.sql and real
// data on it, as the SQL Editor would run them: each twice, in the documented order and in the other. Afterwards the
// report says ok on all 77 rows, every row that was there is still there unchanged, and both sections' rules hold for
// the bills, returns and shops made before the upgrade. The previous release's schema.sql (9623601) is today's without
// sections 3x and 3y and the report's rows for them, so it is cut from today's file rather than kept as a copy.
// Run: node supabase/tests/upgrade-3x-3y.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NEW = read('../schema.sql');
const MIG_X = read('../migrations/20261010120000_hangtag_platform_operations.sql');
const MIG_Y = read('../migrations/20261011120000_hangtag_billing_integrity.sql');
const section = (id) => { const m = new RegExp(`-- (?:={78}|-{78})\\n-- ${id}\\. `).exec(NEW); if (!m) throw new Error(`schema.sql has no section ${id}`); return m.index; };
// the previous release: everything before 3x, then sections 4–6 (indexes, row security, realtime); not the report
const BEFORE = NEW.slice(0, section('3x')) + NEW.slice(section('4'), section('7'));
const REPORT = NEW.slice(NEW.lastIndexOf('SELECT check_name'));

const A = 'cccccccc-0000-0000-0000-000000000001', SUPER = 'cccccccc-0000-0000-0000-000000000011';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
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

async function tryAs(db, who, q, params) {
  await db.exec('SET ROLE authenticated');
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [who]);
  try { return { r: await db.query(q, params) }; } catch (e) { return { err: e.message, code: e.code }; } finally { await db.exec('RESET ROLE'); }
}
const as = async (db, who, q, params) => { const x = await tryAs(db, who, q, params); if (x.err) throw new Error(x.err); return x.r.rows; };
const val = async (db, who, q, params) => { const x = await tryAs(db, who, q, params); return x.err ? x : Object.values(x.r.rows[0])[0]; };
// a bill as the app uploads it (infrastructure/supabase/mappers.js billArgs): 3 tees at 500, paid in cash
const billOf = (id, isVoid = false) => ({
  sale: { id, timestamp: 1790000000000, subtotal: 1500, discount: 0, total: 1500, payment_method: 'cash', device_id: 'till-1', bill_no: `INV-${id}`, kind: 'sale', is_void: isVoid },
  items: [{ sale_id: id, line_no: 0, product_id: 'p1', variant_id: 'p1:M', product_name: 'Tee', color: '', size: '', quantity: 3, unit_price: 500 }],
  payments: [{ id: `${id}:cash`, method: 'cash', amount: 1500 }] });
const upload = (db, ...bills) => tryAs(db, A, `SELECT public.hangtag_save_sales($1::jsonb)`, [JSON.stringify(bills)]);
const bill = async (db, id) => (await db.query(`SELECT is_void, void_reason FROM public.hangtag_sales WHERE id = $1`, [id])).rows[0];
const cancel = (db, id, reason) => tryAs(db, A, `UPDATE public.hangtag_sales SET is_void = true, void_reason = $2 WHERE id = $1`, [id, reason]);
// every row of every table, as text: what the upgrade must leave as it was
async function snapshot(db) {
  const tables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((t) => t.table_name);
  const out = {};
  for (const t of tables) out[t] = (await db.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM public.${t} x`)).rows[0];
  return out;
}

// The previous release, in use: a shop on its trial with a cashier; a paid bill, a bill cancelled on another till, a
// bill with a return; a Platform Console super admin
async function liveDatabase() {
  const db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(BEFORE);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner@shop.test'), ($2, 'boss@hangtag.test')`, [A, SUPER]);
  await db.query(`UPDATE public.hangtag_profiles SET shop_name = 'Test Threads', full_name = 'Test Owner', business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [A]);
  await db.query(`SELECT public.hangtag_subscription_ensure($1)`, [A]);
  await db.query(`INSERT INTO public.hangtag_platform_staff (user_id, role) VALUES ($1, 'super_admin')`, [SUPER]);
  await as(db, A, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Tee', 500, '{"opts":[]}')`);
  await as(db, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, size) VALUES ('p1:M', 'p1', '[]', '')`);
  const up = await upload(db, billOf('u1'), billOf('u2'), billOf('u3'), billOf('u4'));
  if (up.err) throw new Error('the previous release refused the bills: ' + up.err);
  const c = await cancel(db, 'u2', 'Duplicate bill');
  if (c.err) throw new Error(c.err);
  await as(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, kind, refund_amount, refund_method, value) VALUES ('r3', 'u3', 1790000100000, 'return', 500, 'cash', 500)`);
  return db;
}

console.log('=== the previous release (before the upgrade) ===');
const db = await liveDatabase();
check('the previous release\'s schema loads and takes bills (no section 3x or 3y in it)', !/^-- 3[xy]\. /m.test(BEFORE) && (await bill(db, 'u1')).is_void === false);
await cancel(db, 'u4', 'Wrong customer');
await upload(db, billOf('u4'));
check('…and has the bug 3y fixes: a cancelled bill sent again by a till comes back', (await bill(db, 'u4')).is_void === false, await bill(db, 'u4'));
const before = await snapshot(db);

console.log('\n=== the upgrade: 3x then 3y, each twice ===');
{
  let err = null;
  try { await db.exec(MIG_X); await db.exec(MIG_X); await db.exec(MIG_Y); await db.exec(MIG_Y); } catch (e) { err = e.message; }
  check('both migrations run on the previous release, and again', err === null, err);
  const rep = (await db.query(REPORT)).rows;
  check('the report: 77 rows, all ok (rows 87–90 are 3x and 3y)', rep.length === 77 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  const after = await snapshot(db);
  const lost = Object.keys(before).filter((t) => !after[t] || after[t].n !== before[t].n || after[t].h !== before[t].h);
  check(`every row of the ${Object.keys(before).length} tables that were there is still there, unchanged`, lost.length === 0, lost.map((t) => [t, before[t], after[t]]));
}

console.log('\n=== section 3y on the bills made before the upgrade ===');
let r = await upload(db, billOf('u2'));
check('a bill cancelled before the upgrade, sent again by a till: it stays cancelled, with its reason', !r.err && (await bill(db, 'u2')).is_void === true && (await bill(db, 'u2')).void_reason === 'Duplicate bill', { r, b: await bill(db, 'u2') });
r = await cancel(db, 'u3', 'Customer changed their mind');
check('a bill whose return was taken before the upgrade can\'t be cancelled', /has a return or exchange, so it can't be cancelled/.test(r.err || ''), r);
r = await upload(db, billOf('u3', true));
check('…a till\'s upload of it marked cancelled goes through, and the bill stays as it is', !r.err && (await bill(db, 'u3')).is_void === false, { r, b: await bill(db, 'u3') });
r = await tryAs(db, A, `UPDATE public.hangtag_sales SET is_void = false, void_reason = NULL WHERE id = 'u2'`);
check('Restore still brings a cancelled bill back (the one way back)', !r.err && (await bill(db, 'u2')).is_void === false, r);
r = await cancel(db, 'u1', 'Duplicate bill');
check('a bill without a return can still be cancelled', !r.err && (await bill(db, 'u1')).is_void === true, r);

console.log('\n=== section 3x on the shops there before the upgrade ===');
const list = await val(db, SUPER, `SELECT public.hangtag_platform_customers(NULL, 'all', 'newest', 25, 0)`);
check('the console\'s customer list shows the shop that was there', list && list.total === 1 && list.rows[0].owner_id === A, list);
const page = await val(db, SUPER, `SELECT public.hangtag_platform_customer($1)`, [A]);
check('…and its page opens for a super admin', page && !page.err && JSON.stringify(page).includes(A), page);
const own = await tryAs(db, A, `SELECT public.hangtag_platform_customers(NULL, 'all', 'newest', 25, 0)`);
check('the shop\'s owner reaches none of it', !!own.err, own);

console.log('\n=== the other order: 3y, then 3x ===');
{
  const db2 = await liveDatabase();
  let err = null;
  try { await db2.exec(MIG_Y); await db2.exec(MIG_X); } catch (e) { err = e.message; }
  const rep = err ? [] : (await db2.query(REPORT)).rows;
  check('3y before 3x works too (3y needs only section 3r): the report is all ok', err === null && rep.length === 77 && rep.every((x) => x.ok), err || rep.filter((x) => !x.ok));
  r = await upload(db2, billOf('u2'));
  check('…and the cancelled bill sent again stays cancelled', !r.err && (await bill(db2, 'u2')).is_void === true, r);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
