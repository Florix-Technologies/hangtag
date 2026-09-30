// Discounts, GST, payments and the money books in the database (schema.sql section 3e): the upgrade of existing bills
// and refunds, saving bills with RPC hangtag_save_sales, the posting of financial transactions and cash / bank book
// entries, cancelled bills, refunds, bills from older app versions, the money rules, and each shop seeing only its own.
// The app's own derivation (domain/finance/books.js) must give the very same entries. PGlite with Supabase stand-ins.
// Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { bankBook, cashBook, financialTransactions } from '../../src/domain/finance/books.js';
import { billArgs } from '../../src/infrastructure/supabase/mappers.js';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const V5 = fs.readFileSync(new URL('./fixtures/legacy/schema_v5.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };
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
async function as(db, uid, sql, params) {
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, uid, sql, params) => { try { return { r: await as(db, uid, sql, params) }; } catch (e) { return { err: e.message }; } };
async function fresh() { const db = new PGlite(); await db.exec(SUPABASE); await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]); return db; }
const rows = async (db, uid, sql) => (await as(db, uid, sql)).rows;
const n = async (db, uid, t, where = '') => (await as(db, uid, `SELECT count(*)::int n FROM public.${t} ${where}`)).rows[0].n;
const num = (v) => (v == null ? null : +v);

/* A bill as the app builds it (features/sales/use-cases/checkout.js): totals from the domain, payments settled */
function bill(id, lines, { billDisc = null, gst = { mode: 'intra', inclusive: false }, pays, credit = 0, t = 1790000000000, cust = null, kind = 'sale' } = {}) {
  const T = computeCheckout({ lines, billDisc, gst }), S = settlePayments(T.total - credit, typeof pays === 'function' ? pays(T.total - credit) : pays || []);
  if (S.error) throw new Error(S.error);
  return { id, no: 'INV-' + id, t, dev: 'd1', kind, ex: null, credit, cust,
    items: lines.map((l, k) => { const L = T.lines[k]; return { ln: k, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: l.q, price: l.price, cost: null,
      ...(l.disc ? { disc: l.disc } : {}), dAmt: L.itemDisc, bdAmt: L.billDisc, gst: L.rate, hsn: '6109', tx: L.taxable, cgst: L.cgst, sgst: L.sgst, igst: L.igst, lt: L.total }; }),
    sub: T.sub, disc: T.disc, itemDisc: T.itemDisc, billDisc, billDiscAmt: T.billDisc, taxable: T.taxable, tax: T.tax, cgst: T.cgst, sgst: T.sgst, igst: T.igst,
    taxRate: T.rate || 0, taxIncl: T.incl, gst: { mode: T.mode, pos: '27' }, roundOff: T.roundOff, total: T.total,
    pay: S.payments.length > 1 ? 'split' : (S.payments[0] || { method: 'cash' }).method, payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
const save = (db, uid, bills) => tryAs(db, uid, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(bills.map(billArgs))]);
const saveRaw = (db, uid, args) => tryAs(db, uid, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(args)]);

