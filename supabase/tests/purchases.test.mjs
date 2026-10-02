// Section 3l of schema.sql: suppliers, purchases (rows of hangtag_stock_imports with kind 'purchase', saved with their
// stock-in records by RPC hangtag_save_purchase: all or nothing, safe to send again, create_purchase checked), cash paid
// out of the drawer posted to the cash book by the database, later payments to a supplier (never more than owed on an
// invoice; a reversal once, for the whole payment), cancelling a purchase (its stock and cash come back), purchases that
// can't be rewritten, the low-stock level per product, team members within their role, and shop A never meeting shop B.
// PGlite with Supabase stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';
import { buildPurchase, checkSupplierPayment, supplierAccount } from '../../src/domain/inventory/purchase.js';
import { purchaseArgs, rowToPurchase, rowToSupplierPayment, supplierPaymentRow, supplierRow } from '../../src/infrastructure/supabase/mappers.js';

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
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message }; } };
const rows = async (db, who, sql, params) => (await as(db, who, sql, params)).rows;
const one = async (db, who, sql, params) => (await rows(db, who, sql, params))[0];
const count = async (db, who, t, where = '') => (await one(db, who, `SELECT count(*)::int AS n FROM public.${t} ${where}`)).n;
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const rls = (r) => /row-level security/.test(r.err || '');

// ---------- a purchase made by the app's own rules and mapper ----------
function purchase(id, { sup = 'sup1', name = 'Ravi Textiles', inv = 'INV-' + id, lines, paid = 0, method = 'cash', t = 1790000000000 } = {}) {
  const b = buildPurchase({ id, supplierId: sup, supplierName: name, invoiceNo: inv, invoiceDate: '2026-09-20', paid, method, t, dev: 'd1',
    lines: lines || [{ p: 'p1', v: 'p1:M', n: 'Tee', vl: 'M', q: 10, cost: 300, gst: 5 }, { p: 'p1', v: 'p1:L', n: 'Tee', vl: 'L', q: 5, cost: 310, gst: 5 }] },
  { today: '2026-12-31', moveId: (i) => id + ':m' + i });
  if (b.error) throw new Error(b.error);
  return b;
}
const save = (db, who, b) => tryAs(db, who, `SELECT public.hangtag_save_purchase($1::jsonb, $2::jsonb, $3::jsonb) AS r`, (({ p_purchase, p_moves, p_tracking }) =>
  [JSON.stringify(p_purchase), JSON.stringify(p_moves), p_tracking == null ? null : JSON.stringify(p_tracking)])(purchaseArgs(b.purchase, b.moves)));
