// Team, roles, devices and the audit log (schema.sql section 3i, and the shop rules of section 5): the owner sees no
// difference; a team member reaches its shop only from an active device of its own while active, within its role's
// permissions (the shop's own role permissions override the defaults); members can't raise their own rights; shop A
// and shop B never see each other in any table; the bill, return and supplier-bill RPCs check the permission; audit rows
// are written by triggers only, with the member and its device; owner_id fills itself in with the shop for members; and
// upgrading the database that runs the previous schema (fixtures/legacy/schema_v6.sql) keeps the owner's data and rights.
// PGlite with Supabase stand-ins (a member "acts as a device" through request.headers, as PostgREST sets it).
// Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs } from '../../src/infrastructure/supabase/mappers.js';
import { ROLE_DEFAULTS, PERMISSIONS, sha256Hex } from '../functions/team/core.js';

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

/* who: an owner's id, or a member { id, key } asking from the device with that key (key null = no header) */
async function as(db, who, sql, params) {
  const id = typeof who === 'string' ? who : who && who.id, key = who && typeof who === 'object' ? who.key : null;
  await db.exec(`SET ROLE ${id ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
    [id || '', key ? JSON.stringify({ authorization: 'Bearer x', 'x-hangtag-device': key }) : JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
async function asService(db, sql, params) {
  await db.exec('SET ROLE service_role');
  await db.query(`SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.headers', '', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message }; } };
const trySvc = async (db, sql, params) => { try { return { r: await asService(db, sql, params) }; } catch (e) { return { err: e.message }; } };
const rows = async (db, who, sql, params) => (await as(db, who, sql, params)).rows;
const one = async (db, who, sql, params) => (await rows(db, who, sql, params))[0];
const count = async (db, who, t, where = '') => (await one(db, who, `SELECT count(*)::int AS n FROM public.${t} ${where}`)).n;
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const denied = (r) => /permission denied/.test(r.err || '');
const rls = (r) => /row-level security/.test(r.err || '');

function bill(id, price, { t = 1790000000000, pay = 'cash', ref, disc = null } = {}) {
  const T = computeCheckout({ lines: [{ q: 1, price, rate: 0 }], billDisc: disc, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, [{ method: pay, amount: T.total, ...(ref ? { ref } : {}) }]);
  if (S.error) throw new Error(S.error);
  const L = T.lines[0];
  return { id, no: 'INV-' + id, t, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: [{ ln: 0, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: 1, price, cost: null, dAmt: 0, bdAmt: L.billDisc, gst: 0, hsn: '6109', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total }],
    sub: T.sub, disc: T.disc, itemDisc: 0, billDisc: disc, billDiscAmt: T.billDisc, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: S.payments[0].method, payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
const saveBill = (db, who, b) => tryAs(db, who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([billArgs(b)])]);
const retArgs = (id, saleId, amount) => [JSON.stringify({ id, sale_id: saleId, t: 1790000005000, kind: 'return', refund_amount: amount, refund_method: 'cash', value: amount, round_off: 0, credit_no: 'CN-' + id, device_id: 'd1' }),
  JSON.stringify([{ line_no: 0, sale_line_no: 0, variant_id: 'p1:M', product_id: 'p1', product_name: 'Tee', quantity: 1, unit_price: amount, value: amount, restock: true }])];
const saveReturn = (db, who, id, saleId, amount) => tryAs(db, who, `SELECT public.hangtag_save_return($1::jsonb, $2::jsonb) AS r`, retArgs(id, saleId, amount));
const importStock = (db, who, id, moves) => tryAs(db, who, `SELECT public.hangtag_import_stock($1::jsonb, '[]'::jsonb, '[]'::jsonb, $2::jsonb, false) AS r`,
  [JSON.stringify({ id, supplier_name: 'Mill', invoice_no: id, line_count: moves.length }), JSON.stringify(moves)]);

// ---------- accounts: two shops, and A's team ----------
const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const member = (n, role, key) => ({ id: uid(n), role, key, username: role + n, dev: 'dev-' + role + '-' + n });
const CA = member(1, 'cashier', 'key-cashier-0001-abcdefghijklmnop');
const KA = member(2, 'kitchen', 'key-kitchen-0002-abcdefghijklmnop');
const MA = member(3, 'manager', 'key-manager-0003-abcdefghijklmnop');
const SA = member(4, 'server', 'key-server-00004-abcdefghijklmnop');
const DA = member(5, 'cashier', 'key-disabled-005-abcdefghijklmnop');
const CB = member(6, 'cashier', 'key-shopb-cash-06-abcdefghijklmno');
const OUT = uid(9);   // an account that belongs to no shop's team (an owner of an empty shop)

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in'),($3,'out@x.in')`, [A, B, OUT]);
for (const m of [CA, KA, MA, SA, DA, CB]) await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"staff":true}')`, [m.id, m.username + '@staff.hangtag.invalid']);
await db.exec(NEW); await db.exec(NEW);
console.log('=== the schema runs twice; the report has the team rows ===');
{
  const rep = await report(db);
  check('migration report: 46 rows, all ok on an empty database', rep.length === 46 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  const pols = (await db.query(`SELECT count(*)::int n FROM pg_policies WHERE schemaname = 'public' AND policyname = 'Own rows only'`)).rows[0].n;
  check('no table keeps the old "Own rows only" rule', pols === 0, pols);
  const noRls = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'hangtag_%' AND NOT c.relrowsecurity`)).rows;
  check('row security is on for every hangtag table', noRls.length === 0, noRls);
  const defs = (await db.query(`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'owner_id' AND table_name LIKE 'hangtag_%'
      AND table_name NOT LIKE 'hangtag_backup%' AND coalesce(column_default, '') NOT LIKE '%hangtag_shop_id()%'`)).rows;
  check('every shop table fills owner_id with the shop (hangtag_shop_id())', defs.length === 0, defs);
}

console.log('=== the default permissions are the same everywhere ===');
{
  let same = true;
  for (const role of ['owner', 'manager', 'cashier', 'server', 'kitchen', 'nobody']) {
    const got = (await db.query(`SELECT public.hangtag_default_permissions($1) AS p`, [role])).rows[0].p;
    if (JSON.stringify([...got].sort()) !== JSON.stringify([...(ROLE_DEFAULTS[role] || [])].sort())) { same = false; console.log('  differs:', role, got); }
  }
  check('hangtag_default_permissions(role) = the team function\'s ROLE_DEFAULTS (owner = all 16; an unknown role = none)', same && ROLE_DEFAULTS.owner.length === 16 && PERMISSIONS.length === 16);
  const k = 'some device key ✓ 123';
  check('the database hashes a key exactly like the team function (SHA-256 hex of the UTF-8 text)',
    (await db.query(`SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h`, [k])).rows[0].h === await sha256Hex(k) && hash(k) === await sha256Hex(k));
}

console.log('=== the owner: nothing changes ===');
{
  await db.query(`UPDATE public.hangtag_profiles SET shop_name = 'Shop A', onboarded_at = now() WHERE id = $1`, [A]);
  await db.query(`UPDATE public.hangtag_profiles SET shop_name = 'Shop B', onboarded_at = now() WHERE id = $1`, [B]);
  const me = await one(db, A, `SELECT public.hangtag_shop_id()::text AS shop, public.hangtag_role() AS role, public.hangtag_can('manage_users') AS users, public.hangtag_can('anything') AS any`);
  check('the owner\'s shop is its own account, role owner, every permission', me.shop === A && me.role === 'owner' && me.users === true && me.any === true, me);
  const junk = await one(db, { id: A, key: 'not-a-real-device-key-at-all-000' }, `SELECT public.hangtag_shop_id()::text AS shop`);
  check('…even when a stray device header comes along', junk.shop === A, junk);
  for (const owner of [A, B]) {
    await as(db, owner, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Tee', 500, '{"opts":[{"name":"Size","values":["M"]}]}')`);
    await as(db, owner, `INSERT INTO public.hangtag_variants (id, product_id, option_values, size, sku, barcode) VALUES ('p1:M', 'p1', '["M"]', 'M', 'TEE-M', '8901234567897')`);
    await as(db, owner, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('open:p1:M', 'p1:M', 'p1', 'OPENING', 20, 1)`);
    await as(db, owner, `INSERT INTO public.hangtag_sizes (product_id, size, stock) VALUES ('p1', 'M', 0)`);
    await as(db, owner, `INSERT INTO public.hangtag_images (product_id, image_data) VALUES ('p1', 'data:image/png;base64,AA==')`);
    await as(db, owner, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1', 'Asha', '9876543210')`);
    await as(db, owner, `INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', '{"prefix":"INV"}')`);
    await as(db, owner, `INSERT INTO public.hangtag_events (id, name, start_date, end_date) VALUES ('e1', 'Fair', '2026-10-01', '2026-10-02')`);
    await as(db, owner, `INSERT INTO public.hangtag_cash_moves (id, type, amount, reason, t) VALUES ('cm1', 'opening', 1000, 'Float', 1)`);
    await as(db, owner, `INSERT INTO public.hangtag_day_closes (id, day, scope, expected, counted, difference, t) VALUES ('dc1', '2026-09-28', 'shop', 1000, 1000, 0, 1)`);
    await as(db, owner, `INSERT INTO public.hangtag_stock_imports (id, supplier_name) VALUES ('imp0', 'Mill')`);
    await as(db, owner, `INSERT INTO public.hangtag_suppliers (id, name) VALUES ('sup0', 'Mill')`);
    await as(db, owner, `INSERT INTO public.hangtag_supplier_payments (id, supplier_id, amount, method, t) VALUES ('spay0', 'sup0', 100, 'upi', 1)`);
    await as(db, owner, `INSERT INTO public.hangtag_roles (role, permissions) VALUES ('server', $1)`, [ROLE_DEFAULTS.server]);
    let r = await saveBill(db, owner, bill('s1', 500));
    if (r.err) console.log(r.err);
    r = await saveBill(db, owner, bill('s2', 700, { pay: 'upi', ref: '412345678901' }));
    if (r.err) console.log(r.err);
    r = await saveReturn(db, owner, 'r1', 's1', 500);
    if (r.err) console.log(r.err);
    await asService(db, `INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status) VALUES ($1, 's1', 'sms', '+919876543210', 'pending')`, [owner]);
    await asService(db, `INSERT INTO public.hangtag_payment_intents (id, owner_id, amount, method, provider, provider_intent_id, reference, status) VALUES (gen_random_uuid(), $1, 700, 'upi', 'razorpay', $2, $2, 'pending')`, [owner, 'qr_' + owner.slice(0, 4)]);
    await asService(db, `INSERT INTO public.hangtag_invoice_links (token, owner_id, sale_id, expires_at) VALUES ($1, $2, 's1', now() + interval '1 year')`, [(owner === A ? 'A' : 'B').repeat(43), owner]);
    // section 3m: a payment collected from a customer, a held bill, a quotation with its line
    await as(db, owner, `INSERT INTO public.hangtag_collections (id, customer_id, amount, method, t) VALUES ('col1', 'c1', 100, 'cash', 1)`);
    await as(db, owner, `INSERT INTO public.hangtag_held_carts (id, name, data, t) VALUES ('h1', 'Asha', '{"cart":[]}', 1)`);
    r = await tryAs(db, owner, `SELECT public.hangtag_save_order($1::jsonb, $2::jsonb) AS r`, [JSON.stringify({ id: 'o1', kind: 'quote', no: 'QT-1', status: 'draft', customer_id: 'c1', version: 0, t: 1 }),
      JSON.stringify([{ line_no: 0, product_id: 'p1', variant_id: 'p1:M', name: 'Tee', qty: 1, price: 500 }])]);
    if (r.err) console.log(r.err);
  }
  const s = await one(db, A, `SELECT owner_id::text AS o FROM public.hangtag_sales WHERE id = 's1'`);
  check('the owner saves bills, returns and everything else as before (owner_id = the owner)', s && s.o === A && (await count(db, A, 'hangtag_returns')) === 1 && (await count(db, A, 'hangtag_bank_book')) === 1, s);
  check('the owner reads and changes the profile as before', (await count(db, A, 'hangtag_profiles')) === 1 && (await as(db, A, `UPDATE public.hangtag_profiles SET city = 'Pune' WHERE id = $1 RETURNING id`, [A])).rows.length === 1);
}

console.log('=== team members, their devices and the rules on them ===');
{
  for (const [m, shop] of [[CA, A], [KA, A], [MA, A], [SA, A], [DA, A], [CB, B]]) {
    const r = await trySvc(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1, $2, $3, $4, $5, $6, $2)`,
      [m.id, shop, 'Staff ' + m.username, m.username, m.role, m === DA ? 'disabled' : 'active']);
    if (r.err) console.log('member', m.username, r.err);
    const d = await trySvc(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Counter phone', 'Android', $4)`, [shop, m.dev, m.id, hash(m.key)]);
    if (d.err) console.log('device', m.username, d.err);
  }
  let r = await trySvc(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $1, 'Me', 'me1', 'cashier')`, [OUT]);
  check('an owner can\'t be a member of its own shop', /not_owner_check/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'X', 'boss', 'owner')`, [OUT, A]);
  check('nobody is a member with the role "owner"', /role_check/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'X', 'Bad Name!', 'cashier')`, [OUT, A]);
  check('usernames are 3-30 of a-z 0-9 . _ -', /username_check/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'X', 'cashier1', 'cashier')`, [OUT, A]);
  check('a username is unique in its shop', /duplicate|unique/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'Owner B', 'ownerb', 'cashier')`, [B, A]);
  check('an account that runs a shop of its own can\'t join another shop (it would lose its own)', /shop of its own/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'X', 'chain', 'cashier')`, [OUT, CA.id]);
  check('a team member can\'t have a team of its own', /team of its own/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, key_hash) VALUES ($1, 'dev-cross-shop', $2, 'X', $3)`, [B, CA.id, hash('another-key-for-a-cross-shop-dev')]);
  check('a device belongs to a member of the same shop', /member_fkey|foreign key/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, key_hash) VALUES ($1, 'dev-same-key', $2, 'X', $3)`, [A, KA.id, hash(CA.key)]);
  check('two devices never share a key', /duplicate|unique/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_roles (owner_id, role, permissions) VALUES ($1, 'cashier', ARRAY['create_sale','fly'])`, [A]);
  check('role permissions are only known permissions', /permissions_check/.test(r.err || ''), r);
}

console.log('=== a cashier on its device ===');
{
  const me = await one(db, CA, `SELECT public.hangtag_shop_id()::text AS shop, public.hangtag_role() AS role, public.hangtag_can('create_sale') AS sale, public.hangtag_can('manage_products') AS prod`);
  check('the cashier\'s shop is A, role cashier: may sell, may not edit products', me.shop === A && me.role === 'cashier' && me.sale === true && me.prod === false, me);
  check('reads the shop\'s products, variants, customers, events and settings', (await count(db, CA, 'hangtag_products')) === 1 && (await count(db, CA, 'hangtag_variants')) === 1
    && (await count(db, CA, 'hangtag_customers')) === 1 && (await count(db, CA, 'hangtag_events')) === 1 && (await count(db, CA, 'hangtag_meta')) === 1);
  let r = await tryAs(db, CA, `INSERT INTO public.hangtag_products (id, name, price) VALUES ('p2', 'Cap', 200)`);
  check('can\'t add a product', rls(r), r);
  r = await tryAs(db, CA, `UPDATE public.hangtag_products SET price = 1 WHERE id = 'p1' RETURNING id`);
  const pr = await one(db, A, `SELECT price FROM public.hangtag_products WHERE id = 'p1'`);
  check('…nor change one (no row changes)', !r.err && r.r.rows.length === 0 && pr.price === 500, { r, pr });
  r = await tryAs(db, CA, `DELETE FROM public.hangtag_variants RETURNING id`);
  check('…nor remove a variant', !r.err && r.r.rows.length === 0 && (await count(db, A, 'hangtag_variants')) === 1, r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c-ca', 'Ravi', '9123456789') RETURNING owner_id::text AS o`);
  check('adds a customer; owner_id fills itself in with the shop (A), not the cashier', !r.err && r.r.rows[0].o === A, r);
  r = await saveBill(db, CA, bill('s-ca', 300));
  const sca = await one(db, A, `SELECT owner_id::text AS o, total FROM public.hangtag_sales WHERE id = 's-ca'`);
  check('saves a bill through the RPC into shop A', !r.err && sca && sca.o === A && +sca.total === 300, { r, sca });
  check('reads the shop\'s bills, lines, payments and books', (await count(db, CA, 'hangtag_sales')) === 3 && (await count(db, CA, 'hangtag_sale_items')) === 3
    && (await count(db, CA, 'hangtag_payments')) === 3 && (await count(db, CA, 'hangtag_cash_book')) >= 2 && (await count(db, CA, 'hangtag_bank_book')) === 1);
  r = await saveReturn(db, CA, 'r-ca', 's-ca', 300);
  check('saves a return (perform_return)', !r.err, r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_cash_moves (id, type, amount, reason, t) VALUES ('cm-ca', 'in', 50, 'Change from bank', 2) RETURNING owner_id::text AS o`);
  check('adds a cash entry to the shop', !r.err && r.r.rows[0].o === A, r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_meta (key, value) VALUES ('logo', '{}')`);
  check('can\'t change the shop settings or logo', rls(r), r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_events (id, name, start_date, end_date) VALUES ('e2', 'X', '2026-10-01', '2026-10-01')`);
  check('…nor events', rls(r), r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_stock_imports (id) VALUES ('imp-ca')`);
  check('…nor supplier bills', rls(r), r);
  check('can\'t read supplier bills or the audit log', (await count(db, CA, 'hangtag_stock_imports')) === 0 && (await count(db, CA, 'hangtag_audit_log')) === 0);
  const prof = await rows(db, CA, `SELECT id::text AS id, shop_name FROM public.hangtag_profiles ORDER BY id`);
  check('reads its own profile and the shop\'s (the bill header)', prof.length === 2 && prof.some((p) => p.id === A && p.shop_name === 'Shop A'), prof);
  r = await tryAs(db, CA, `UPDATE public.hangtag_profiles SET shop_name = 'Mine now' WHERE id = $1 RETURNING id`, [A]);
  check('…but can\'t change the shop\'s profile', !r.err && r.r.rows.length === 0, r);
  const t = await one(db, CA, `SELECT public.hangtag_touch_device() AS t`);
  const seen = await one(db, A, `SELECT last_seen_at FROM public.hangtag_devices WHERE id = $1`, [CA.dev]);
  check('touch_device: the shop, the role and this device; "last seen" kept', t.t.shop_id === A && t.t.role === 'cashier' && t.t.device_id === CA.dev && seen.last_seen_at, { t, seen });
}