console.log('=== upgrade: existing bills and refunds get payments, transactions and book entries ===');
{
  const db = await fresh();
  await db.exec(V5);
  await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, total, payment_method, tax_rate, tax_amount, tax_inclusive) VALUES
    ('s1', 1790000000000, 1050, 50, 1000, 'cash', 5, 48, true), ('s2', 1790000001000, 500, 0, 500, 'upi', 0, 0, true),
    ('s3', 1790000002000, 800, 0, 800, 'card', 0, 0, true)`);
  await as(db, A, `UPDATE public.hangtag_sales SET is_void = true WHERE id = 's3'`);
  await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method, kind, exchange_id, credit) VALUES ('s4', 1790000003000, 300, 300, 'cash', 'exchange', 'x1', 300)`);
  await as(db, A, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price) VALUES
    ('s1',0,'p1','Tee','M',1,1050), ('s2',0,'p1','Tee','L',1,500), ('s3',0,'p1','Tee','S',1,800), ('s4',0,'p1','Tee','M',1,300)`);
  await as(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, kind, refund_amount, refund_method, value) VALUES
    ('r1','s1',1790000004000,'return',200,'cash',200), ('r2','s2',1790000005000,'return',100,'upi',100), ('r3','s1',1790000006000,'exchange',0,'cash',300)`);
  await db.exec(NEW);
  const snap = async () => JSON.stringify({ p: await n(db, A, 'hangtag_payments'), f: await n(db, A, 'hangtag_fin_txns'), c: await n(db, A, 'hangtag_cash_book'), b: await n(db, A, 'hangtag_bank_book') });
  const first = await snap();
  await db.exec(NEW);
  check('the script runs twice and posts nothing twice', first === await snap(), [first, await snap()]);
  const s1 = (await rows(db, A, `SELECT discount, total, tax_amount, gst_mode, cgst_amount, sgst_amount, taxable_amount, bill_discount, item_discount FROM public.hangtag_sales WHERE id='s1'`))[0];
  check('an existing bill keeps its figures; its discount is on the whole bill and its GST becomes CGST + SGST halves',
    num(s1.discount) === 50 && s1.total === 1000 && num(s1.tax_amount) === 48 && s1.gst_mode === 'intra' && num(s1.cgst_amount) === 24 && num(s1.sgst_amount) === 24
    && num(s1.taxable_amount) === 952 && num(s1.bill_discount) === 50 && num(s1.item_discount) === 0, s1);
  check('a bill without GST is marked "none"', (await rows(db, A, `SELECT gst_mode FROM public.hangtag_sales WHERE id='s2'`))[0].gst_mode === 'none');
  const pays = await rows(db, A, `SELECT id, method, amount, tendered, status FROM public.hangtag_payments ORDER BY id`);
  check('each existing bill gets one payment: its method, for what was due (nothing for a fully credited exchange)',
    JSON.stringify(pays.map((p) => [p.id, p.method, num(p.amount), num(p.tendered), p.status])) === JSON.stringify([['s1:cash', 'cash', 1000, 1000, 'completed'], ['s2:upi', 'upi', 500, null, 'completed'], ['s3:card', 'card', 800, null, 'cancelled']]), pays);
  const ft = await rows(db, A, `SELECT id, kind, direction, method, amount, sale_id, status FROM public.hangtag_fin_txns ORDER BY id`);
  check('existing payments and refunds are posted as transactions pointing at their bill (a ₹0 refund is not)',
    JSON.stringify(ft.map((x) => [x.id, x.kind, x.direction, num(x.amount), x.sale_id, x.status])) === JSON.stringify([
      ['ft:r1', 'refund', 'out', 200, 's1', 'posted'], ['ft:r2', 'refund', 'out', 100, 's2', 'posted'],
      ['ft:s1:cash', 'sale_receipt', 'in', 1000, 's1', 'posted'], ['ft:s2:upi', 'sale_receipt', 'in', 500, 's2', 'posted'], ['ft:s3:card', 'sale_receipt', 'in', 800, 's3', 'cancelled']]), ft);
  const cb = await rows(db, A, `SELECT id, entry_type, amount_in, amount_out FROM public.hangtag_cash_book ORDER BY t`);
  check('cash book: the cash sale in, the cash refund out', JSON.stringify(cb.map((x) => [x.id, x.entry_type, num(x.amount_in), num(x.amount_out)])) === JSON.stringify([['cb:ft:s1:cash', 'cash_sale', 1000, 0], ['cb:ft:r1', 'cash_refund', 0, 200]]), cb);
  const bb = await rows(db, A, `SELECT id, method, entry_type, amount_in, amount_out, status FROM public.hangtag_bank_book ORDER BY t`);
  check('bank book: the UPI and card payments in (the cancelled one marked), the UPI refund out',
    JSON.stringify(bb.map((x) => [x.id, x.method, x.entry_type, num(x.amount_in), num(x.amount_out), x.status])) === JSON.stringify([
      ['bb:ft:s2:upi', 'upi', 'receipt', 500, 0, 'posted'], ['bb:ft:s3:card', 'card', 'receipt', 800, 0, 'cancelled'], ['bb:ft:r2', 'upi', 'refund', 0, 100, 'posted']]), bb);
  const rep = (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
  check('migration report: payments, transactions and books all add up', rep.length === 46 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  await db.close();
}

console.log('\n=== saving bills (RPC hangtag_save_sales) ===');
const db = await fresh();
await db.exec(NEW);
// 2 × ₹999 with 10% off one line, ₹50 off the bill, 5% GST on top (CGST + SGST); paid ₹500 cash (₹600 handed over) + the rest by UPI
const b1 = bill('b1', [{ q: 2, price: 999, rate: 5, disc: { type: 'percent', value: 10 } }, { q: 1, price: 250, rate: 5 }], { billDisc: { type: 'fixed', value: 50 },
  pays: (due) => [{ method: 'cash', amount: 500, received: 600 }, { method: 'upi', amount: due - 500, ref: 'UTR123456789' }] });
const r2 = (x) => Math.round(x * 100) / 100;
check('the app worked out the bill: 1998 + 250, −199.80, −50, 5% GST on the rest (99.92), rounded to 2098',
  b1.sub === 2248 && b1.itemDisc === 199.8 && b1.billDiscAmt === 50 && b1.taxable === 1998.2 && b1.tax === 99.92 && b1.roundOff === -0.12 && b1.total === 2098, b1);
let r = await save(db, A, [b1]);
check('a split bill is saved with its lines and payments', !r.err && r.r.rows[0].r.bills === 1, r.err);
const sale1 = (await rows(db, A, `SELECT * FROM public.hangtag_sales WHERE id='b1'`))[0];
check('the bill keeps its discounts, taxable amount, CGST + SGST, round off and place of supply',
  num(sale1.discount) === 249.8 && num(sale1.item_discount) === 199.8 && num(sale1.bill_discount) === 50 && sale1.bill_discount_type === 'fixed'
  && num(sale1.taxable_amount) === b1.taxable && num(sale1.cgst_amount) === b1.cgst && num(sale1.sgst_amount) === b1.sgst && num(sale1.igst_amount) === 0
  && num(sale1.round_off) === b1.roundOff && sale1.gst_mode === 'intra' && sale1.place_of_supply === '27' && sale1.payment_method === 'split', sale1);
const lines1 = await rows(db, A, `SELECT line_no, discount_type, discount_value, discount_amount, bill_discount_share, taxable_value, gst_rate, cgst_amount, line_total, hsn FROM public.hangtag_sale_items WHERE sale_id='b1' ORDER BY line_no`);
check('each line keeps its own discount, its share of the bill discount and its GST',
  lines1[0].discount_type === 'percent' && num(lines1[0].discount_value) === 10 && num(lines1[0].discount_amount) === 199.8
  && r2(num(lines1[0].bill_discount_share) + num(lines1[1].bill_discount_share)) === 50 && num(lines1[1].gst_rate) === 5 && lines1[0].hsn === '6109'
  && r2(num(lines1[0].line_total) + num(lines1[1].line_total)) === r2(b1.total - b1.roundOff), lines1);
check('payments: one row per method, cash with what was handed over and the change',
  JSON.stringify((await rows(db, A, `SELECT id, method, amount, tendered, change_given, reference FROM public.hangtag_payments ORDER BY id`)).map((p) => [p.id, num(p.amount), num(p.tendered), num(p.change_given), p.reference]))
  === JSON.stringify([['b1:cash', 500, 600, 100, null], ['b1:upi', 1598, null, 0, 'UTR123456789']]));
check('financial transactions reference the bill and the payment', JSON.stringify(await rows(db, A, `SELECT id, sale_id, payment_id, kind, status FROM public.hangtag_fin_txns ORDER BY id`))
  === JSON.stringify([{ id: 'ft:b1:cash', sale_id: 'b1', payment_id: 'b1:cash', kind: 'sale_receipt', status: 'posted' }, { id: 'ft:b1:upi', sale_id: 'b1', payment_id: 'b1:upi', kind: 'sale_receipt', status: 'posted' }]));
const cash1 = (await rows(db, A, `SELECT id, fin_txn_id, amount_in, cash_received, change_given FROM public.hangtag_cash_book`))[0];
check('cash book entry: ₹500 in (₹600 received, ₹100 change), pointing at its transaction', cash1.id === 'cb:ft:b1:cash' && cash1.fin_txn_id === 'ft:b1:cash' && num(cash1.amount_in) === 500 && num(cash1.cash_received) === 600 && num(cash1.change_given) === 100, cash1);
const bank1 = (await rows(db, A, `SELECT id, method, reference, amount_in FROM public.hangtag_bank_book`))[0];
check('bank book entry: the UPI part with its reference', bank1.id === 'bb:ft:b1:upi' && bank1.method === 'upi' && bank1.reference === 'UTR123456789' && num(bank1.amount_in) === 1598, bank1);
r = await save(db, A, [b1]);
check('saving the same bill again (a retry) duplicates nothing', !r.err && await n(db, A, 'hangtag_payments') === 2 && await n(db, A, 'hangtag_fin_txns') === 2 && await n(db, A, 'hangtag_cash_book') === 1 && await n(db, A, 'hangtag_bank_book') === 1 && await n(db, A, 'hangtag_sale_items') === 2);

// payments that don't add up are refused, and nothing of the bill is kept
const b2 = bill('b2', [{ q: 1, price: 1000, rate: 0 }], { gst: { mode: 'none' }, pays: [{ method: 'card', amount: 1000, ref: 'APPR123' }] });
const bad = (payments) => billArgs({ ...b2, payments });
r = await saveRaw(db, A, [bad([{ id: 'b2:card', method: 'card', amount: 600 }])]);
check('underpayment is refused and the bill is not saved', /come to 600(\.00)? but 1000(\.00)? is due/.test(r.err || '') && await n(db, A, 'hangtag_sales', `WHERE id='b2'`) === 0, r.err);
r = await saveRaw(db, A, [bad([{ id: 'b2:card', method: 'card', amount: 700 }, { id: 'b2:upi', method: 'upi', amount: 400 }])]);
check('overpayment is refused', /would come to 1100/.test(r.err || '') && await n(db, A, 'hangtag_sales', `WHERE id='b2'`) === 0, r.err);
r = await saveRaw(db, A, [bad([{ id: 'b2:cash', method: 'cash', amount: 500 }, { id: 'b2:cash', method: 'cash', amount: 500 }])]);
check('the same method twice on a bill is refused (no duplicate allocation)', /cannot affect row a second time|hangtag_payments_sale_method_key|duplicate key/.test(r.err || '') && await n(db, A, 'hangtag_sales', `WHERE id='b2'`) === 0, r.err);
r = await saveRaw(db, A, [bad([{ id: 'b1:card', method: 'card', amount: 1000 }])]);
check("a payment can't take another bill's payment id", /hangtag_payments_id_check/.test(r.err || '') && num((await rows(db, A, `SELECT amount FROM public.hangtag_payments WHERE id='b1:cash'`))[0].amount) === 500, r.err);
r = await saveRaw(db, A, [bad([{ id: 'b2:cheque', method: 'cheque', amount: 1000 }])]);
check('an unknown payment method is refused', /hangtag_payments_method_check|violates check/.test(r.err || ''), r.err);
r = await saveRaw(db, A, [bad([{ id: 'b2:cash', method: 'cash', amount: 1000, received: 900 }])]);
check('cash received below the cash amount is refused', /hangtag_payments_cash_check/.test(r.err || '') && await n(db, A, 'hangtag_sales', `WHERE id='b2'`) === 0, r.err);
r = await save(db, A, [b2]);
check('the correct payment is accepted', !r.err, r.err);
const ex = bill('b3', [{ q: 1, price: 300, rate: 0 }], { gst: { mode: 'none' }, credit: 300, kind: 'exchange', pays: [] });
r = await save(db, A, [ex]);
check('an exchange covered by its credit needs no payment', !r.err && await n(db, A, 'hangtag_payments', `WHERE sale_id='b3'`) === 0, r.err);

// the money rules on bills
const withSale = (patch) => [{ ...billArgs(b2), sale: { ...billArgs(b2).sale, id: 'bx', bill_no: 'INV-bx', ...patch }, items: [], payments: [{ id: 'bx:card', method: 'card', amount: patch.total ?? 1000 }] }];
r = await saveRaw(db, A, withSale({ discount: 1200, bill_discount: 1200, subtotal: 1000 }));
check('a discount larger than the subtotal is refused', /hangtag_sales_money_check/.test(r.err || ''), r.err);
r = await saveRaw(db, A, withSale({ bill_discount_type: 'percent', bill_discount_value: 120 }));
check('a bill discount over 100% is refused', /hangtag_sales_bill_discount_check/.test(r.err || ''), r.err);
r = await saveRaw(db, A, withSale({ gst_mode: 'inter', tax_amount: 50, cgst_amount: 25, sgst_amount: 25 }));
check('IGST bills carry no CGST / SGST', /hangtag_sales_gst_check/.test(r.err || ''), r.err);
r = await saveRaw(db, A, withSale({ gst_mode: 'intra', tax_amount: 50, cgst_amount: 20, sgst_amount: 20 }));
check('GST must equal CGST + SGST + IGST', /hangtag_sales_gst_check/.test(r.err || ''), r.err);
r = await saveRaw(db, A, [{ ...billArgs(b2), sale: { ...billArgs(b2).sale, id: 'by', bill_no: 'INV-by' }, payments: [{ id: 'by:card', method: 'card', amount: 1000 }],
  items: [{ ...billArgs(b2).items[0], sale_id: 'by', discount_type: 'fixed', discount_value: 1500, discount_amount: 1500 }] }]);
check('a line discount larger than the line is refused', /hangtag_sale_items_money_check/.test(r.err || ''), r.err);

console.log('\n=== cancelled bills, refunds, older app versions ===');
await as(db, A, `UPDATE public.hangtag_sales SET is_void = true WHERE id = 'b1'`);
const st = async (id) => JSON.stringify({ p: (await rows(db, A, `SELECT DISTINCT status FROM public.hangtag_payments WHERE sale_id='${id}'`)).map((x) => x.status),
  f: (await rows(db, A, `SELECT DISTINCT status FROM public.hangtag_fin_txns WHERE sale_id='${id}'`)).map((x) => x.status),
  c: (await rows(db, A, `SELECT DISTINCT status FROM public.hangtag_cash_book WHERE sale_id='${id}'`)).map((x) => x.status),
  b: (await rows(db, A, `SELECT DISTINCT status FROM public.hangtag_bank_book WHERE sale_id='${id}'`)).map((x) => x.status) });
check('cancelling a bill cancels its payments, transactions and book entries (kept, not deleted)', await st('b1') === JSON.stringify({ p: ['cancelled'], f: ['cancelled'], c: ['cancelled'], b: ['cancelled'] }) && await n(db, A, 'hangtag_fin_txns', `WHERE sale_id='b1'`) === 2, await st('b1'));
await as(db, A, `UPDATE public.hangtag_sales SET is_void = false WHERE id = 'b1'`);
check('restoring it posts them again', await st('b1') === JSON.stringify({ p: ['completed'], f: ['posted'], c: ['posted'], b: ['posted'] }), await st('b1'));
await as(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, kind, refund_amount, refund_method, value) VALUES ('rc','b2',1790000100000,'return',400,'cash',400), ('ru','b1',1790000200000,'return',300,'upi',300), ('r0','b1',1790000300000,'exchange',0,'cash',100)`);
check('a cash refund goes out of the cash book, a UPI refund out of the bank book; a ₹0 refund posts nothing',
  num((await rows(db, A, `SELECT amount_out FROM public.hangtag_cash_book WHERE id='cb:ft:rc'`))[0].amount_out) === 400
  && num((await rows(db, A, `SELECT amount_out FROM public.hangtag_bank_book WHERE id='bb:ft:ru'`))[0].amount_out) === 300
  && await n(db, A, 'hangtag_fin_txns', `WHERE return_id='r0'`) === 0);
await as(db, A, `DELETE FROM public.hangtag_returns WHERE id = 'rc'`);
check('a return taken back removes its refund from the books', await n(db, A, 'hangtag_fin_txns', `WHERE id='ft:rc'`) === 0 && await n(db, A, 'hangtag_cash_book', `WHERE id='cb:ft:rc'`) === 0);
await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('old1', 1790000400000, 700, 700, 'upi')`);
check('a bill from an older app version (no payments sent) gets its payment and is posted',
  JSON.stringify((await rows(db, A, `SELECT id, method, amount FROM public.hangtag_payments WHERE sale_id='old1'`)).map((p) => [p.id, p.method, num(p.amount)])) === JSON.stringify([['old1:upi', 'upi', 700]])
  && await n(db, A, 'hangtag_bank_book', `WHERE sale_id='old1'`) === 1);