const cancel = (db, who, id, why, t) => tryAs(db, who, `SELECT public.hangtag_cancel_purchase($1, $2, 'd1', $3) AS r`, [id, why, t || null]);
const pay = (db, who, x) => tryAs(db, who, `INSERT INTO public.hangtag_supplier_payments (id, supplier_id, purchase_id, amount, method, reference, note, reverses, t, device_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, (r => [r.id, r.supplier_id, r.purchase_id, r.amount, r.method, r.reference, r.note, r.reverses, r.t, r.device_id])(supplierPaymentRow(x)));
const stock = async (db, who, vid) => +(await one(db, who, `SELECT COALESCE(sum(qty), 0) AS n FROM public.hangtag_stock_moves WHERE variant_id = $1`, [vid])).n;

// ---------- two shops; A's team: a cashier (no purchases), a manager (purchases + stock) ----------
const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CA = { id: uid(1), role: 'cashier', key: 'key-cashier-0001-abcdefghijklmnop', dev: 'dev-cashier-1' };
const MA = { id: uid(3), role: 'manager', key: 'key-manager-0003-abcdefghijklmnop', dev: 'dev-manager-3' };
const BU = { id: uid(4), role: 'buyer', key: 'key-buyer-000004-abcdefghijklmnop', dev: 'dev-buyer-4' };   // a custom role: create_purchase only
const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
for (const m of [CA, MA, BU]) await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [m.id, m.role + '@staff.hangtag.invalid']);
await db.exec(NEW); await db.exec(NEW);
console.log('=== schema runs twice; report ===');
{
  const rep = await report(db);
  check('migration report: 52 rows (purchases 40-44), all ok on an empty database', rep.length === 52 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'hangtag_stock_imports'`)).rows.map((r) => r.column_name);
  check('supplier bills become purchases: kind, supplier, time, money, payment, status, note and who recorded it',
    ['kind', 'supplier_id', 't', 'subtotal', 'tax_amount', 'total_amount', 'paid_amount', 'payment_method', 'status', 'note', 'user_id'].every((c) => cols.includes(c)), cols);
  const def = (await db.query(`SELECT column_default FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'owner_id' AND table_name IN ('hangtag_suppliers','hangtag_supplier_payments')`)).rows;
  check('suppliers and supplier payments fill owner_id with the shop', def.length === 2 && def.every((d) => /hangtag_shop_id/.test(d.column_default)), def);
}
for (const owner of [A, B]) {
  await as(db, owner, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Tee', 500, '{"opts":[{"name":"Size","values":["M","L"]}]}')`);
  await as(db, owner, `INSERT INTO public.hangtag_variants (id, product_id, option_values, size) VALUES ('p1:M', 'p1', '["M"]', 'M'), ('p1:L', 'p1', '["L"]', 'L')`);
}
await as(db, A, `INSERT INTO public.hangtag_roles (role, permissions) VALUES ('buyer', ARRAY['view_products','create_purchase'])`);
for (const m of [CA, MA, BU]) {
  await asService(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, created_by) VALUES ($1, $2, $3, $4, $5, $2)`, [m.id, A, 'Staff ' + m.role, m.role + '1', m.role]);
  await asService(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, key_hash) VALUES ($1, $2, $3, 'Phone', $4)`, [A, m.dev, m.id, hash(m.key)]);
}

console.log('=== suppliers ===');
{
  let r = await tryAs(db, A, `INSERT INTO public.hangtag_suppliers (id, name, phone, gstin, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING owner_id::text AS o`,
    (s => [s.id, s.name, s.phone, s.gstin, s.created_at, s.updated_at])(supplierRow({ id: 'sup1', name: 'Ravi Textiles', phone: '9876543210', gstin: '27ABCDE1234F1Z5' })));
  check('the owner adds a supplier (owner_id = the shop)', !r.err && r.r.rows[0].o === A, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_suppliers (id, name, gstin) VALUES ('sup-bad', 'X', 'not-a-gstin')`);
  check('a GSTIN must look like one', /gstin_check|check constraint/.test(r.err || ''), r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_suppliers (id, name) VALUES ('sup-blank', '   ')`);
  check('a supplier needs a name', /check constraint/.test(r.err || ''), r);
  await as(db, B, `INSERT INTO public.hangtag_suppliers (id, name) VALUES ('sup1', 'B''s own supplier')`);
  check('shop B can have a supplier with the same id; each shop sees only its own', (await count(db, A, 'hangtag_suppliers')) === 1 && (await one(db, B, `SELECT name FROM public.hangtag_suppliers`)).name === "B's own supplier");
  check('a cashier (no purchases, stock or reports) sees no suppliers', (await count(db, CA, 'hangtag_suppliers')) === 0);
  r = await tryAs(db, CA, `INSERT INTO public.hangtag_suppliers (id, name) VALUES ('sup-ca', 'Cashier supplier')`);
  check('…and can\'t add one', rls(r), r);
  r = await tryAs(db, MA, `INSERT INTO public.hangtag_suppliers (id, name) VALUES ('sup2', 'Mill Co') RETURNING owner_id::text AS o`);
  check('a manager adds one to the shop (owner_id = the shop)', !r.err && r.r.rows[0].o === A && (await count(db, MA, 'hangtag_suppliers')) === 2, r);
  r = await tryAs(db, MA, `UPDATE public.hangtag_suppliers SET active = FALSE, updated_at = now() WHERE id = 'sup2' RETURNING id`);
  check('…and switches it off (suppliers are kept, never deleted)', !r.err && r.r.rows.length === 1, r);
  r = await tryAs(db, A, `DELETE FROM public.hangtag_suppliers WHERE id = 'sup2'`);
  check('nobody deletes a supplier (it keeps its purchases and payments)', /permission denied/.test(r.err || ''), r);
  const au = await one(db, A, `SELECT count(*)::int AS n FROM public.hangtag_audit_log WHERE entity = 'suppliers'`);
  check('suppliers added and changed are in the audit log', au.n >= 3, au);
}