console.log('=== members can\'t raise their own rights ===');
{
  let r = await tryAs(db, CA, `UPDATE public.hangtag_members SET role = 'manager' WHERE user_id = $1 RETURNING role`, [CA.id]);
  const role = (await one(db, A, `SELECT role FROM public.hangtag_members WHERE user_id = $1`, [CA.id])).role;
  check('a cashier can\'t make itself a manager', !r.err && r.r.rows.length === 0 && role === 'cashier', { r, role });
  r = await tryAs(db, CA, `UPDATE public.hangtag_members SET shop_id = $1 WHERE user_id = $2`, [B, CA.id]);
  check('…nor move itself to another shop', denied(r), r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'X', 'friend', 'manager')`, [OUT, A]);
  check('…nor add a member', denied(r), r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_roles (role, permissions) VALUES ('cashier', $1)`, [PERMISSIONS]);
  check('…nor give its role more permissions', rls(r), r);
  r = await tryAs(db, CA, `UPDATE public.hangtag_roles SET permissions = $1 RETURNING role`, [PERMISSIONS]);
  check('…nor change a role\'s permissions', !r.err && r.r.rows.length === 0, r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, key_hash) VALUES ($1, 'dev-own-2', $2, 'Mine', $3)`, [A, CA.id, hash('my-own-made-up-key-1234567890')]);
  check('…nor add a device', denied(r), r);
  r = await tryAs(db, CA, `UPDATE public.hangtag_devices SET name = 'X' RETURNING id`);
  check('…nor change or revoke devices', !r.err && r.r.rows.length === 0, r);
  r = await tryAs(db, CA, `DELETE FROM public.hangtag_devices RETURNING id`);
  check('…nor remove them', !r.err && r.r.rows.length === 0 && (await count(db, A, 'hangtag_devices')) === 5, r);
  check('reads only its own member row and its own devices', (await count(db, CA, 'hangtag_members')) === 1 && (await count(db, CA, 'hangtag_devices')) === 1
    && (await count(db, CA, 'hangtag_enrollments')) === 0);
  check('the owner reads the whole team and every device', (await count(db, A, 'hangtag_members')) === 5 && (await count(db, A, 'hangtag_devices')) === 5);
  r = await tryAs(db, MA, `INSERT INTO public.hangtag_roles (role, permissions) VALUES ('kitchen', $1)`, [PERMISSIONS]);
  check('a manager can\'t edit role permissions either (the owner only)', rls(r), r);
  r = await tryAs(db, MA, `UPDATE public.hangtag_members SET role = 'manager' WHERE user_id = $1 RETURNING role`, [CA.id]);
  check('…nor change a member', !r.err && r.r.rows.length === 0, r);
}

console.log('=== kitchen, server and manager ===');
{
  check('kitchen reads the products', (await count(db, KA, 'hangtag_products')) === 1);
  const seen = {};
  for (const t of ['hangtag_sales', 'hangtag_sale_items', 'hangtag_payments', 'hangtag_fin_txns', 'hangtag_cash_book', 'hangtag_bank_book', 'hangtag_returns', 'hangtag_cash_moves', 'hangtag_deliveries', 'hangtag_payment_intents']) seen[t] = await count(db, KA, t);
  check('kitchen can\'t read bills, payments, books, returns or cash', Object.values(seen).every((n) => n === 0), seen);
  let r = await saveBill(db, KA, bill('s-ka', 100));
  check('kitchen can\'t save a bill (Not allowed)', /Not allowed/.test(r.err || ''), r);
  r = await tryAs(db, KA, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c-ka', 'X')`);
  check('kitchen can\'t add customers', rls(r), r);
  check('a server reads the bills (it takes orders)', (await count(db, SA, 'hangtag_sales')) === 3);
  r = await saveReturn(db, SA, 'r-sa', 's2', 700);
  check('a server can\'t save a return (Not allowed)', /Not allowed/.test(r.err || ''), r);
  r = await tryAs(db, MA, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p2', 'Cap', 200, '{"opts":[]}') RETURNING owner_id::text AS o`);
  check('a manager adds products to the shop', !r.err && r.r.rows[0].o === A, r);
  r = await tryAs(db, MA, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('p2:', 'p2', '[]')`);
  check('…and variants', !r.err, r);
  r = await tryAs(db, MA, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, note, t) VALUES ('adj-ma', 'p1:M', 'p1', 'ADJUST', -2, 'Damaged', 3)`);
  check('a manager adjusts stock', !r.err, r);
  r = await importStock(db, MA, 'imp-ma', [{ id: 'mv-ma', variant_id: 'p1:M', product_id: 'p1', qty: 5, t: 4 }]);
  check('a manager adds a supplier bill (create_purchase)', !r.err && r.r.rows[0].r.status === 'imported', r);
  check('a manager reads the audit log (view_reports)', (await count(db, MA, 'hangtag_audit_log')) > 0);
}

