// Section 3r of schema.sql (the commerce batch): price lists (one default, the customer's own list from the same shop
// only, the resolver's order), purchase orders that never change stock and receiving on them (partly, more than once,
// never more than is still to come, the same receipt once), kits sold as their components' lines, staff sales orders
// never delivered twice, e-invoice / e-way bill rows whose IRN and EWB number only the GST provider writes, repacks that
// reconcile, gift vouchers spent as a payment (never twice, never another shop's, back on the voucher when the bill is
// cancelled), outbound webhooks (owner only, secrets unreadable, one event per change), and the migration file applying
// on top of the schema. PGlite with Supabase stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';
import { buildPurchase } from '../../src/domain/inventory/purchase.js';
import { paymentId } from '../../src/domain/sales/payments.js';
import { billArgs, orderArgs, purchaseArgs } from '../../src/infrastructure/supabase/mappers.js';
import { poArgs, priceListRow, repackArgs } from '../../src/infrastructure/supabase/biz-mappers.js';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIG = fs.readFileSync(new URL('../migrations/20261003120000_hangtag_commerce_batch.sql', import.meta.url), 'utf8');
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
/* who: an owner's id, or a member { id, key } asking from its device */
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
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const trySvc = async (db, sql, params) => { try { return { r: await asService(db, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const rows = async (db, who, sql, params) => (await as(db, who, sql, params)).rows;
const one = async (db, who, sql, params) => (await rows(db, who, sql, params))[0];
const count = async (db, who, t, where = '') => (await one(db, who, `SELECT count(*)::int AS n FROM public.${t} ${where}`)).n;
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const rls = (r) => /row-level security/.test(r.err || '');
const denied = (r) => /permission denied/.test(r.err || '');
const val = (r) => r.r && r.r.rows[0] && r.r.rows[0].r;

/* A bill (no GST) of lines [{ p, v, n, q, price, kit? }], paid by parts [{ method, amount }] */
function bill(id, lines, parts, { order = null, isVoid = false } = {}) {
  const items = lines.map((l, k) => ({ ln: k, p: l.p, v: l.v, n: l.n, c: '', s: '', vl: '', ov: [], sku: '', q: l.q, price: l.price, cost: null, dAmt: 0, bdAmt: 0, gst: 0, hsn: '',
    tx: l.q * l.price, cgst: 0, sgst: 0, igst: 0, lt: l.q * l.price, ...(l.kit ? { kit: l.kit } : {}) }));
  const total = items.reduce((a, l) => a + l.lt, 0);
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null, items, sub: total, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0,
    taxable: total, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' }, roundOff: 0, total, void: isVoid,
    pay: parts.length > 1 ? 'split' : parts[0].method, payments: parts.map((p) => ({ id: paymentId(id, p.method), method: p.method, amount: p.amount })), ...(order ? { order } : {}) };
}
const saveBills = (db, who, bills) => tryAs(db, who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(bills.map(billArgs))]);
const savePO = (db, who, po) => tryAs(db, who, `SELECT public.hangtag_save_purchase_order($1::jsonb) AS r`, [JSON.stringify(poArgs(po).p_po)]);
function receipt(id, lines, { po = 'po1', sup = 'sup1', allowOver = false } = {}) {
  const b = buildPurchase({ id, supplierId: sup, supplierName: 'Ravi Traders', invoiceNo: 'R-' + id, invoiceDate: '2026-10-01', paid: 0, method: null, t: 1790000000000, dev: 'd1',
    poId: po, allowOver, lines: lines.map((l) => ({ p: l.p, v: l.v, n: l.n, q: l.q, cost: l.cost || 100, gst: 0, ...(l.dec ? { dec: l.dec } : {}) })) }, { today: '2026-12-31', moveId: (i) => id + ':m' + i });
  if (b.error) throw new Error(b.error);
  return b;
}
const receive = (db, who, b) => tryAs(db, who, `SELECT public.hangtag_save_purchase($1::jsonb, $2::jsonb, $3::jsonb) AS r`, (({ p_purchase, p_moves }) =>
  [JSON.stringify(p_purchase), JSON.stringify(p_moves), null])(purchaseArgs(b.purchase, b.moves)));
const stock = async (db, who, vid) => +(await one(db, who, `SELECT COALESCE(sum(qty), 0) AS n FROM public.hangtag_stock_moves WHERE variant_id = $1`, [vid])).n;

// ---------- two shops; A (electronics) switched this batch's parts on; its team: a cashier and a manager ----------
const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CA = { id: uid(1), role: 'cashier', key: 'key-cashier-0001-abcdefghijklmnop', dev: 'dev-cashier-1' };
const MA = { id: uid(3), role: 'manager', key: 'key-manager-0003-abcdefghijklmnop', dev: 'dev-manager-3' };
const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
for (const m of [CA, MA]) await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [m.id, m.role + '@staff.hangtag.invalid']);
await db.exec(NEW); await db.exec(NEW);
console.log('=== schema twice, then the migration twice on top ===');
{
  let err = null;
  try { await db.exec(MIG); await db.exec(MIG); } catch (e) { err = e.message; }
  check('the migration file runs on a database that has the schema, and again (safe to run again)', !err, err);
  const rep = await report(db);
  check('migration report: 76 rows, all ok (incl. price lists, POs, kits, vouchers, webhooks)', rep.length === 76 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  const sec = (await db.query(`SELECT relname FROM pg_class WHERE relname IN ('hangtag_price_lists','hangtag_purchase_orders','hangtag_einvoices','hangtag_eway_bills','hangtag_repacks',
    'hangtag_vouchers','hangtag_voucher_redemptions','hangtag_webhook_endpoints','hangtag_webhook_secrets','hangtag_webhook_events','hangtag_webhook_deliveries') AND relrowsecurity`)).rows;
  check('row security is on for every table of the batch', sec.length === 11, sec);
}
await db.query(`UPDATE public.hangtag_profiles SET business_type = 'electronics' WHERE id IN ($1, $2)`, [A, B]);
await as(db, A, `INSERT INTO public.hangtag_meta (key, value, updated_at) VALUES ('settings', $1::jsonb, now())`,
  [JSON.stringify({ caps: { uses_price_lists: true, uses_vouchers: true, uses_einvoice: true, uses_eway: true, uses_repack: true } })]);
for (const owner of [A, B]) {
  await as(db, owner, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Earbuds', 500, '{"opts":[]}'), ('cb', 'Cable', 200, '{"opts":[]}'),
    ('rice', 'Rice', 60, '{"opts":[]}'), ('pack', 'Rice 500 g', 35, '{"opts":[]}'), ('kit1', 'Starter kit', 1000, '{"opts":[]}')`);
  await as(db, owner, `INSERT INTO public.hangtag_variants (id, product_id, option_values, size) VALUES ('p1:M', 'p1', '[]', ''), ('cb:1', 'cb', '[]', ''), ('rice:1', 'rice', '[]', ''),
    ('pack:1', 'pack', '[]', ''), ('kit1:1', 'kit1', '[]', '')`);
  await as(db, owner, `INSERT INTO public.hangtag_suppliers (id, name) VALUES ('sup1', 'Ravi Traders'), ('sup2', 'Mill Co')`);
}
for (const m of [CA, MA]) {
  await asService(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, created_by) VALUES ($1, $2, $3, $4, $5, $2)`, [m.id, A, 'Staff ' + m.role, m.role + '1', m.role]);
  await asService(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, key_hash) VALUES ($1, $2, $3, 'Phone', $4)`, [A, m.dev, m.id, hash(m.key)]);
}

console.log('=== price lists ===');
{
  const ins = (who, l) => { const r = priceListRow({ t: 1, dev: 'd1', ...l }); return tryAs(db, who, `INSERT INTO public.hangtag_price_lists (id, name, is_default, active, starts_on, ends_on, prices, t, device_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [r.id, r.name, r.is_default, r.active, r.starts_on, r.ends_on, JSON.stringify(r.prices), r.t, r.device_id]); };
  let r = await ins(A, { id: 'wh', name: 'Wholesale', isDefault: true, prices: { 'p:p1': 450 } });
  check('the owner adds a default list', !r.err, r);
  r = await ins(A, { id: 'vip', name: 'VIP', isDefault: true, prices: { 'p:p1': 430, 'v:p1:M': 420 } });
  const defs = await rows(db, A, `SELECT id FROM public.hangtag_price_lists WHERE is_default`);
  check('making another list the default unmarks the old one (one default per shop)', !r.err && defs.length === 1 && defs[0].id === 'vip', { r, defs });
  r = await ins(A, { id: 'zero', name: 'Zero', prices: { 'p:p1': 0 } });
  check('a price of ₹0 is refused (never ₹0 by accident)', /more than ₹0/.test(r.err || ''), r);
  r = await ins(A, { id: 'wh2', name: ' wholesale ', prices: {} });
  check('two lists can\'t share a name', /uq_hangtag_price_lists_name|duplicate/.test(r.err || ''), r);
  r = await ins(B, { id: 'wh', name: 'Wholesale', prices: { 'p:p1': 400 } });
  check('a shop with price lists switched off can\'t add one', r.code === '42501' && /switched off/.test(r.err || ''), r);
  check('shop B sees none of A\'s lists; A\'s cashier reads them (for the till)', (await count(db, B, 'hangtag_price_lists')) === 0 && (await count(db, CA, 'hangtag_price_lists')) === 2);
  r = await tryAs(db, CA, `UPDATE public.hangtag_price_lists SET prices = '{"p:p1": 1}' WHERE id = 'vip' RETURNING id`);
  check('…but can\'t change them (manage_products)', !r.err && r.r.rows.length === 0 || rls(r), r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name, phone, price_list_id) VALUES ('c1', 'Kiran', '9988776655', 'wh'), ('c2', 'Asha', '9876543210', NULL)`);
  check('a customer gets their own list', !r.err, r);
  await db.query(`INSERT INTO public.hangtag_meta (owner_id, key, value, updated_at) VALUES ($1, 'settings', '{"caps":{"uses_price_lists":true}}', now())`, [B]);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_customers (id, name, phone, price_list_id) VALUES ('c9', 'X', '9000000000', 'vip')`);
  check('another shop\'s customer can\'t point at A\'s list (the key includes the shop)', /price_list_fkey|foreign key/.test(r.err || ''), r);
  await db.query(`DELETE FROM public.hangtag_meta WHERE owner_id = $1`, [B]);
  const price = async (cust, list, v, base) => +(await db.query(`SELECT public.hangtag_list_price($1, $2, $3, 'p1', $4, $5) AS p`, [A, cust, list, v, base])).rows[0].p;
  check('the resolver: the customer\'s own list first (Wholesale ₹450 for Kiran)', (await price('c1', 'vip', 'p1:M', 500)) === 450);
  check('…then the chosen list (a variant price wins over its product\'s)', (await price('c2', 'vip', 'p1:M', 500)) === 420);
  check('…then the shop\'s default list', (await price('c2', null, 'p1:X', 500)) === 430);
  await as(db, A, `UPDATE public.hangtag_price_lists SET active = FALSE, is_default = FALSE WHERE id = 'vip'`);
  check('…then the item\'s own price (a list not in use doesn\'t count)', (await price('c2', 'vip', 'p1:M', 500)) === 500 && (await price(null, null, null, 0)) === 0);
  const rv = await tryAs(db, A, `SELECT public.hangtag_list_price($1, 'c1', null, 'p1', 'p1:M', 500)`, [A]);
  check('the database resolver isn\'t callable by the app (it uses its own copy)', denied(rv), rv);
}