// the app's own derivation gives the very same entries
const sales = (await rows(db, A, `SELECT id, bill_no, timestamp, total, credit, is_void FROM public.hangtag_sales`)).map((s) => ({ id: s.id, no: s.bill_no, t: +s.timestamp, total: s.total, credit: s.credit, void: s.is_void, pay: 'cash' }));
const payRows = await rows(db, A, `SELECT * FROM public.hangtag_payments`);
sales.forEach((s) => { s.payments = payRows.filter((p) => p.sale_id === s.id).map((p) => ({ id: p.id, method: p.method, amount: +p.amount, ...(p.method === 'cash' ? { received: +p.tendered, change: +p.change_given } : {}), ...(p.reference ? { ref: p.reference } : {}) })); });
const rets = (await rows(db, A, `SELECT id, sale_id, t, refund_amount, refund_method FROM public.hangtag_returns`)).map((x) => ({ id: x.id, sale: x.sale_id, t: +x.t, refund: num(x.refund_amount), pay: x.refund_method }));
const tx = financialTransactions(sales, rets);
const dbTx = await rows(db, A, `SELECT id, method, amount, sale_id, status FROM public.hangtag_fin_txns ORDER BY id`);
check('the app derives the same financial transactions as the database (ids, amounts, bills, status)',
  JSON.stringify(tx.map((x) => [x.id, x.method, x.amount, x.saleId, x.status]).sort()) === JSON.stringify(dbTx.map((x) => [x.id, x.method, num(x.amount), x.sale_id, x.status]).sort()), { app: tx.map((x) => x.id), db: dbTx.map((x) => x.id) });