console.log('=== the RPCs check the permission; the shop\'s own role permissions count ===');
{
  let r = await importStock(db, CA, 'imp-ca1', [{ id: 'mv-ca1', variant_id: 'p1:M', product_id: 'p1', qty: 2, t: 5 }]);
  check('a cashier can\'t add a supplier bill (no create_purchase)', /Not allowed/.test(r.err || ''), r);
  await as(db, A, `INSERT INTO public.hangtag_roles (role, label, permissions) VALUES ('cashier', 'Cashier', $1)`, [[...ROLE_DEFAULTS.cashier, 'create_purchase']]);
  r = await importStock(db, CA, 'imp-ca1', [{ id: 'mv-ca1', variant_id: 'p1:M', product_id: 'p1', qty: 2, t: 5 }]);
  const imp = await one(db, A, `SELECT owner_id::text AS o FROM public.hangtag_stock_imports WHERE id = 'imp-ca1'`);
  check('…until the owner gives cashiers create_purchase: then it can, into shop A', !r.err && imp && imp.o === A, { r, imp });
  await as(db, A, `UPDATE public.hangtag_roles SET permissions = $1 WHERE role = 'cashier'`, [ROLE_DEFAULTS.cashier.filter((p) => p !== 'create_sale')]);
  r = await saveBill(db, CA, bill('s-ca2', 100));
  check('the owner takes create_sale away from cashiers: saving a bill is refused (Not allowed)', /Not allowed/.test(r.err || ''), r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_cash_moves (id, type, amount, reason, t) VALUES ('cm-ca2', 'in', 5, 'Tips jar', 6)`);
  check('…and so are cash entries', rls(r), r);
  await as(db, A, `DELETE FROM public.hangtag_roles WHERE role = 'cashier'`);
  r = await saveBill(db, CA, bill('s-ca2', 100));
  check('the owner puts the defaults back (removes the row): the cashier sells again', !r.err, r);
}

console.log('=== no device, another device, revoked device, disabled member: nothing at all ===');
{
  const blind = async (who) => {
    const s = await one(db, who, `SELECT public.hangtag_shop_id() AS s, public.hangtag_role() AS r, public.hangtag_can('view_products') AS c`);
    const seen = (await count(db, who, 'hangtag_products')) + (await count(db, who, 'hangtag_members')) + (await count(db, who, 'hangtag_devices')) + (await count(db, who, 'hangtag_customers'));
    const w = await tryAs(db, who, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c-x', 'X')`);
    const b = await saveBill(db, who, bill('s-x', 100));
    return s.s === null && s.r === null && s.c === false && seen === 0 && !!w.err && /Not allowed/.test(b.err || '') ? true : { s, seen, w, b };
  };
  let r = await blind({ id: CA.id, key: null });
  check('a member without the device header sees nothing and can\'t write', r === true, r);
  r = await blind({ id: CA.id, key: 'wrong-key-000000000000000000000' });
  check('…with a key that isn\'t a device\'s', r === true, r);
  r = await blind({ id: CA.id, key: KA.key });
  check('…with another member\'s device key', r === true, r);
  r = await blind({ id: DA.id, key: DA.key });
  check('a disabled member with an active device sees nothing', r === true, r);
  // the owner revokes the kitchen phone
  r = await tryAs(db, A, `UPDATE public.hangtag_devices SET status = 'revoked', revoked_at = now() WHERE id = $1 RETURNING id`, [KA.dev]);
  check('the owner revokes a device', !r.err && r.r.rows.length === 1, r);
  r = await blind(KA);
  check('a revoked device sees nothing on its very next request', r === true, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_devices SET status = 'active', revoked_at = NULL WHERE id = $1`, [KA.dev]);
  check('a revoked device can\'t be switched back on (not even by the owner)', /can't be switched back on/.test(r.err || ''), r);
  r = await trySvc(db, `UPDATE public.hangtag_devices SET status = 'active', revoked_at = NULL WHERE id = $1`, [KA.dev]);
  check('…nor by the team function', /can't be switched back on/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_devices SET key_hash = $1 WHERE id = $2`, [hash('x'), CA.dev]);
  check('the owner can\'t set a device\'s key', denied(r), r);
  r = await trySvc(db, `UPDATE public.hangtag_devices SET key_hash = $1 WHERE id = $2`, [hash('y'), CA.dev]);
  check('a device keeps its key for good', /keeps its shop, member and key/.test(r.err || ''), r);
  // the owner disables and enables the cashier
  await as(db, A, `UPDATE public.hangtag_members SET status = 'disabled' WHERE user_id = $1`, [CA.id]);
  r = await blind(CA);
  check('the owner disables a member: nothing from its device', r === true, r);
  await as(db, A, `UPDATE public.hangtag_members SET status = 'active' WHERE user_id = $1`, [CA.id]);
  check('enabled again: its device works again', (await count(db, CA, 'hangtag_products')) === 2);
  r = await tryAs(db, OUT, `SELECT public.hangtag_shop_id()::text AS s`);
  check('an account that isn\'t in any team is its own (empty) shop', !r.err && r.r.rows[0].s === OUT && (await count(db, OUT, 'hangtag_products')) === 0, r);
  r = await tryAs(db, null, `SELECT public.hangtag_shop_id()`);
  check('signed-out visitors can\'t even ask', denied(r), r);
}