console.log('=== saving a purchase: all or nothing, once ===');
{
  const P1 = purchase('pur1', { paid: 500, method: 'cash' });
  let r = await save(db, A, P1);
  check('the owner saves a purchase', !r.err && r.r.rows[0].r.status === 'saved' && r.r.rows[0].r.moves === 2, r);
  const row = await one(db, A, `SELECT * FROM public.hangtag_stock_imports WHERE id = 'pur1'`);
  const back = rowToPurchase(row);
  check('…as a purchase row: supplier, invoice, money that adds up, paid part, posted, who recorded it',
    row.kind === 'purchase' && row.supplier_id === 'sup1' && row.invoice_no === 'INV-pur1' && +row.subtotal === 4550 && +row.tax_amount === 227.5 && +row.total_amount === 4777.5
    && +row.paid_amount === 500 && row.payment_method === 'cash' && row.status === 'posted' && row.user_id === A && +row.units === 15 && row.line_count === 2, row);
  check('…and reads back as the app wrote it', back.total === P1.purchase.total && back.lines.length === 2 && back.lines[1].cost === 310 && back.supplierId === 'sup1' && back.status === 'posted', back);
  const mv = await rows(db, A, `SELECT id, type, qty, cost_price, import_id, note FROM public.hangtag_stock_moves WHERE import_id = 'pur1' ORDER BY id`);
  check('its stock comes in as stock-in records pointing at it, with the cost per piece', mv.length === 2 && mv.every((m) => m.type === 'RESTOCK' && m.import_id === 'pur1') && +mv[0].qty === 10 && mv[0].cost_price === 300 && /Purchase INV-pur1/.test(mv[0].note), mv);
  check('stock on hand is the sum of the records (never a stored number)', (await stock(db, A, 'p1:M')) === 10 && (await stock(db, A, 'p1:L')) === 5);
  const cm = await one(db, A, `SELECT type, amount, reason FROM public.hangtag_cash_moves WHERE id = 'pur:pur1'`);
  check('cash paid out of the drawer is a "Cash out" cash book entry (added by the database)', cm && cm.type === 'out' && +cm.amount === 500 && /Paid supplier Ravi Textiles · INV-pur1/.test(cm.reason), cm);
  r = await save(db, A, P1);
  check('sending it again is a safe retry: nothing changes', !r.err && r.r.rows[0].r.status === 'already_saved' && (await count(db, A, 'hangtag_stock_moves', `WHERE import_id = 'pur1'`)) === 2
    && (await count(db, A, 'hangtag_cash_moves', `WHERE id LIKE 'pur:%'`)) === 1, r);
  // all or nothing
  const bad = purchase('pur-bad', { lines: [{ p: 'p1', v: 'p1:M', n: 'Tee', q: 1, cost: 10, gst: 0 }, { p: 'p9', v: 'p9:X', n: 'Ghost', q: 1, cost: 10, gst: 0 }] });
  r = await save(db, A, bad);
  check('a line for a product the shop doesn\'t have: refused, and nothing of it is saved', !!r.err && (await count(db, A, 'hangtag_stock_imports', `WHERE id = 'pur-bad'`)) === 0
    && (await count(db, A, 'hangtag_stock_moves', `WHERE import_id = 'pur-bad'`)) === 0, r);
  const P2 = purchase('pur2');
  const args = purchaseArgs(P2.purchase, P2.moves);
  args.p_purchase.subtotal = 1;
  r = await tryAs(db, A, `SELECT public.hangtag_save_purchase($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(args.p_purchase), JSON.stringify(args.p_moves)]);
  check('lines that don\'t add up to the totals are refused', /don't add up/.test(r.err || ''), r);
  const a2 = purchaseArgs(P2.purchase, P2.moves); a2.p_moves = a2.p_moves.slice(0, 1);
  r = await tryAs(db, A, `SELECT public.hangtag_save_purchase($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a2.p_purchase), JSON.stringify(a2.p_moves)]);
  check('stock-in records that don\'t match the lines are refused', /don't match/.test(r.err || ''), r);
  const a3 = purchaseArgs(P2.purchase, P2.moves); a3.p_purchase.paid_amount = 99999;
  r = await tryAs(db, A, `SELECT public.hangtag_save_purchase($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a3.p_purchase), JSON.stringify(a3.p_moves)]);
  check('paying more than the total is refused', /money_check|check constraint/.test(r.err || ''), r);
  const a4 = purchaseArgs(P2.purchase, P2.moves); a4.p_moves[0].qty = 0; a4.p_moves[1].qty = 15;
  r = await tryAs(db, A, `SELECT public.hangtag_save_purchase($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a4.p_purchase), JSON.stringify(a4.p_moves)]);
  check('a stock-in record of 0 pieces is refused', /quantity more than 0/.test(r.err || ''), r);
  check('none of those left anything behind', (await count(db, A, 'hangtag_stock_imports', `WHERE id = 'pur2'`)) === 0 && (await count(db, A, 'hangtag_stock_moves', `WHERE import_id = 'pur2'`)) === 0);
  r = await tryAs(db, null, `SELECT public.hangtag_save_purchase('{}'::jsonb, '[]'::jsonb) AS r`);
  check('signed-out visitors can\'t call it', /permission denied/.test(r.err || ''), r);
  // a purchase is history
  r = await tryAs(db, A, `UPDATE public.hangtag_stock_imports SET total_amount = 1, subtotal = 1, tax_amount = 0 WHERE id = 'pur1'`);
  check('nobody rewrites a saved purchase (not even the owner)', /can't be changed/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_stock_imports SET status = 'cancelled', cancel_reason = 'typo', cancelled_at = now() WHERE id = 'pur1'`);
  check('…nor marks it cancelled without taking its stock back', /Cancel purchase/.test(r.err || ''), r);
  r = await tryAs(db, A, `DELETE FROM public.hangtag_stock_imports WHERE id = 'pur1'`);
  check('…nor removes it', /can't be removed/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_stock_imports SET total_amount = total_amount WHERE id = 'pur1' RETURNING id`);
  check('the same row again (an upload sent twice) is fine', !r.err, r);
}

console.log('=== team members: within their role ===');
{
  let r = await save(db, CA, purchase('pur-ca'));
  check('a cashier can\'t record purchases', /Not allowed to record purchases/.test(r.err || ''), r);
  r = await save(db, BU, purchase('pur-bu', { sup: 'sup1' }));
  const row = await one(db, A, `SELECT user_id::text AS u, owner_id::text AS o FROM public.hangtag_stock_imports WHERE id = 'pur-bu'`);
  check('a role with create_purchase only records one for the shop, named as the one who did', !r.err && row && row.o === A && row.u === BU.id, { r, row });
  r = await save(db, { id: BU.id, key: null }, purchase('pur-bu2'));
  check('…but not from a phone that isn\'t its enrolled device', /Not allowed/.test(r.err || ''), r);
  check('stock records of the purchase went in (the buyer may add stock records)', (await count(db, A, 'hangtag_stock_moves', `WHERE import_id = 'pur-bu'`)) === 2);
  r = await cancel(db, BU, 'pur-bu', 'Wrong supplier');
  check('cancelling needs stock adjustments too (manage_inventory): the buyer can\'t', /Not allowed to cancel/.test(r.err || ''), r);
  r = await save(db, MA, purchase('pur-ma', { sup: 'sup2', paid: 100, method: 'upi', lines: [{ p: 'p1', v: 'p1:M', n: 'Tee', q: 2, cost: 250, gst: 0 }] }));
  check('a manager records a purchase (paid by UPI: no cash book entry)', !r.err && (await count(db, A, 'hangtag_cash_moves', `WHERE id = 'pur:pur-ma'`)) === 0, r);
}

console.log('=== paying suppliers later ===');
{
  const P3 = purchase('pur3', { lines: [{ p: 'p1', v: 'p1:M', n: 'Tee', q: 4, cost: 250, gst: 5 }] });   // 1050, nothing paid
  await save(db, A, P3);
  let r = await pay(db, A, { id: 'sp1', supplierId: 'sup1', purchaseId: 'pur3', amount: 600, method: 'cash', ref: '', note: '', t: 1790000100000, dev: 'd1' });
  check('the owner pays part of an invoice later', !r.err, r);
  const cm = await one(db, A, `SELECT type, amount, reason FROM public.hangtag_cash_moves WHERE id = 'spay:sp1'`);
  check('…in cash: a "Cash out" entry in the cash book', cm && cm.type === 'out' && +cm.amount === 600 && /Paid supplier Ravi Textiles/.test(cm.reason), cm);
  r = await pay(db, A, { id: 'sp2', supplierId: 'sup1', purchaseId: 'pur3', amount: 500, method: 'upi', t: 1790000100001, dev: 'd1' });
  check('more than is still owed on the invoice is refused', /more than is still owed/.test(r.err || ''), r);
  r = await pay(db, A, { id: 'sp3', supplierId: 'sup2', purchaseId: 'pur3', amount: 10, method: 'upi', t: 1790000100002, dev: 'd1' });
  check('a payment for another supplier\'s invoice is refused', /not one from this supplier/.test(r.err || ''), r);
  r = await pay(db, A, { id: 'sp4', supplierId: 'sup1', amount: 1000, method: 'bank', ref: 'NEFT 123', t: 1790000100003, dev: 'd1' });
  check('a payment on account (no invoice) is fine', !r.err, r);
  r = await pay(db, A, { id: 'sp1x', supplierId: 'sup1', purchaseId: 'pur3', amount: 600, method: 'cash', note: 'x', reverses: 'sp1', t: 1790000100004, dev: 'd1' });
  check('a reversal needs a reason', /Say why/.test(r.err || ''), r);
  r = await pay(db, A, { id: 'sp1x', supplierId: 'sup1', purchaseId: 'pur3', amount: 60, method: 'cash', note: 'Paid twice', reverses: 'sp1', t: 1790000100004, dev: 'd1' });
  check('a reversal is for the whole payment', /whole of a payment/.test(r.err || ''), r);
  r = await pay(db, A, { id: 'sp1x', supplierId: 'sup1', purchaseId: 'pur3', amount: 600, method: 'cash', note: 'Paid twice by mistake', reverses: 'sp1', t: 1790000100004, dev: 'd1' });
  const rv = await one(db, A, `SELECT type, amount, reverses FROM public.hangtag_cash_moves WHERE id = 'spay:sp1x'`);
  check('reversing a cash payment puts the cash back in the book', !r.err && rv && rv.type === 'reversal' && rv.reverses === 'spay:sp1' && +rv.amount === 600, { r, rv });
  r = await pay(db, A, { id: 'sp1y', supplierId: 'sup1', purchaseId: 'pur3', amount: 600, method: 'cash', note: 'Again', reverses: 'sp1', t: 1790000100005, dev: 'd1' });
  check('…only once', /duplicate|unique/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_supplier_payments SET amount = 1 WHERE id = 'sp4'`);
  check('payments are never changed', /permission denied/.test(r.err || ''), r);
  r = await pay(db, CA, { id: 'sp-ca', supplierId: 'sup1', amount: 10, method: 'upi', t: 1, dev: 'd1' });
  check('a cashier can\'t pay suppliers', rls(r), r);
  const u = await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_supplier_payments WHERE id = 'sp4'`);
  check('the database says who recorded a payment', u.u === A, u);
  // the app's account of the supplier agrees with the database
  const ps = (await rows(db, A, `SELECT * FROM public.hangtag_stock_imports WHERE kind = 'purchase'`)).map(rowToPurchase);
  const xs = (await rows(db, A, `SELECT * FROM public.hangtag_supplier_payments`)).map(rowToSupplierPayment);
  const acc = supplierAccount('sup1', ps, xs);
  const due3 = checkSupplierPayment({ supplierId: 'sup1', purchaseId: 'pur3', amount: 1051, method: 'upi' }, { purchase: ps.find((p) => p.id === 'pur3'), payments: xs });
  check('the supplier\'s account from the saved rows: total, paid, outstanding', acc.total === 4777.5 * 2 + 1050 && acc.paid === 500 + 1000 && acc.outstanding === acc.total - 1500 && /1,050/.test(due3.error || ''), { acc, due3 });
}

console.log('=== cancelling a purchase ===');
{
  const before = await stock(db, A, 'p1:M');
  let r = await cancel(db, CA, 'pur1', 'Wrong delivery');
  check('a cashier can\'t cancel a purchase', /Not allowed to cancel/.test(r.err || ''), r);
  r = await cancel(db, A, 'pur1', 'no');
  check('…the owner needs to say why', /Say why/.test(r.err || ''), r);
  r = await cancel(db, A, 'pur1', 'Wrong delivery, sent back', 1790000200000);
  const row = await one(db, A, `SELECT status, cancel_reason FROM public.hangtag_stock_imports WHERE id = 'pur1'`);
  const back = await rows(db, A, `SELECT id, type, qty, t FROM public.hangtag_stock_moves WHERE import_id = 'pur1' AND type = 'ADJUST' ORDER BY id`);
  check('the owner cancels it: marked cancelled with the reason', !r.err && row.status === 'cancelled' && row.cancel_reason === 'Wrong delivery, sent back', { r, row });
  check('…its stock leaves again (one opposite adjustment per stock-in record, pcx:<record>)', back.length === 2 && back[0].id === 'pcx:pur1:m0' && +back[0].qty === -10 && +back[0].t === 1790000200000
    && (await stock(db, A, 'p1:M')) === before - 10, back);
  const cx = await one(db, A, `SELECT type, amount, reverses FROM public.hangtag_cash_moves WHERE id = 'purx:pur1'`);
  check('…and the cash paid comes back into the drawer', cx && cx.type === 'reversal' && cx.reverses === 'pur:pur1' && +cx.amount === 500, cx);
  r = await cancel(db, A, 'pur1', 'Wrong delivery, sent back');
  check('cancelling again changes nothing', !r.err && r.r.rows[0].r.status === 'already_cancelled' && (await count(db, A, 'hangtag_stock_moves', `WHERE import_id = 'pur1' AND type = 'ADJUST'`)) === 2, r);
  r = await pay(db, A, { id: 'sp9', supplierId: 'sup1', purchaseId: 'pur1', amount: 10, method: 'upi', t: 1, dev: 'd1' });
  check('nothing can be paid on a cancelled purchase', /cancelled/.test(r.err || ''), r);
  const au = await rows(db, A, `SELECT action, entity FROM public.hangtag_audit_log WHERE entity = 'stock_imports' AND entity_id = 'pur1'`);
  check('the cancel is in the audit log (and each stock adjustment)', au.some((x) => x.action === 'update') && (await count(db, A, 'hangtag_audit_log', `WHERE entity = 'stock_moves' AND entity_id LIKE 'pcx:pur1%'`)) === 2, au);
  r = await cancel(db, MA, 'pur-ma', 'Returned to the mill');
  check('a manager (purchases + stock) can cancel', !r.err && r.r.rows[0].r.status === 'cancelled', r);
  r = await cancel(db, B, 'pur1', 'Not mine');
  check('another shop can\'t cancel it (it isn\'t there for them)', /isn't in the cloud/.test(r.err || ''), r);
}

console.log('=== shop A and shop B ===');
{
  let r = await save(db, B, purchase('pur1', { sup: 'sup1', name: 'B supplier', paid: 100 }));
  check('shop B saves a purchase with the same id: its own', !r.err && r.r.rows[0].r.status === 'saved', r);
  check('each shop sees only its own purchases, payments and supplier cash', (await count(db, B, 'hangtag_stock_imports', `WHERE kind = 'purchase'`)) === 1
    && (await count(db, B, 'hangtag_supplier_payments')) === 0 && (await count(db, B, 'hangtag_cash_moves', `WHERE owner_id = '${A}'`)) === 0
    && (await one(db, A, `SELECT status FROM public.hangtag_stock_imports WHERE id = 'pur1'`)).status === 'cancelled');
  r = await save(db, B, purchase('pur-b2', { sup: 'sup2' }));
  check('B can\'t buy from A\'s supplier (it doesn\'t exist for B)', /foreign key|supplier_fkey/.test(r.err || ''), r);
  r = await pay(db, B, { id: 'sp-b', supplierId: 'sup1', purchaseId: 'pur3', amount: 1, method: 'upi', t: 1, dev: 'd1' });
  check('B can\'t pay against A\'s invoice', !!r.err, r);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_suppliers (owner_id, id, name) VALUES ($1, 'sneak', 'X')`, [A]);
  check('B can\'t write into A\'s suppliers, even naming A', rls(r), r);
  const c1 = await one(db, A, `SELECT public.hangtag_purchase_changes() AS c`);
  await save(db, A, purchase('pur4', { lines: [{ p: 'p1', v: 'p1:L', n: 'Tee', q: 1, cost: 100, gst: 0 }], paid: 100, method: 'upi' }));
  const c2 = await one(db, A, `SELECT public.hangtag_purchase_changes() AS c`), cB = await one(db, B, `SELECT public.hangtag_purchase_changes() AS c`);
  check('a purchase changes the shop\'s purchase fingerprint (for team phones), not another shop\'s', c1.c !== c2.c && cB.c !== c2.c, { c1, c2, cB });
}

console.log('=== low-stock level per product ===');
{
  let r = await tryAs(db, A, `UPDATE public.hangtag_products SET low_stock = 4 WHERE id = 'p1' RETURNING low_stock`);
  check('a product keeps its own low-stock level', !r.err && r.r.rows[0].low_stock === 4, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_products SET low_stock = -1 WHERE id = 'p1'`);
  check('…never below 0', /low_stock_check|check constraint/.test(r.err || ''), r);
}

console.log('=== report and account removal ===');
{
  const rep = await report(db);
  check('migration report: every row ok with purchases, payments, reversals and cancels in it', rep.length === 52 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  const r40 = rep.find((r) => /lines add up to their total/.test(r.check_name));
  check('…the purchase rows count what they should', r40 && +r40.value === 6 && +r40.expected === 6, r40);
  await db.query(`DELETE FROM auth.users WHERE id = $1`, [B]);
  check('removing shop B\'s account removes its suppliers and purchases with it', (await db.query(`SELECT count(*)::int AS n FROM public.hangtag_stock_imports WHERE owner_id = $1`, [B])).rows[0].n === 0
    && (await db.query(`SELECT count(*)::int AS n FROM public.hangtag_suppliers WHERE owner_id = $1`, [B])).rows[0].n === 0);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