console.log('=== purchase orders and receiving ===');
{
  const po = (over = {}) => ({ id: 'po1', no: 'PO-0001', supplierId: 'sup1', status: 'sent', expected: '2026-10-10', notes: '', t: 1790000000000, dev: 'd1', version: 0,
    items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Earbuds', q: 10, price: 300 }, { ln: 1, p: 'cb', v: 'cb:1', name: 'Cable', q: 5, price: 80 }], ...over });
  const before = await stock(db, A, 'p1:M');
  let r = await savePO(db, MA, po());
  check('a manager (create_purchase) saves a PO; it changes no stock', !r.err && val(r).version === 1 && (await stock(db, A, 'p1:M')) === before
    && (await count(db, A, 'hangtag_stock_moves')) === 0, r);
  r = await savePO(db, MA, po());
  check('the same save sent again is a safe retry', !r.err && val(r).version === 1, r);
  r = await savePO(db, A, po({ notes: 'call first' }));
  check('a change made on an old version is refused (another device changed it)', r.code === '40001', r);
  r = await savePO(db, CA, po({ id: 'po-ca' }));
  check('a cashier (no create_purchase) can\'t make one', r.code === '42501', r);
  r = await savePO(db, MA, po({ id: 'po-bad', items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Earbuds', q: 0 }] }));
  check('a line needs a quantity above 0', /quantity above 0/.test(r.err || ''), r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_purchase_orders (id, supplier_id, status, items, t) VALUES ('direct', 'sup1', 'draft', '[{"v":"p1:M","q":1}]', 1)`);
  check('POs are written only through the save function', denied(r), r);
  r = await receive(db, MA, receipt('rc1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 6 }]));
  check('receiving 6 of 10 on the PO: saved as a purchase pointing at it; stock +6', !r.err && val(r).status === 'saved' && (await stock(db, A, 'p1:M')) === before + 6
    && (await one(db, A, `SELECT po_id FROM public.hangtag_stock_imports WHERE id = 'rc1'`)).po_id === 'po1', r);
  r = await receive(db, MA, receipt('rc1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 6 }]));
  check('the same receipt sent again changes nothing', !r.err && val(r).status === 'already_saved' && (await stock(db, A, 'p1:M')) === before + 6, r);
  r = await receive(db, A, receipt('rc2', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 5 }]));
  check('a second phone receiving more than is still to come (5 > 4) is refused', /already received/.test(r.err || '') && (await stock(db, A, 'p1:M')) === before + 6, r);
  r = await receive(db, A, receipt('rc3', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 4 }, { p: 'cb', v: 'cb:1', n: 'Cable', q: 2.5, dec: 2 }]));
  check('a later session receives the rest of a line and part of another (decimals too)', !r.err && (await stock(db, A, 'p1:M')) === before + 10 && (await stock(db, A, 'cb:1')) === 2.5, r);
  r = await receive(db, A, receipt('rc4', [{ p: 'rice', v: 'rice:1', n: 'Rice', q: 1 }]));
  check('a product not on the PO is refused…', /isn't on it/.test(r.err || ''), r);
  r = await receive(db, A, receipt('rc4', [{ p: 'rice', v: 'rice:1', n: 'Rice', q: 1 }], { allowOver: true }));
  check('…unless received as extra', !r.err, r);
  r = await receive(db, A, receipt('rc5', [{ p: 'cb', v: 'cb:1', n: 'Cable', q: 1 }], { sup: 'sup2' }));
  check('goods for a PO come from its own supplier', /its own supplier/.test(r.err || ''), r);
  r = await savePO(db, A, po({ version: 1, items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Earbuds', q: 12, price: 300 }] }));
  check('once goods were received, the PO\'s lines stay as they are', /lines stay as they are/.test(r.err || ''), r);
  r = await savePO(db, A, po({ version: 1, status: 'closed', review: [{ ln: 1, kind: 'short', action: 'accept', note: 'rest next month', by: 'owner', t: 1790000001000 }] }));
  check('closing it with the review of differences (the receipts stay as they were)', !r.err && val(r).version === 2 && (await count(db, A, 'hangtag_stock_imports', `WHERE po_id = 'po1'`)) === 3, r);
  r = await receive(db, A, receipt('rc6', [{ p: 'cb', v: 'cb:1', n: 'Cable', q: 1 }]));
  check('nothing more is received on a closed PO', /closed/.test(r.err || ''), r);
  const audit = await rows(db, A, `SELECT action FROM public.hangtag_audit_log WHERE entity = 'purchase_orders' AND entity_id = 'po1'`);
  check('the PO and its review are in the audit log', audit.length >= 2, audit);
  check('shop B sees none of A\'s POs; A\'s cashier neither (no purchases, stock or reports)', (await count(db, B, 'hangtag_purchase_orders')) === 0 && (await count(db, CA, 'hangtag_purchase_orders')) === 0);
}

console.log('=== kits ===');
{
  await db.query(`INSERT INTO public.hangtag_meta (owner_id, key, value, updated_at) VALUES ($1, 'settings', '{"caps":{"uses_bundles":false}}', now())`, [B]);
  let r = await tryAs(db, B, `UPDATE public.hangtag_products SET bundle = '[{"v":"p1:M","q":1}]' WHERE id = 'kit1'`);
  check('a shop that switched kits off can\'t make one (electronics has them by default)', r.code === '42501' && /Kits are switched off/.test(r.err || ''), r);
  await db.query(`DELETE FROM public.hangtag_meta WHERE owner_id = $1`, [B]);
  r = await tryAs(db, A, `UPDATE public.hangtag_products SET bundle = '[{"v":"kit1:1","q":1}]' WHERE id = 'kit1'`);
  check('a kit can\'t contain itself', /Kit item/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_products SET bundle = '[{"v":"p1:M","q":2},{"v":"cb:1","q":1}]' WHERE id = 'kit1'`);
  check('a kit of 2 earbuds and a cable', !r.err, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_products SET bundle = '[{"v":"kit1:1","q":1}]' WHERE id = 'cb'`);
  check('a kit can\'t be part of another kit', /Kit item/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_products SET bundle = '[{"v":"p1:M","q":1},{"v":"p1:M","q":1}]' WHERE id = 'pack'`);
  check('an item is in a kit once', /twice/.test(r.err || ''), r);
  const kit = { v: 'kit1:1', p: 'kit1', name: 'Starter kit', n: 1 };
  r = await saveBills(db, CA, [bill('kb1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 2, price: 400, kit }, { p: 'cb', v: 'cb:1', n: 'Cable', q: 1, price: 200, kit }], [{ method: 'cash', amount: 1000 }])]);
  const it = await rows(db, A, `SELECT variant_id, quantity::float AS q, kit FROM public.hangtag_sale_items WHERE sale_id = 'kb1' ORDER BY line_no`);
  check('a kit sold is saved as its components\' lines (what stock counts), each remembering the kit', !r.err && it.length === 2 && it[0].variant_id === 'p1:M' && it[0].q === 2
    && it[1].kit.v === 'kit1:1' && it[1].kit.name === 'Starter kit', { r, it });
}

console.log('=== a staff sales order is never delivered twice ===');
{
  const so = { id: 'so1', kind: 'sales', no: 'SO-1', status: 'confirmed', cust: { id: 'c2', name: 'Asha', phone: '9876543210' }, billDisc: null, notes: '', validUntil: '', source: 'staff',
    saleIds: [], version: 0, t: 1790000000000, updatedT: 1790000000000, dev: 'd1', items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Earbuds', vl: '', q: 3, price: 500, gst: 0, fq: 0 }] };
  const a = orderArgs(so);
  let r = await tryAs(db, A, `SELECT public.hangtag_save_order($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a.p_order), JSON.stringify(a.p_items)]);
  check('a sales order of 3', !r.err, r);
  r = await saveBills(db, CA, [bill('sb1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 2, price: 500 }], [{ method: 'cash', amount: 1000 }], { order: 'so1' })]);
  check('the first bill delivers what is ready (2 of 3)', !r.err, r);
  r = await saveBills(db, MA, [bill('sb2', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 2, price: 500 }], [{ method: 'cash', amount: 1000 }], { order: 'so1' })]);
  check('another till delivering 2 more (only 1 remains) is refused', /already been fulfilled/.test(r.err || '') && (await count(db, A, 'hangtag_sales', `WHERE id = 'sb2'`)) === 0, r);
  r = await saveBills(db, MA, [bill('sb3', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 1, price: 500 }], [{ method: 'upi', amount: 500 }], { order: 'so1' })]);
  check('the remaining 1 is delivered later', !r.err, r);
}

console.log('=== e-invoice and e-way bill readiness ===');
{
  let r = await tryAs(db, CA, `INSERT INTO public.hangtag_einvoices (sale_id, status, payload, t) VALUES ('kb1', 'ready', '{"Version":"1.1"}', 1) RETURNING owner_id::text AS o`);
  check('a cashier keeps an e-invoice ready for a bill (the shop\'s row)', !r.err && r.r.rows[0].o === A, r);
  r = await tryAs(db, CA, `UPDATE public.hangtag_einvoices SET status = 'generated', irn = $1 WHERE sale_id = 'kb1'`, ['a'.repeat(64)]);
  check('the app can never write an IRN or mark it generated', r.code === '42501', r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_einvoices (sale_id, status) VALUES ('sb1', 'failed')`);
  check('…nor failed (only the GST provider)', r.code === '42501', r);
  r = await trySvc(db, `UPDATE public.hangtag_einvoices SET status = 'generated', irn = $1, ack_no = '112410000000001', provider = 'test' WHERE owner_id = $2 AND sale_id = 'kb1'`, ['b'.repeat(64), A]);
  check('a provider adapter (service role) stores the IRN it got', !r.err, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_einvoices SET status = 'ready', irn = NULL WHERE sale_id = 'kb1'`);
  check('…and the app can\'t undo a generated one', r.code === '42501', r);
  r = await trySvc(db, `UPDATE public.hangtag_einvoices SET status = 'generated', irn = NULL WHERE owner_id = $1 AND sale_id = 'kb1'`, [A]);
  check('generated always has its IRN', /generated_check/.test(r.err || ''), r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_eway_bills (sale_id, status, transport, t) VALUES ('kb1', 'ready', '{"mode":"road","vehicle":"MH12AB1234","distance":12}', 1)`);
  const r2 = await tryAs(db, A, `UPDATE public.hangtag_eway_bills SET ewb_no = '123456789012' WHERE sale_id = 'kb1'`);
  check('an e-way bill keeps its transport; its number comes only from the provider', !r.err && r2.code === '42501', { r, r2 });
  r = await tryAs(db, B, `INSERT INTO public.hangtag_einvoices (sale_id, status) VALUES ('kb1', 'ready')`);
  check('another shop can\'t attach one to A\'s bill (and has e-invoicing off)', !!r.err, r);
  check('shop B sees none of A\'s', (await count(db, B, 'hangtag_einvoices')) === 0 && (await count(db, B, 'hangtag_eway_bills')) === 0);
}

console.log('=== repack ===');
{
  await as(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('rin', 'rice:1', 'rice', 'RESTOCK', 10, 1)`);
  const rp = (id, fromQty, toQty, per) => tryAs(db, MA, `SELECT public.hangtag_save_repack($1::jsonb) AS r`,
    [JSON.stringify(repackArgs({ id, fromV: 'rice:1', toV: 'pack:1', fromQty, toQty, per, value: fromQty * 50, unitCost: 25, t: 1790000000000, dev: 'd1' }, []).p)]);
  const rice = await stock(db, A, 'rice:1'), packs = await stock(db, A, 'pack:1');
  let r = await rp('rp1', 2, 4, 2);
  check('2 kg of rice repacked into 4 packs of 500 g: one conversion, two stock records', !r.err && val(r).status === 'saved'
    && (await stock(db, A, 'rice:1')) === rice - 2 && (await stock(db, A, 'pack:1')) === packs + 4 && (await count(db, A, 'hangtag_repacks')) === 1, r);
  r = await rp('rp1', 2, 4, 2);
  check('the same repack again changes nothing', !r.err && val(r).status === 'already_saved' && (await stock(db, A, 'rice:1')) === rice - 2, r);
  r = await rp('rp2', 100, 200, 2);
  check('more than is in stock is refused', /in stock to repack/.test(r.err || ''), r);
  r = await rp('rp3', 1, 5, 2);
  check('what comes in reconciles with what went out (1 × 2 is not 5)', /qty_check/.test(r.err || ''), r);
  r = await tryAs(db, CA, `SELECT public.hangtag_save_repack('{"id":"rp4","from_variant":"rice:1","to_variant":"pack:1","from_qty":1,"to_qty":2,"per":2}'::jsonb)`);
  check('a cashier (no manage_inventory) can\'t repack', r.code === '42501', r);
}

console.log('=== gift vouchers ===');
{
  const issue = (who, x) => tryAs(db, who, `SELECT public.hangtag_issue_voucher($1::jsonb) AS r`, [JSON.stringify(x)]);
  const redeem = (who, code, amount, sale) => tryAs(db, who, `SELECT public.hangtag_redeem_voucher($1, $2, $3, $4, 1790000000000) AS r`, [code, amount, sale, paymentId(sale, 'voucher')]);
  let r = await issue(CA, { amount: 500, paid_method: 'cash', customer_id: 'c2', device_id: 'd1' });
  const v = val(r) && val(r).voucher;
  check('a cashier sells a ₹500 voucher: the database makes a code in the GV-XXXX-XXXX-XXXX form', !r.err && /^GV-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(v.code) && +v.balance === 500 && v.customer_name === 'Asha', r);
  const cm = await one(db, A, `SELECT type, amount::float AS a FROM public.hangtag_cash_moves WHERE id = $1`, ['gv:' + v.id]);
  check('cash paid for it is in the drawer\'s book', cm && cm.type === 'in' && cm.a === 500, cm);
  r = await issue(B, { amount: 100, paid_method: 'cash' });
  check('a shop with vouchers switched off can\'t sell one', r.code === '42501', r);
  r = await issue(A, { amount: 0, paid_method: 'cash' });
  check('a voucher is for more than ₹0', !!r.err, r);
  r = await tryAs(db, B, `SELECT public.hangtag_voucher_lookup($1) AS r`, [v.code]);
  const r2 = await redeem(B, v.code, 100, 'b-sale');
  check('another shop can\'t look the code up or spend it', !r.err && val(r).ok === false && !r2.err && val(r2).ok === false, { r, r2 });
  r = await redeem(CA, v.code, 300, 'gv1');
  check('spending ₹300 of it on a bill: ₹200 left', !r.err && val(r).ok && +val(r).balance === 200, r);
  r = await redeem(CA, v.code, 300, 'gv1');
  check('the same payment again takes nothing more', !r.err && val(r).ok && +val(r).balance === 200 && (await count(db, A, 'hangtag_voucher_redemptions')) === 1, r);
  r = await redeem(MA, v.code, 300, 'gv2');
  check('another till can\'t spend more than is left (no double spend)', !r.err && val(r).ok === false && /only ₹200 left/.test(val(r).message), r);
  r = await redeem(MA, v.code, -5, 'gv2');
  check('a negative amount is refused', !!r.err, r);
  r = await saveBills(db, CA, [bill('gv1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 1, price: 450 }], [{ method: 'voucher', amount: 300 }, { method: 'cash', amount: 150 }])]);
  const books = await rows(db, A, `SELECT method, amount::float AS a FROM public.hangtag_fin_txns WHERE sale_id = 'gv1' ORDER BY method`);
  check('the bill is saved with the voucher as a way to pay (₹150 cash in the books, the voucher part not money in)', !r.err && books.length === 1 && books[0].method === 'cash' && books[0].a === 150, { r, books });
  r = await saveBills(db, CA, [bill('gv3', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 1, price: 100 }], [{ method: 'voucher', amount: 100 }])]);
  check('a voucher payment that wasn\'t taken off a voucher is refused', /not taken off a voucher/.test(r.err || ''), r);
  r = await redeem(MA, v.code, 200, 'gv2');
  const st = await one(db, A, `SELECT status, balance::float AS b FROM public.hangtag_vouchers WHERE id = $1`, [v.id]);
  check('the rest spent on another bill: fully redeemed', !r.err && val(r).ok && st.status === 'fully_redeemed' && st.b === 0, { r, st });
  r = await tryAs(db, MA, `SELECT public.hangtag_release_voucher($1) AS r`, [paymentId('gv2', 'voucher')]);
  check('that bill was never saved: its ₹200 goes back on the voucher', !r.err && +val(r).released === 200 && (await one(db, A, `SELECT balance::float AS b FROM public.hangtag_vouchers WHERE id = $1`, [v.id])).b === 200, r);
  r = await saveBills(db, A, [bill('gv1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 1, price: 450 }], [{ method: 'voucher', amount: 300 }, { method: 'cash', amount: 150 }], { isVoid: true })]);
  let w = await one(db, A, `SELECT status, balance::float AS b FROM public.hangtag_vouchers WHERE id = $1`, [v.id]);
  check('cancelling the bill gives its ₹300 back once', !r.err && w.b === 500 && (await count(db, A, 'hangtag_voucher_redemptions', `WHERE kind = 'reverse'`)) === 1, { r, w });
  r = await saveBills(db, A, [bill('gv1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 1, price: 450 }], [{ method: 'voucher', amount: 300 }, { method: 'cash', amount: 150 }], { isVoid: true })]);
  w = await one(db, A, `SELECT balance::float AS b FROM public.hangtag_vouchers WHERE id = $1`, [v.id]);
  check('…sending the cancelled bill again gives nothing more back', !r.err && w.b === 500, { r, w });
  r = await saveBills(db, A, [bill('gv1', [{ p: 'p1', v: 'p1:M', n: 'Earbuds', q: 1, price: 450 }], [{ method: 'voucher', amount: 300 }, { method: 'cash', amount: 150 }])]);
  w = await one(db, A, `SELECT balance::float AS b FROM public.hangtag_vouchers WHERE id = $1`, [v.id]);
  check('restoring the bill takes it off the voucher again', !r.err && w.b === 200, { r, w });
  r = await tryAs(db, A, `SELECT public.hangtag_cancel_voucher($1, 'customer changed mind')`, [v.id]);
  check('a voucher that was used can\'t be cancelled', /was used/.test(r.err || ''), r);
  const v2 = val(await issue(A, { amount: 250, paid_method: 'cash' })).voucher;
  r = await tryAs(db, CA, `SELECT public.hangtag_cancel_voucher($1, 'sold by mistake')`, [v2.id]);
  check('a cashier can\'t cancel one (manage_settings)', r.code === '42501', r);
  r = await tryAs(db, A, `SELECT public.hangtag_cancel_voucher($1, 'sold by mistake') AS r`, [v2.id]);
  const back = await one(db, A, `SELECT type, amount::float AS a FROM public.hangtag_cash_moves WHERE id = $1`, ['gvx:' + v2.id]);
  check('the owner cancels an unused one with a reason; its cash goes back out of the drawer', !r.err && val(r).status === 'cancelled' && back && back.type === 'reversal' && back.a === 250, { r, back });
  r = await redeem(CA, v2.code, 10, 'gv4');
  check('a cancelled voucher can\'t be spent', !r.err && val(r).ok === false && /cancelled/.test(val(r).message), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_vouchers SET balance = 100000 WHERE id = $1`, [v.id]);
  const r3 = await tryAs(db, A, `INSERT INTO public.hangtag_voucher_redemptions (id, voucher_id, payment_id, amount, kind, t) VALUES ('x', $1, 'x:voucher', 1, 'reverse', 1)`, [v.id]);
  check('nobody changes a balance or a redemption directly (only the functions)', denied(r) && denied(r3), { r, r3 });
  check('shop B sees none of A\'s vouchers', (await count(db, B, 'hangtag_vouchers')) === 0 && (await count(db, B, 'hangtag_voucher_redemptions')) === 0);
  const au = await rows(db, A, `SELECT action FROM public.hangtag_audit_log WHERE entity = 'vouchers'`);
  check('vouchers issued and their status changes are in the audit log', au.length >= 3, au);
}

console.log('=== outbound webhooks ===');
{
  let r = await tryAs(db, A, `SELECT public.hangtag_webhook_create('https://hooks.example.com/hangtag', ARRAY['sale.completed','inventory.changed'], 'Accounts') AS r`);
  const ep = val(r) && val(r).endpoint, secret = val(r) && val(r).secret;
  check('the owner adds a webhook; its secret is shown this once', !r.err && /^whsec_[0-9a-f]{64}$/.test(secret) && ep.url === 'https://hooks.example.com/hangtag' && !('secret' in ep), r);
  r = await tryAs(db, MA, `SELECT public.hangtag_webhook_create('https://x.example.com/h', ARRAY['sale.completed'])`);
  check('a team member (even a manager) can\'t', r.code === '42501', r);
  r = await tryAs(db, A, `SELECT public.hangtag_webhook_create('http://x.example.com/h', ARRAY['sale.completed'])`);
  const r2 = await tryAs(db, A, `SELECT public.hangtag_webhook_create('https://x.example.com/h', ARRAY['sale.deleted'])`);
  check('only https addresses and known events', /check constraint/.test(r.err || '') && /check constraint/.test(r2.err || ''), { r, r2 });
  r = await tryAs(db, A, `SELECT secret FROM public.hangtag_webhook_secrets`);
  check('nobody reads the secrets from the app, not even the owner', denied(r), r);
  check('a member doesn\'t see the shop\'s webhooks', (await count(db, MA, 'hangtag_webhook_endpoints')) === 0);
  r = await saveBills(db, CA, [bill('wb1', [{ p: 'cb', v: 'cb:1', n: 'Cable', q: 1, price: 200 }], [{ method: 'cash', amount: 200 }])]);
  await saveBills(db, CA, [bill('wb1', [{ p: 'cb', v: 'cb:1', n: 'Cable', q: 1, price: 200 }], [{ method: 'cash', amount: 200 }])]);
  const evs = await rows(db, A, `SELECT type, payload FROM public.hangtag_webhook_events WHERE event_key = 'wb1'`);
  check('a bill makes one sale.completed event (the same bill uploaded again: still one), with a delivery', !r.err && evs.length === 1 && evs[0].payload.total == 200
    && (await count(db, A, 'hangtag_webhook_deliveries')) === 1, { r, evs });
  check('an event type nobody asked for isn\'t written (payment.recorded)', (await count(db, A, 'hangtag_webhook_events', `WHERE type = 'payment.recorded'`)) === 0);
  check('shop B sees none of A\'s events or deliveries', (await count(db, B, 'hangtag_webhook_events')) === 0 && (await count(db, B, 'hangtag_webhook_deliveries')) === 0);
  r = await tryAs(db, A, `SELECT * FROM public.hangtag_webhook_claim(10)`);
  check('only the dispatch function (service role) claims deliveries', denied(r), r);
  r = await trySvc(db, `SELECT * FROM public.hangtag_webhook_claim(10)`);
  const d = r.r && r.r.rows[0];
  check('…which gets the address, the secret to sign with and the event, leased once', !r.err && r.r.rows.length === 1 && d.secret === secret && d.type === 'sale.completed' && d.attempts === 1
    && (await trySvc(db, `SELECT * FROM public.hangtag_webhook_claim(10)`)).r.rows.length === 0, r);
  r = await trySvc(db, `SELECT public.hangtag_webhook_result($1, 'pending', 503, 'Service unavailable', 60)`, [d.delivery_id]);
  let row = await one(db, A, `SELECT status, last_status, attempts FROM public.hangtag_webhook_deliveries WHERE id = $1`, [d.delivery_id]);
  check('a failed attempt is logged and retried later', !r.err && row.status === 'pending' && row.last_status === 503 && row.attempts === 1, { r, row });
  await db.query(`UPDATE public.hangtag_webhook_deliveries SET next_attempt_at = now() WHERE id = $1`, [d.delivery_id]);
  const again = (await asService(db, `SELECT * FROM public.hangtag_webhook_claim(10)`)).rows[0];
  await asService(db, `SELECT public.hangtag_webhook_result($1, 'delivered', 200, NULL, NULL)`, [d.delivery_id]);
  row = await one(db, A, `SELECT d.status, d.attempts, e.last_success_at IS NOT NULL AS ok FROM public.hangtag_webhook_deliveries d JOIN public.hangtag_webhook_endpoints e ON e.id = d.endpoint_id WHERE d.id = $1`, [d.delivery_id]);
  check('the retry carries the same event id; delivered on the second attempt', again.event_id === d.event_id && row.status === 'delivered' && row.attempts === 2 && row.ok, { again, row });
  r = await tryAs(db, A, `SELECT public.hangtag_webhook_test($1) AS r`, [ep.id]);
  check('a test delivery from the owner', !r.err && (await count(db, A, 'hangtag_webhook_events', `WHERE type = 'webhook.test'`)) === 1, r);
  r = await tryAs(db, A, `SELECT public.hangtag_webhook_rotate($1) AS r`, [ep.id]);
  const now = (await db.query(`SELECT secret FROM public.hangtag_webhook_secrets WHERE endpoint_id = $1`, [ep.id])).rows[0].secret;
  check('replacing the secret shows the new one once', !r.err && val(r).secret === now && now !== secret, r);
  r = await tryAs(db, A, `SELECT public.hangtag_webhook_delete($1)`, [ep.id]);
  check('removing the webhook removes its deliveries and secret', !r.err && (await count(db, A, 'hangtag_webhook_deliveries')) === 0
    && (await db.query(`SELECT count(*)::int n FROM public.hangtag_webhook_secrets`)).rows[0].n === 0, r);
}

console.log('=== what changed (team phones poll it) ===');
{
  const r = await tryAs(db, CA, `SELECT public.hangtag_biz_changes() AS r`);
  check('a member reads the change marks of lists, POs, vouchers and GST rows', !r.err && ['lists', 'pos', 'vouchers', 'gst'].every((k) => k in val(r)), r);
  const rep = await report(db);
  check('the report is still all ok with everything above in the database', rep.length === 76 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
}

console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