console.log('=== shop A and shop B never meet ===');
{
  // a serial-tracked phone and a batch of rice in each shop (section 3n: the serial register and the batches)
  for (const owner of [A, B]) {
    await as(db, owner, `INSERT INTO public.hangtag_products (id, name, price, tracking, options) VALUES ('ph', 'Phone', 9000, 'serial', '{"opts":[]}'), ('rc', 'Rice', 60, 'batch', '{"opts":[]}')`);
    await as(db, owner, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('ph:', 'ph', '[]'), ('rc:', 'rc', '[]')`);
    await as(db, owner, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t, serials) VALUES ('in-ph', 'ph:', 'ph', 'RESTOCK', 1, 1, ARRAY['IMEI-1'])`);
    await as(db, owner, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t, batch_no, expiry) VALUES ('in-rc', 'rc:', 'rc', 'RESTOCK', 5, 1, 'B1', '2030-01-01')`);
  }
  const tables = (await db.query(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'owner_id'
      AND table_name LIKE 'hangtag_%' AND table_name NOT LIKE 'hangtag_backup%' ORDER BY 1`)).rows.map((x) => x.t);
  await asService(db, `INSERT INTO public.hangtag_enrollments (owner_id, user_id, token_hash) VALUES ($1, $2, $3), ($4, $5, $6)`, [A, CA.id, hash('enroll-a'), B, CB.id, hash('enroll-b')]);
  const empty = [], leaks = [];
  for (const t of tables) {
    const own = await count(db, A, t, `WHERE owner_id = '${A}'`);
    if (!own) empty.push(t);
    for (const [label, who] of [['B', B], ['B cashier', CB], ['outsider', OUT]]) {
      const n = await count(db, who, t, `WHERE owner_id = '${A}'`);
      if (n) leaks.push(`${label} sees ${n} of A's ${t}`);
    }
    const n = await count(db, CA, t, `WHERE owner_id = '${B}'`);
    if (n) leaks.push(`A cashier sees ${n} of B's ${t}`);
  }
  check(`shop A has rows in every one of the ${tables.length} shop tables (so the check below means something)`, empty.length === 0 && tables.length === 34, empty);
  check('no one from shop B (owner or cashier), nor an outsider, sees any row of shop A in any table; nor A\'s cashier any of B\'s', leaks.length === 0, leaks);
  check('B sees none of A\'s team, and A none of B\'s', (await count(db, B, 'hangtag_members', `WHERE shop_id = '${A}'`)) === 0 && (await count(db, A, 'hangtag_members', `WHERE shop_id = '${B}'`)) === 0
    && (await count(db, CB, 'hangtag_members')) === 1);
  const prof = await rows(db, CB, `SELECT id::text AS id FROM public.hangtag_profiles`);
  check('B\'s cashier reads B\'s profile, never A\'s', prof.length === 2 && !prof.some((p) => p.id === A), prof);
  let r = await tryAs(db, CA, `INSERT INTO public.hangtag_customers (owner_id, id, name) VALUES ($1, 'c-evil', 'X')`, [B]);
  check('A\'s cashier can\'t write into shop B, even naming it', rls(r), r);
  r = await tryAs(db, B, `UPDATE public.hangtag_products SET price = 1 WHERE owner_id = $1 RETURNING id`, [A]);
  check('B can\'t change A\'s products', !r.err && r.r.rows.length === 0, r);
  r = await tryAs(db, B, `UPDATE public.hangtag_devices SET status = 'revoked', revoked_at = now() WHERE owner_id = $1 RETURNING id`, [A]);
  check('B can\'t revoke A\'s devices', !r.err && r.r.rows.length === 0, r);
  r = await tryAs(db, CB, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([billArgs(bill('s1', 999))])]);
  const s1 = await one(db, A, `SELECT total FROM public.hangtag_sales WHERE id = 's1'`);
  check('B\'s cashier saving a bill with A\'s bill id changes only B\'s bill', !r.err && +s1.total === 500, { r, s1 });
}