const C = cashBook(tx), dbC = await rows(db, A, `SELECT id, amount_in, amount_out, status FROM public.hangtag_cash_book ORDER BY id`);
check('… and the same cash book entries', JSON.stringify(C.entries.map((e) => [e.id, e.in, e.out, e.status]).sort()) === JSON.stringify(dbC.map((e) => [e.id, num(e.amount_in), num(e.amount_out), e.status]).sort()));
const Bk = bankBook(tx), dbB = await rows(db, A, `SELECT id, amount_in, amount_out, status FROM public.hangtag_bank_book ORDER BY id`);
check('… and the same bank book entries', JSON.stringify(Bk.entries.map((e) => [e.id, e.in, e.out, e.status]).sort()) === JSON.stringify(dbB.map((e) => [e.id, num(e.amount_in), num(e.amount_out), e.status]).sort()));
const bal = (await rows(db, A, `SELECT COALESCE(sum(amount_in - amount_out), 0) AS b FROM public.hangtag_cash_book WHERE status = 'posted'`))[0].b;
check('cash balance: the database and the app agree', num(bal) === C.closing, [bal, C.closing]);

await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('del1', 1790000500000, 90, 90, 'cash')`);
await as(db, A, `DELETE FROM public.hangtag_sales WHERE id = 'del1'`);
check('deleting a bill removes its payment, transaction and book entry with it (nothing left pointing at no bill)',
  await n(db, A, 'hangtag_payments', `WHERE sale_id='del1'`) + await n(db, A, 'hangtag_fin_txns', `WHERE sale_id='del1'`) + await n(db, A, 'hangtag_cash_book', `WHERE sale_id='del1'`) === 0);

console.log('\n=== shop isolation ===');
check("shop B sees none of shop A's payments, transactions or book entries",
  await n(db, B, 'hangtag_payments') + await n(db, B, 'hangtag_fin_txns') + await n(db, B, 'hangtag_cash_book') + await n(db, B, 'hangtag_bank_book') === 0);
r = await tryAs(db, B, `INSERT INTO public.hangtag_payments (owner_id, id, sale_id, method, amount, t) VALUES ('${A}', 'b2:upi', 'b2', 'upi', 1, 1)`);
check("shop B can't add a payment to shop A's bill", !!r.err, r);
r = await tryAs(db, A, `INSERT INTO public.hangtag_cash_book (id, fin_txn_id, sale_id, entry_type, amount_in, t) VALUES ('cb:fake', 'ft:b2:card', 'b2', 'cash_sale', 1, 1)`);
check('nobody writes book entries directly, not even for their own shop', /permission denied/.test(r.err || ''), r);
r = await tryAs(db, A, `UPDATE public.hangtag_fin_txns SET amount = 1`);
check('…or changes financial transactions', /permission denied/.test(r.err || ''), r);
r = await save(db, B, [{ ...b2 }]);
check("shop B saving a bill with the same id makes its own bill; A's is untouched", !r.err && await n(db, B, 'hangtag_payments') === 1 && await n(db, A, 'hangtag_payments', `WHERE sale_id='b2'`) === 1, r.err);
check('signed-out visitors can neither read payments nor save bills', /permission denied/.test((await tryAs(db, null, `SELECT * FROM public.hangtag_payments`)).err || '')
  && /permission denied/.test((await save(db, null, [b2])).err || ''));
await db.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
