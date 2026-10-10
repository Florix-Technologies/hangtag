// Serial numbers, batches and expiry (schema.sql section 3n): the schema runs twice and the report's rows 50-55 are ok;
// a purchase brings serials into the register and a batch (with its expiry date) into the batches; a bill sells a serial
// (SOLD), the same serial on a second bill is refused, cancelling the bill puts it back and restoring sells it again; a
// return brings it back (RETURNED) or writes it off (not for resale); a cancelled purchase takes its serials and batch
// back — refused while one is sold; a bill takes from its batches, a return puts back into them, an adjustment can't take a
// batch below zero, a batch keeps one expiry date; saved serials and batches never change; audit rows; a cashier reads the
// register but nobody writes it directly; shop B never sees shop A's. PGlite with Supabase stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { quoteReturn } from '../../src/domain/returns/return-value.js';
import { buildPurchase } from '../../src/domain/inventory/purchase.js';
import { billArgs, moveRow, purchaseArgs, returnArgs } from '../../src/infrastructure/supabase/mappers.js';

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
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');

const PH = { p: 'ph', v: 'ph:', n: 'Phone', price: 9000 }, RICE = { p: 'rice', v: 'rice:', n: 'Rice', price: 60, u: 'kg' };
/* A bill as the app makes it: lines [{ ...product, q, sn?, bt? }] */
function bill(id, lines, { t = 1790000000000 } = {}) {
  const T = computeCheckout({ lines: lines.map((l) => ({ q: l.q, price: l.price, rate: 0 })), billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, [{ method: 'cash', amount: T.total }]);
  return { id, no: 'INV-' + id, t, dev: 'dev-a', kind: 'sale', ex: null, credit: 0, cust: null,
    items: lines.map((l, k) => { const L = T.lines[k]; return { ln: k, p: l.p, v: l.v, n: l.n, c: '', s: '', vl: '', ov: [], sku: '', q: l.q, ...(l.u ? { u: l.u } : {}), price: l.price, cost: null,
      dAmt: 0, bdAmt: 0, gst: 0, hsn: '', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total, ...(l.sn ? { sn: l.sn } : {}), ...(l.bt ? { bt: l.bt } : {}) }; }),
    sub: T.sub, disc: T.disc, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'cash', payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
/* A return of picks { ln: q } with each line's serials / batches { ln: { sn?, bt? } } */
function ret(id, sale, picks, track = {}, restock = true) {
  const Q = quoteReturn(sale, picks, []);
  if (Q.error) throw new Error(Q.error);
  return { id, no: 'CN-' + id, sale: sale.id, t: sale.t + 5000, kind: 'return', ex: null, refund: Q.value, pay: 'cash', value: Q.value, ro: Q.roundOff, note: '', dev: 'dev-a',
    items: Q.lines.map((L) => { const i = sale.items.find((x) => x.ln === L.ln); return { ln: L.ln, v: i.v, p: i.p, n: i.n, c: '', s: '', vl: '', ov: [], sku: '', q: L.q, price: L.unit, value: L.value,
      cost: null, restock, tx: L.tx, cgst: L.cgst, sgst: L.sgst, igst: L.igst, gst: L.rate, hsn: L.hsn, ...(i.u ? { u: i.u } : {}), ...(track[L.ln] || {}) }; }) };
}
const saveBill = (db, who, b) => tryAs(db, who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([billArgs(b)])]);
const saveRet = (db, who, r) => { const a = returnArgs(r); return tryAs(db, who, `SELECT public.hangtag_save_return($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a.p_return), JSON.stringify(a.p_items)]); };
const trk = { 'ph:': { tracking: 'serial' }, 'rice:': { tracking: 'batch', expiry: true } };
function purchase(id, lines) {
  const b = buildPurchase({ id, supplierId: 'sup1', supplierName: 'Ravi Traders', invoiceNo: 'INV-' + id, t: 1789990000000, dev: 'dev-a', lines, paid: '0' }, { today: '2026-09-30', trackingOf: (l) => trk[l.v] || null, moveId: (i) => id + ':m' + i });
  if (b.error) throw new Error(b.error);
  return b;
}
const savePurchase = (db, who, b) => tryAs(db, who, `SELECT public.hangtag_save_purchase($1::jsonb, $2::jsonb, $3::jsonb) AS r`, (({ p_purchase, p_moves, p_tracking }) =>
  [JSON.stringify(p_purchase), JSON.stringify(p_moves), p_tracking == null ? null : JSON.stringify(p_tracking)])(purchaseArgs(b.purchase, b.moves)));
const saveMove = (db, who, m) => tryAs(db, who, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id, serials, batch_no, expiry)
  SELECT id, variant_id, product_id, type, qty, cost_price, note, t, device_id, import_id, serials, batch_no, expiry FROM jsonb_populate_record(NULL::public.hangtag_stock_moves, $1::jsonb) RETURNING id`, [JSON.stringify(moveRow(m))]);
const serial = async (who, s) => one(db, who, `SELECT status, sale_id, return_id, move_id, import_id, variant_id FROM public.hangtag_serials WHERE serial = $1`, [s]);
const left = async (b) => +(await db.query(`SELECT public.hangtag_batch_left($1, 'rice:', $2) AS n`, [A, b])).rows[0].n;

const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CA = { id: uid(1), key: 'key-cashier-0001-abcdefghijklmnop', dev: 'dev-cashier-1' };
const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in'),($3,'c@staff.hangtag.invalid')`, [A, B, CA.id]);
await db.exec(NEW); await db.exec(NEW);
await asService(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1, $2, 'Cashier', 'cash1', 'cashier', 'active', $2)`, [CA.id, A]);
await asService(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Counter', 'Android', $4)`, [A, CA.dev, CA.id, hash(CA.key)]);
for (const o of [A, B]) {
  await as(db, o, `INSERT INTO public.hangtag_products (id, name, price, tracking, unit, tracks_expiry, options) VALUES ('ph', 'Phone', 9000, 'serial', 'pcs', false, '{"opts":[]}'), ('rice', 'Rice', 60, 'batch', 'kg', true, '{"opts":[]}')`);
  await as(db, o, `INSERT INTO public.hangtag_suppliers (id, name) VALUES ('sup1', 'Ravi Traders')`);
  await as(db, o, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('ph:', 'ph', '[]'), ('rice:', 'rice', '[]')`);
}

console.log('=== the schema runs twice; the report ===');
{
  const rep = await report(db);
  check('migration report: 76 rows (50-55: serials and batches), all ok on an empty shop', rep.length === 76 && rep.every((r) => r.ok) && rep.filter((r) => /^(Serial|Stock records with serial|Bill lines with serial|Batches never|Bill lines taking from batches)/.test(r.check_name)).length === 6, rep.filter((r) => !r.ok));
  const cols = (await db.query(`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'
      AND column_name IN ('serials', 'batches', 'batch_no', 'expiry', 'tracks_expiry') AND table_name IN ('hangtag_stock_moves', 'hangtag_sale_items', 'hangtag_return_items', 'hangtag_products') ORDER BY 1`)).rows.map((r) => r.c);
  check('stock records, bill lines and return lines carry serials / batches; products tracks_expiry', cols.length === 8, cols);
}

console.log('=== serials: purchase → bill → cancel → restore → return ===');
const pu = purchase('pu1', [{ p: 'ph', v: 'ph:', n: 'Phone', q: '3', cost: '8000', serials: ['sn001', 'SN002', 'SN003'] }, { p: 'rice', v: 'rice:', n: 'Rice', q: '10', dec: 3, cost: '45', batch: { no: 'b1', exp: '2026-12-31' } }]);
let r = await savePurchase(db, A, pu);
check('a purchase of 3 phones (serials) and 10 kg of rice (batch B1, expiry 2026-12-31) is saved', !r.err, r);
let s1 = await serial(A, 'SN001');
check('the serials are in the register: in stock, from that purchase and its stock-in record', s1 && s1.status === 'IN_STOCK' && s1.import_id === 'pu1' && s1.move_id === 'pu1:m0'
  && (await one(db, A, `SELECT count(*)::int n FROM public.hangtag_serials`)).n === 3, s1);
const bt = await one(db, A, `SELECT batch_no, expiry::text AS e, import_id FROM public.hangtag_batches WHERE variant_id = 'rice:'`);
check('the batch is created with its expiry and purchase; its stock is 10', bt && bt.batch_no === 'B1' && bt.e === '2026-12-31' && bt.import_id === 'pu1' && await left('B1') === 10, bt);
r = await savePurchase(db, A, purchase('pu2', [{ p: 'ph', v: 'ph:', n: 'Phone', q: '1', cost: '8000', serials: ['SN002'] }]));
check('a serial already in stock can\'t come in again (the whole purchase is refused)', /already in stock/.test(r.err || '') && !(await one(db, A, `SELECT 1 AS x FROM public.hangtag_stock_imports WHERE id = 'pu2'`)), r);
const b1 = bill('b1', [{ ...PH, q: 1, sn: ['SN002'] }]);
r = await saveBill(db, A, b1);
s1 = await serial(A, 'SN002');
check('a bill sells SN002: SOLD, on that bill', !r.err && s1.status === 'SOLD' && s1.sale_id === 'b1', { r, s1 });
r = await saveBill(db, A, b1);
check('the same bill sent again changes nothing', !r.err && (await serial(A, 'SN002')).sale_id === 'b1', r);
r = await saveBill(db, A, bill('b2', [{ ...PH, q: 1, sn: ['SN002'] }]));
check('another bill with SN002 is refused (a serial can\'t be sold twice) and saves nothing', /already sold/.test(r.err || '') && !(await one(db, A, `SELECT 1 AS x FROM public.hangtag_sales WHERE id = 'b2'`)), r);
r = await saveBill(db, CA, bill('b3', [{ ...PH, q: 2, sn: ['SN002', 'SN003'] }]));
check('…also from a cashier\'s phone', /already sold/.test(r.err || ''), r);
r = await saveBill(db, A, bill('b4', [{ ...PH, q: 2, sn: ['SN003'] }]));
check('a line with fewer serials than pieces is refused', /one serial number per piece/.test(r.err || ''), r);
r = await tryAs(db, A, `UPDATE public.hangtag_sale_items SET serials = ARRAY['SN003'] WHERE sale_id = 'b1'`);
check('a saved line\'s serials never change', /don't change/.test(r.err || ''), r);
await as(db, A, `UPDATE public.hangtag_sales SET is_void = true, void_reason = 'Wrong item' WHERE id = 'b1'`);
check('the bill cancelled: SN002 is back in stock', (await serial(A, 'SN002')).status === 'IN_STOCK');
const b5 = bill('b5', [{ ...PH, q: 1, sn: ['SN002'] }]);
r = await saveBill(db, A, b5);
check('…so another bill can sell it', !r.err && (await serial(A, 'SN002')).sale_id === 'b5', r);
r = await tryAs(db, A, `UPDATE public.hangtag_sales SET is_void = false, void_reason = NULL WHERE id = 'b1'`);
check('restoring the cancelled bill is refused: its serial was sold again', /can't be restored/.test(r.err || '') && (await one(db, A, `SELECT is_void FROM public.hangtag_sales WHERE id = 'b1'`)).is_void === true, r);
const b6 = bill('b6', [{ ...PH, q: 1, sn: ['SN001'] }]);
await saveBill(db, A, b6);
await as(db, A, `UPDATE public.hangtag_sales SET is_void = true WHERE id = 'b6'`);
r = await tryAs(db, A, `UPDATE public.hangtag_sales SET is_void = false WHERE id = 'b6'`);
check('a cancelled bill whose serial is still free is restored: SOLD again', !r.err && (await serial(A, 'SN001')).status === 'SOLD' && (await serial(A, 'SN001')).sale_id === 'b6', r);
r = await saveRet(db, A, ret('r1', b6, { 0: 1 }, { 0: { sn: ['SN001'] } }));
s1 = await serial(A, 'SN001');
check('a return brings SN001 back: RETURNED (ready to sell), with its return', !r.err && s1.status === 'RETURNED' && s1.return_id === 'r1', { r, s1 });
r = await saveRet(db, A, ret('r2', b6, { 0: 1 }, { 0: { sn: ['SN001'] } }));
check('it can\'t come back twice', !!r.err, r);
r = await saveRet(db, A, ret('r3', b5, { 0: 1 }, { 0: { sn: ['SN003'] } }));
check('a return of a serial that wasn\'t on that bill line is refused', /wasn't sold on that bill line/.test(r.err || ''), r);
r = await saveBill(db, A, bill('b7', [{ ...PH, q: 1, sn: ['SN001'] }]));
check('a returned serial can be sold again', !r.err && (await serial(A, 'SN001')).status === 'SOLD', r);
r = await saveRet(db, A, ret('r4', b5, { 0: 1 }, { 0: { sn: ['SN002'] } }, false));
check('a return not for resale writes the serial off (DAMAGED)', !r.err && (await serial(A, 'SN002')).status === 'DAMAGED', r);
r = await tryAs(db, A, `SELECT public.hangtag_cancel_purchase('pu1', 'Wrong supplier', 'dev-a', 1790000100000) AS r`);
check('the purchase can\'t be cancelled while its serials are sold or written off (nothing changes)', /isn't in stock/.test(r.err || '')
  && (await one(db, A, `SELECT status FROM public.hangtag_stock_imports WHERE id = 'pu1'`)).status === 'posted', r);
r = await saveMove(db, A, { id: 'w1', v: 'ph:', p: 'ph', type: 'ADJUST', q: -1, t: 1790000200000, note: 'Damaged', sn: ['SN003'] });
check('a stock adjustment writes SN003 off (DAMAGED)', !r.err && (await serial(A, 'SN003')).status === 'DAMAGED', r);
r = await saveMove(db, A, { id: 'f1', v: 'ph:', p: 'ph', type: 'ADJUST', q: 1, t: 1790000300000, note: 'Found', sn: ['SN003'] });
check('found again: back in stock', !r.err && (await serial(A, 'SN003')).status === 'IN_STOCK', r);
const stock = +(await one(db, A, `SELECT sum(qty) AS n FROM public.hangtag_stock_moves WHERE variant_id = 'ph:'`)).n;
check('the register agrees with the stock records (3 in − 1 written off + 1 found = 3 recorded)', stock === 3, stock);

console.log('=== batches: bill, return, adjustment, expiry ===');
const b8 = bill('b8', [{ ...RICE, q: 2.5, bt: [{ b: 'B1', q: 2.5 }] }]);
r = await saveBill(db, A, b8);
check('a bill takes 2.5 kg from B1: 7.5 left', !r.err && await left('B1') === 7.5, r);
r = await saveBill(db, A, bill('b9', [{ ...RICE, q: 2, bt: [{ b: 'B1', q: 1 }] }]));
check('a line whose batches don\'t add up to its quantity is refused', /come to 1 but the line has 2/.test(r.err || ''), r);
r = await saveRet(db, A, ret('r5', b8, { 0: 1 }, { 0: { bt: [{ b: 'B1', q: 1 }] } }));
check('a return of 1 kg goes back into B1: 8.5', !r.err && await left('B1') === 8.5, r);
r = await saveRet(db, A, ret('r6', b8, { 0: 1.5 }, { 0: { bt: [{ b: 'B9', q: 1.5 }] } }));
check('a return into a batch the line didn\'t take from is refused', /would come back/.test(r.err || ''), r);
r = await saveMove(db, A, { id: 'a1', v: 'rice:', p: 'rice', type: 'ADJUST', q: -9, t: 1790000400000, note: 'Stock count: Expired', b: 'B1' });
check('an adjustment can\'t take a batch below zero', /has only 8.5 left/.test(r.err || ''), r);
r = await saveMove(db, A, { id: 'a2', v: 'rice:', p: 'rice', type: 'ADJUST', q: -0.5, t: 1790000400000, note: 'Stock count: Damaged', b: 'B1' });
check('…but can take what is there: 8', !r.err && await left('B1') === 8, r);
r = await saveMove(db, A, { id: 'i2', v: 'rice:', p: 'rice', type: 'RESTOCK', q: 5, t: 1790000500000, b: 'B1', exp: '2027-06-30' });
check('a batch keeps one expiry date', /already has the expiry date 2026-12-31/.test(r.err || ''), r);
r = await saveMove(db, A, { id: 'i3', v: 'rice:', p: 'rice', type: 'RESTOCK', q: 5, t: 1790000500000, b: 'B2', exp: '2025-01-31' });
check('a second batch (already expired: the report still counts it) — B2 with 5', !r.err && await left('B2') === 5, r);
const expired = await rows(db, A, `SELECT batch_no FROM public.hangtag_batches WHERE expiry < DATE '2026-09-30' AND variant_id = 'rice:'`);
check('expired batches are found by their expiry date', expired.length === 1 && expired[0].batch_no === 'B2', expired);
r = await tryAs(db, A, `UPDATE public.hangtag_stock_moves SET batch_no = 'B9' WHERE id = 'i3'`);
check('a saved stock record\'s batch never changes', /doesn't change/.test(r.err || ''), r);
r = await tryAs(db, A, `SELECT public.hangtag_cancel_purchase('pu1', 'Wrong supplier', 'dev-a', 1790000100000) AS r`);
check('the purchase still can\'t be cancelled (its serials, and B1 holds 8 of its 10 kg)', !!r.err, r);

console.log('=== audit, who may read and write, shops apart ===');
const au = await rows(db, A, `SELECT action, entity, entity_id FROM public.hangtag_audit_log WHERE entity IN ('serials', 'batches') ORDER BY id`);
const acts = (e) => au.filter((x) => x.entity_id === e).map((x) => x.action);
check('audit: serial assigned, sold, back in stock (bill cancelled), returned, written off …', acts('SN001').includes('insert') && acts('SN001').includes('sold') && acts('SN001').includes('returned')
  && acts('SN002').includes('in_stock') && acts('SN002').includes('written_off'), au.slice(0, 30));
check('audit: batches created', au.some((x) => x.entity === 'batches' && x.action === 'insert' && /^B1/.test(x.entity_id)), au);
check('audit: stock records with a batch (stock in and adjustments)', (await one(db, A, `SELECT count(*)::int n FROM public.hangtag_audit_log WHERE entity = 'stock_moves' AND summary ? 'batch_no'`)).n >= 3);
check('a cashier reads the register and the batches (serial lookup at the till)', (await rows(db, CA, `SELECT serial FROM public.hangtag_serials`)).length === 3
  && (await rows(db, CA, `SELECT batch_no FROM public.hangtag_batches`)).length === 2);
r = await tryAs(db, A, `UPDATE public.hangtag_serials SET status = 'IN_STOCK' WHERE serial = 'SN002'`);
const r2 = await tryAs(db, A, `INSERT INTO public.hangtag_serials (serial, variant_id, status) VALUES ('X1', 'ph:', 'IN_STOCK')`);
const r3 = await tryAs(db, A, `INSERT INTO public.hangtag_batches (variant_id, batch_no) VALUES ('rice:', 'B7')`);
check('nobody writes the register or the batches directly (not even the owner)', !!r.err && !!r2.err && !!r3.err, { r, r2, r3 });
check('shop B sees none of shop A\'s serials or batches', (await rows(db, B, `SELECT 1 FROM public.hangtag_serials`)).length === 0 && (await rows(db, B, `SELECT 1 FROM public.hangtag_batches`)).length === 0);
r = await savePurchase(db, B, purchase('pb1', [{ p: 'ph', v: 'ph:', n: 'Phone', q: '1', cost: '8000', serials: ['SN002'] }]));
check('shop B may have its own SN002 (unique within a shop)', !r.err && (await serial(B, 'SN002')).status === 'IN_STOCK', r);
{
  const rep = await report(db);
  check('the report is all ok with serials sold, returned, written off and batches used', rep.length === 76 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
}
await db.exec(NEW);
check('the schema runs again with all of it there', (await report(db)).every((x) => x.ok));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