console.log('=== the audit log ===');
{
  let r = await tryAs(db, CA, `UPDATE public.hangtag_sales SET is_void = TRUE, void_reason = $1 WHERE id = 's-ca' RETURNING id`, ['Wrong size given to the customer; ' + 'x'.repeat(150)]);
  const v = await one(db, A, `SELECT user_id::text AS u, device_id, action, entity, entity_id, summary FROM public.hangtag_audit_log WHERE entity = 'sales' AND entity_id = 's-ca' ORDER BY id DESC LIMIT 1`);
  check('a cashier cancels a bill: logged as "void" with the cashier and its device', !r.err && v && v.u === CA.id && v.device_id === CA.dev && v.action === 'void', { r, v });
  check('…with the bill number and the reason (cut short: audit rows stay small)', v && v.summary.bill_no === 'INV-s-ca' && v.summary.void_reason.length === 80 && v.summary.changed.includes('is_void'), v && v.summary);
  const before = await count(db, A, 'hangtag_audit_log');
  await saveBill(db, A, bill('s1', 500));
  await as(db, A, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1', 'Asha', '9876543210') ON CONFLICT (owner_id, id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone`);
  await one(db, CA, `SELECT public.hangtag_touch_device() AS t`);
  await as(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('in-1', 'p1:M', 'p1', 'RESTOCK', 3, 7)`);
  check('uploading the same bill or customer again, "last seen", and stock in log nothing', (await count(db, A, 'hangtag_audit_log')) === before);
  const adj = await one(db, A, `SELECT user_id::text AS u, device_id, action, summary FROM public.hangtag_audit_log WHERE entity = 'stock_moves' AND entity_id = 'adj-ma'`);
  check('a manager\'s stock adjustment is logged with its quantity and note', adj && adj.u === MA.id && adj.device_id === MA.dev && adj.action === 'insert' && adj.summary.qty === -2 && adj.summary.note === 'Damaged', adj);
  const cm = await one(db, A, `SELECT user_id::text AS u, device_id, summary FROM public.hangtag_audit_log WHERE entity = 'cash_moves' AND entity_id = 'cm-ca'`);
  check('a cash entry is logged with the amount and reason', cm && cm.u === CA.id && cm.device_id === CA.dev && +cm.summary.amount === 50 && cm.summary.reason === 'Change from bank', cm);
  const ret = await one(db, A, `SELECT user_id::text AS u, action FROM public.hangtag_audit_log WHERE entity = 'returns' AND entity_id = 'r-ca'`);
  check('a return is logged', ret && ret.u === CA.id && ret.action === 'insert', ret);
  await as(db, A, `UPDATE public.hangtag_products SET archived = TRUE WHERE id = 'p2'`);
  const arc = await rows(db, A, `SELECT action, user_id::text AS u FROM public.hangtag_audit_log WHERE entity = 'products' AND entity_id = 'p2' ORDER BY id`);
  check('products: added (by the manager) and archived (by the owner)', arc.length === 2 && arc[0].action === 'insert' && arc[0].u === MA.id && arc[1].action === 'archive' && arc[1].u === A, arc);
  const team = await rows(db, A, `SELECT action, entity, entity_id, user_id::text AS u FROM public.hangtag_audit_log WHERE entity IN ('members','devices','roles') ORDER BY id`);
  check('team changes are logged: members added (by the owner, through the function), devices, the revoke, roles, disable / enable',
    team.some((x) => x.entity === 'members' && x.action === 'insert' && x.entity_id === CA.id && x.u === A) && team.some((x) => x.entity === 'devices' && x.action === 'revoke' && x.entity_id === KA.dev && x.u === A)
    && team.some((x) => x.entity === 'roles' && x.action === 'update') && team.some((x) => x.action === 'disable') && team.some((x) => x.action === 'enable')
    && !team.some((x) => x.action === 'update' && x.entity === 'devices'), team);
  const big = await one(db, A, `SELECT max(octet_length(summary::text))::int AS n FROM public.hangtag_audit_log`);
  check('audit rows are small (summary under 1 KB)', big.n < 1024, big);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_audit_log (action, entity) VALUES ('insert', 'sales')`);
  check('nobody writes the audit log, not even the owner', denied(r), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_audit_log SET action = 'x'`);
  check('…nor changes it', denied(r), r);
  r = await tryAs(db, A, `DELETE FROM public.hangtag_audit_log`);
  check('…nor deletes from it', denied(r), r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_audit_log (action, entity) VALUES ('insert', 'sales')`);
  check('…and a member neither', denied(r), r);
  check('the owner and the manager read it; the cashier doesn\'t (view_reports)', (await count(db, A, 'hangtag_audit_log')) > 5 && (await count(db, MA, 'hangtag_audit_log')) === (await count(db, A, 'hangtag_audit_log'))
    && (await count(db, CA, 'hangtag_audit_log')) === 0);
}

console.log('=== bills, returns and stock records are history: a member adds them, never rewrites or removes them ===');
{
  const s1 = async () => one(db, A, `SELECT total, is_void, (SELECT sum(amount_in)::int FROM public.hangtag_cash_book c WHERE c.owner_id = s.owner_id AND c.sale_id = s.id) AS cash
    FROM public.hangtag_sales s WHERE s.id = 's1'`);
  const was = await s1(), logs = await count(db, A, 'hangtag_audit_log');
  let r = await saveBill(db, CA, bill('s1', 100));
  check('a cashier re-saving the owner\'s 500 bill as 100 through the RPC changes nothing (the bill and its cash book entry stay)', !r.err && eq(await s1(), was) && +was.total === 500 && was.cash === 500, { r, was, now: await s1() });
  r = await tryAs(db, CA, `UPDATE public.hangtag_sales SET total = 100, subtotal = 100 WHERE id = 's1'`);
  check('…nor directly (refused: only the owner changes a saved bill)', /Only the owner can change a saved bill/.test(r.err || '') && eq(await s1(), was), r);
  r = await tryAs(db, CA, `DELETE FROM public.hangtag_sales WHERE id = 's1' RETURNING id`);
  const r2 = await tryAs(db, CA, `DELETE FROM public.hangtag_payments RETURNING id`), r3 = await tryAs(db, CA, `DELETE FROM public.hangtag_sale_items RETURNING id`);
  check('…nor removes a bill, its payments or lines (nothing removed, the cash book keeps the sale)', !r.err && r.r.rows.length === 0 && !r2.err && r2.r.rows.length === 0 && !r3.err && r3.r.rows.length === 0
    && eq(await s1(), was), { r, r2, r3 });
  r = await tryAs(db, CA, `UPDATE public.hangtag_payments SET amount = 1 WHERE sale_id = 's1'`);
  check('…nor changes a payment', /Only the owner can change a saved bill/.test(r.err || ''), r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, quantity, unit_price) VALUES ('s1', 7, 'p1', 'Tee', 1, 500)`);
  const r4 = await tryAs(db, CA, `INSERT INTO public.hangtag_payments (id, sale_id, method, amount, t) VALUES ('s1:x', 's1', 'cash', 1, 1)`);
  check('…nor adds a line or a payment to a saved bill', /Only the owner can change a saved bill/.test(r.err || '') && /Only the owner can change a saved bill/.test(r4.err || ''), { r, r4 });
  r = await saveBill(db, CA, bill('s-ca', 1));
  const own = await one(db, A, `SELECT total, is_void FROM public.hangtag_sales WHERE id = 's-ca'`);
  check('its own saved bill sent again (a retry) saves nothing new and no error', !r.err && +own.total === 300, { r, own });
  check('none of that wrote an audit row (nothing changed)', (await count(db, A, 'hangtag_audit_log')) === logs);
  // cancelling needs perform_return or manage_settings
  await as(db, A, `INSERT INTO public.hangtag_roles (role, permissions) VALUES ('cashier', $1)`, [ROLE_DEFAULTS.cashier.filter((p) => p !== 'perform_return')]);
  r = await tryAs(db, CA, `UPDATE public.hangtag_sales SET is_void = TRUE, void_reason = 'x' WHERE id = 's2' RETURNING id`);
  check('a role without returns (or settings) can\'t cancel a bill', /Not allowed to cancel bills/.test(r.err || '') && (await one(db, A, `SELECT is_void FROM public.hangtag_sales WHERE id = 's2'`)).is_void === false, r);
  // discounts need apply_discount, in the RPC and directly
  await as(db, A, `UPDATE public.hangtag_roles SET permissions = $1 WHERE role = 'cashier'`, [ROLE_DEFAULTS.cashier.filter((p) => p !== 'apply_discount')]);
  r = await saveBill(db, CA, bill('s-disc', 500, { disc: { type: 'fixed', value: 450 } }));
  check('a cashier whose role can\'t give discounts: a 90%-off bill is refused (Not allowed to give discounts)', /Not allowed to give discounts/.test(r.err || '')
    && !(await one(db, A, `SELECT count(*)::int AS n FROM public.hangtag_sales WHERE id = 's-disc'`)).n, r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, bill_discount, total, payment_method) VALUES ('s-disc2', 1, 500, 450, 450, 50, 'cash')`);
  check('…also when written directly', /Not allowed to give discounts/.test(r.err || ''), r);
  r = await saveBill(db, CA, bill('s-nodisc', 500));
  check('…while a bill without a discount is saved', !r.err, r);
  await as(db, A, `DELETE FROM public.hangtag_roles WHERE role = 'cashier'`);
  r = await saveBill(db, CA, bill('s-disc', 500, { disc: { type: 'fixed', value: 50 } }));
  check('with the default cashier role (Give discounts) the discounted bill is saved', !r.err && +(await one(db, A, `SELECT bill_discount FROM public.hangtag_sales WHERE id = 's-disc'`)).bill_discount === 50, r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s-rest', 1, 500, 500, 'cash')`);
  const r5 = await tryAs(db, CA, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, quantity, unit_price) VALUES ('s-rest', 0, 'p1', 'Tee', 1, 500)`);
  check('a bill written directly is one bill: its lines come in the same save only (the RPC), not later', !r.err && /Only the owner can change a saved bill/.test(r5.err || ''), { r, r5 });
  // returns
  const r1 = async () => one(db, A, `SELECT refund_amount, value FROM public.hangtag_returns WHERE id = 'r1'`), rw = await r1();
  r = await saveReturn(db, CA, 'r1', 's1', 1);
  check('a cashier re-saving the owner\'s return with a refund of 1 changes nothing', !r.err && eq(await r1(), rw), { r, now: await r1() });
  r = await tryAs(db, CA, `UPDATE public.hangtag_returns SET refund_amount = 400 WHERE id = 'r1'`);
  const r6 = await tryAs(db, CA, `DELETE FROM public.hangtag_return_items RETURNING return_id`);
  check('…nor directly; nor removes return lines', /Only the owner can change a saved return/.test(r.err || '') && !r6.err && r6.r.rows.length === 0 && eq(await r1(), rw), { r, r6 });
  // stock records
  const open = async () => one(db, A, `SELECT qty FROM public.hangtag_stock_moves WHERE id = 'open:p1:M'`);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('mv-ca', 'p1:M', 'p1', 'RESTOCK', 1, 9)`);
  check('a cashier (returns) adds a stock record', !r.err, r);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('mv-ca', 'p1:M', 'p1', 'RESTOCK', 1, 9)
    ON CONFLICT (owner_id, id) DO UPDATE SET qty = EXCLUDED.qty, type = EXCLUDED.type`);
  check('…and may send it again unchanged (a retry)', !r.err, r);
  r = await tryAs(db, CA, `UPDATE public.hangtag_stock_moves SET qty = 5 WHERE id = 'open:p1:M'`);
  const r7 = await tryAs(db, CA, `DELETE FROM public.hangtag_stock_moves WHERE id = 'open:p1:M' RETURNING id`);
  check('…but can\'t change or remove the owner\'s opening stock (no stock adjustments)', /can change saved stock records/.test(r.err || '') && !r7.err && r7.r.rows.length === 0 && +(await open()).qty === 20, { r, r7 });
  const before = await count(db, A, 'hangtag_audit_log');
  r = await tryAs(db, MA, `UPDATE public.hangtag_stock_moves SET qty = 19 WHERE id = 'open:p1:M' RETURNING id`);
  const ch = await one(db, A, `SELECT user_id::text AS u, action, summary FROM public.hangtag_audit_log WHERE entity = 'stock_moves' AND entity_id = 'open:p1:M' ORDER BY id DESC LIMIT 1`);
  check('a manager (stock adjustments) may change it, and the change of an opening stock record is logged', !r.err && r.r.rows.length === 1 && ch && ch.u === MA.id && ch.action === 'update' && ch.summary.changed.includes('qty'), { r, ch });
  await as(db, A, `DELETE FROM public.hangtag_stock_moves WHERE id = 'in-1'`);
  const del = await one(db, A, `SELECT user_id::text AS u, action FROM public.hangtag_audit_log WHERE entity = 'stock_moves' AND entity_id = 'in-1'`);
  check('removing a stock-in record is logged too', del && del.u === A && del.action === 'delete' && (await count(db, A, 'hangtag_audit_log')) > before, del);
  // the owner may still change and remove bills, and it is logged
  r = await saveBill(db, A, bill('s-nodisc', 450));
  const upd = await one(db, A, `SELECT user_id::text AS u, action, summary FROM public.hangtag_audit_log WHERE entity = 'sales' AND entity_id = 's-nodisc' ORDER BY id DESC LIMIT 1`);
  check('the owner re-saving a bill with a new total: saved, and logged with what changed', !r.err && upd && upd.u === A && upd.action === 'update' && upd.summary.changed.includes('total') && +upd.summary.total === 450, { r, upd });
  r = await tryAs(db, A, `DELETE FROM public.hangtag_sales WHERE id = 's-nodisc' RETURNING id`);
  const gone = await rows(db, A, `SELECT entity, action FROM public.hangtag_audit_log WHERE action = 'delete' AND (entity_id = 's-nodisc' OR summary ->> 'sale_id' = 's-nodisc') ORDER BY entity`);
  check('the owner removes a bill: the bill, its line and its payment removals are logged', !r.err && r.r.rows.length === 1 && gone.map((g) => g.entity).join() === 'payments,sale_items,sales', gone);
}

console.log('=== the team function\'s changes name the owner; sign-ins end; access reset ===');
{
  const K2 = 'key-cashier-0001-second-phone-xyz';
  await asService(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, key_hash, changed_by) VALUES ($1, 'dev-ca-2', $2, 'Second', $3, $2)`, [A, CA.id, hash(K2)]);
  await asService(db, `UPDATE public.hangtag_devices SET status = 'revoked', revoked_at = now(), changed_by = $1 WHERE id = 'dev-ca-2'`, [A]);
  const dl = await rows(db, A, `SELECT action, user_id::text AS u FROM public.hangtag_audit_log WHERE entity = 'devices' AND entity_id = 'dev-ca-2' ORDER BY id`);
  check('a phone added by the member and revoked by the owner, both through the team function (service role): logged with who did each', dl.length === 2
    && dl[0].action === 'insert' && dl[0].u === CA.id && dl[1].action === 'revoke' && dl[1].u === A, dl);
  await asService(db, `UPDATE public.hangtag_members SET access_reset_at = now(), changed_by = $1 WHERE user_id = $2`, [A, CA.id]);
  const rs = await one(db, A, `SELECT action, user_id::text AS u FROM public.hangtag_audit_log WHERE entity = 'members' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [CA.id]);
  check('resetting a member\'s access is logged as "reset", by the owner', rs && rs.action === 'reset' && rs.u === A, rs);
  const n0 = await count(db, A, 'hangtag_audit_log');
  await asService(db, `UPDATE public.hangtag_members SET changed_by = $1 WHERE user_id = $2`, [A, CA.id]);
  check('noting who changes a row, alone, logs nothing', (await count(db, A, 'hangtag_audit_log')) === n0);
  await asService(db, `UPDATE public.hangtag_members SET status = 'disabled', changed_by = $1 WHERE user_id = $2`, [A, SA.id]);
  const sa = await one(db, A, `SELECT access_reset_at FROM public.hangtag_members WHERE user_id = $1`, [SA.id]);
  await asService(db, `UPDATE public.hangtag_members SET status = 'active' WHERE user_id = $1`, [SA.id]);
  check('switching a member off notes access_reset_at (a phone is added again only after a later password sign-in)', !!sa.access_reset_at, sa);
  await db.query(`INSERT INTO auth.sessions (user_id) VALUES ($1), ($1), ($2)`, [CA.id, A]);
  let r = await tryAs(db, A, `SELECT public.hangtag_end_sessions($1) AS ok`, [CA.id]);
  check('ending sign-ins is for the team function only (not even the owner calls it)', denied(r), r);
  r = await trySvc(db, `SELECT public.hangtag_end_sessions($1) AS ok`, [CA.id]);
  const left = async (u) => (await db.query(`SELECT count(*)::int AS n FROM auth.sessions WHERE user_id = $1`, [u])).rows[0].n;
  check('the team function ends every sign-in of a member', !r.err && r.r.rows[0].ok === true && (await left(CA.id)) === 0, r);
  r = await trySvc(db, `SELECT public.hangtag_end_sessions($1) AS ok`, [A]);
  check('…never an owner\'s', !r.err && r.r.rows[0].ok === false && (await left(A)) === 1, r);
  await db.exec(`ALTER TABLE auth.sessions RENAME TO sessions_off`);
  r = await trySvc(db, `SELECT public.hangtag_end_sessions($1) AS ok`, [CA.id]);
  await db.exec(`ALTER TABLE auth.sessions_off RENAME TO sessions`);
  check('where the database can\'t reach the sessions it says so (false) instead of failing', !r.err && r.r.rows[0].ok === false, r);
}

console.log('=== what changed in the shop (a member\'s phone polls this instead of downloading everything) ===');
{
  const ch = async (who) => (await one(db, who, `SELECT public.hangtag_shop_changes() AS c`)).c;
  const c1 = await ch(CA), c2 = await ch(CA);
  check('one small answer per part of the shop; the same when nothing changed', ['catalog', 'images', 'moves', 'returns', 'customers', 'events', 'cash', 'settings', 'sales'].every((k) => typeof c1[k] === 'string')
    && eq(c1, c2) && c1.sales_count === (await count(db, A, 'hangtag_sales')) && !!c1.sales_since && JSON.stringify(c1).length < 1000, c1);
  await as(db, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c-new', 'Neha')`);
  await as(db, A, `UPDATE public.hangtag_products SET price = 550, updated_at = now() WHERE id = 'p1'`);
  const c3 = await ch(CA);
  check('a new customer and a changed product change just those parts', c3.customers !== c1.customers && c3.catalog !== c1.catalog && c3.sales === c1.sales && c3.moves === c1.moves && c3.images === c1.images, { c1, c3 });
  await saveBill(db, A, bill('s-poll', 500));
  await as(db, A, `UPDATE public.hangtag_sales SET is_void = TRUE, void_reason = 'Duplicate' WHERE id = 's1'`);
  const c4 = await ch(CA);
  check('a new bill and a cancelled one change the bills part (count, newest, cancelled)', c4.sales !== c3.sales && c4.sales_count === c3.sales_count + 1 && Date.parse(c4.sales_since) >= Date.parse(c3.sales_since), { c3, c4 });
  const cb = await ch(CB);
  check('row security decides what is counted: B\'s cashier counts only B\'s bills', cb.sales_count === (await count(db, B, 'hangtag_sales')) && cb.sales_count !== c4.sales_count, cb);
  const r = await tryAs(db, null, `SELECT public.hangtag_shop_changes()`);
  check('signed-out visitors can\'t ask', denied(r), r);
  const langs = await db.query(`SELECT p.proname, l.lanname FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.proname IN ('hangtag_shop_id','hangtag_role','hangtag_can')`);
  check('the access checks row security calls are plpgsql (their plans are kept per session)', langs.rows.length === 3 && langs.rows.every((x) => x.lanname === 'plpgsql'), langs.rows);
}

console.log('=== enrollment tokens ===');
{
  check('the owner sees the shop\'s enrollment tokens (hashes only); members don\'t', (await count(db, A, 'hangtag_enrollments')) === 1 && (await count(db, MA, 'hangtag_enrollments')) === 0);
  let r = await tryAs(db, A, `INSERT INTO public.hangtag_enrollments (user_id, token_hash) VALUES ($1, $2)`, [CA.id, hash('mine')]);
  check('only the team function makes them', denied(r), r);
  const e = await one(db, A, `SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM public.hangtag_enrollments`);
  check('a token lasts 10 minutes', e.s === 600, e);
  r = await trySvc(db, `INSERT INTO public.hangtag_enrollments (owner_id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`, [A, CA.id, hash('long')]);
  check('…never longer', /expiry_check/.test(r.err || ''), r);
}

console.log('=== accounts removed ===');
{
  await db.query(`DELETE FROM auth.users WHERE id = $1`, [SA.id]);
  const gone = await one(db, A, `SELECT (SELECT count(*) FROM public.hangtag_members WHERE user_id = '${SA.id}')::int AS m, (SELECT count(*) FROM public.hangtag_devices WHERE user_id = '${SA.id}')::int AS d`);
  const log = await rows(db, A, `SELECT entity, action FROM public.hangtag_audit_log WHERE entity_id IN ($1, $2) AND action = 'delete'`, [SA.id, SA.dev]);
  check('removing a member\'s account removes its member row and devices, and the log says so', gone.m === 0 && gone.d === 0 && log.length === 2, { gone, log });
  let err = null;
  try { await db.query(`DELETE FROM auth.users WHERE id = $1`, [B]); } catch (e) { err = e.message; }
  check('deleting a whole shop\'s account still works (its team, rows and log go with it)', !err && (await db.query(`SELECT count(*)::int n FROM public.hangtag_members WHERE shop_id = $1`, [B])).rows[0].n === 0
    && (await db.query(`SELECT count(*)::int n FROM public.hangtag_audit_log WHERE owner_id = $1`, [B])).rows[0].n === 0, err);
}

console.log('=== report after use ===');
{
  let rep = await report(db);
  check('migration report: every row ok with a team, devices and audit rows present', rep.length === 46 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  await db.query(`INSERT INTO public.hangtag_products (owner_id, id, name) VALUES ($1, 'stray', 'Stray')`, [CA.id]);
  rep = await report(db);
  check('the report spots a member that runs a shop of its own', rep.find((r) => /no shop of their own/.test(r.check_name)).ok === false);
  await db.query(`DELETE FROM public.hangtag_products WHERE owner_id = $1`, [CA.id]);
  check('…and is all ok again once that is sorted', (await report(db)).every((r) => r.ok));
}

console.log('=== upgrade from the schema on the live database today (fixtures/legacy/schema_v6.sql: "Own rows only") ===');
{
  const V6 = fs.readFileSync(new URL('./fixtures/legacy/schema_v6.sql', import.meta.url), 'utf8');
  const up = new PGlite();
  await up.exec(SUPABASE);
  await up.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
  await up.exec(V6);
  const old = (await up.query(`SELECT count(*)::int n FROM pg_policies WHERE policyname = 'Own rows only'`)).rows[0].n;
  await as(up, A, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Tee', 500, '{"opts":[{"name":"Size","values":["M"]}]}')`);
  await as(up, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, size) VALUES ('p1:M', 'p1', '["M"]', 'M')`);
  await as(up, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c1', 'Asha')`);
  let r = await saveBill(up, A, bill('old1', 500));
  check('the old schema works as before (bill saved)', !r.err && old === 22, { r, old });
  await up.exec(NEW); await up.exec(NEW);
  const left = (await up.query(`SELECT count(*)::int n FROM pg_policies WHERE policyname = 'Own rows only'`)).rows[0].n;
  check('running the new script twice replaces every "Own rows only" rule', left === 0, left);
  check('the owner still sees its products, customers and bills', (await count(up, A, 'hangtag_products')) === 1 && (await count(up, A, 'hangtag_customers')) === 1
    && (await count(up, A, 'hangtag_sales')) === 1 && (await count(up, A, 'hangtag_payments')) === 1 && (await count(up, B, 'hangtag_sales')) === 0);
  r = await saveBill(up, A, bill('new1', 700));
  const o = await one(up, A, `SELECT owner_id::text AS o FROM public.hangtag_sales WHERE id = 'new1'`);
  r = !r.err && o.o === A ? await tryAs(up, A, `UPDATE public.hangtag_products SET archived = TRUE WHERE id = 'p1' RETURNING id`) : r;
  check('…and keeps saving bills and changing products (owner_id still the owner)', !r.err && r.r.rows.length === 1, r);
  const rep = await report(up);
  check('the report is all ok after the upgrade', rep.length === 46 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
