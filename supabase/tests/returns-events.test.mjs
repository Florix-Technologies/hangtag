// Returns with credit notes and events in the database (schema.sql section 3g): the upgrade of existing returns (whole
// rupees → paise), RPC hangtag_save_return (all or nothing, safe to retry, never on a cancelled bill, never more than a
// line has left, value = lines + round off), refunds posted to the books with paise (the same entries as
// domain/finance/books.js), bills tagged with an event, events that can't be deleted once they have bills, and each shop
// seeing only its own. PGlite with Supabase stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { quoteReturn } from '../../src/domain/returns/return-value.js';
import { financialTransactions } from '../../src/domain/finance/books.js';
import { billArgs, returnArgs, rowToReturn, rowToReturnItem } from '../../src/infrastructure/supabase/mappers.js';

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
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;

function bill(id, lines, { billDisc = null, pays, credit = 0, t = 1790000000000, kind = 'sale', event = null } = {}) {
  const T = computeCheckout({ lines, billDisc, gst: { mode: 'intra', inclusive: false } }), due = T.total - credit;
  const S = settlePayments(due, pays ? pays(due) : due > 0 ? [{ method: 'cash', amount: due }] : []);
  return { id, no: 'INV-' + id, t, dev: 'd1', kind, ex: null, credit, cust: null, ...(event ? { event } : {}),
    items: lines.map((l, k) => { const L = T.lines[k]; return { ln: k, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: l.q, price: l.price, cost: null,
      dAmt: L.itemDisc, bdAmt: L.billDisc, gst: L.rate, hsn: '6109', tx: L.taxable, cgst: L.cgst, sgst: L.sgst, igst: L.igst, lt: L.total }; }),
    sub: T.sub, disc: T.disc, itemDisc: T.itemDisc, billDisc, billDiscAmt: T.billDisc, taxable: T.taxable, tax: T.tax, cgst: T.cgst, sgst: T.sgst, igst: T.igst,
    taxRate: T.rate || 0, taxIncl: T.incl, gst: { mode: T.mode, pos: '27' }, roundOff: T.roundOff, total: T.total,
    pay: S.payments.length > 1 ? 'split' : (S.payments[0] || { method: 'cash' }).method, payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
/* A return as the app's RecordReturn makes it (values from the saved bill) */
function ret(id, sale, picks, { prior = [], pay = 'cash', refund, restock = true, t = sale.t + 5000 } = {}) {
  const Q = quoteReturn(sale, picks, prior);
  return { id, no: 'CN-' + id, sale: sale.id, t, kind: 'return', ex: null, refund: refund === undefined ? Q.value : refund, pay, value: Q.value, ro: Q.roundOff, note: '', dev: 'd1',
    items: Q.lines.map((L) => ({ ln: L.ln, v: 'p1:M', p: 'p1', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: L.q, price: L.unit, value: L.value, cost: null, restock,
      tx: L.tx, cgst: L.cgst, sgst: L.sgst, igst: L.igst, gst: L.rate, hsn: L.hsn })) };
}
const saveBills = (db, uid, bills) => tryAs(db, uid, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(bills.map(billArgs))]);
const saveRet = (db, uid, r) => { const a = returnArgs(r); return tryAs(db, uid, `SELECT public.hangtag_save_return($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a.p_return), JSON.stringify(a.p_items)]); };

console.log('=== upgrade: existing returns keep their values, now with paise ===');
{
  const db = await fresh();
  await db.exec(V5);
  await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, total, payment_method) VALUES ('s1', 1790000000000, 1000, 0, 1000, 'cash')`);
  await as(db, A, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price) VALUES ('s1',0,'p1','Tee','M',2,500)`);
  await as(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, kind, refund_amount, refund_method, value) VALUES ('r1','s1',1790000004000,'return',500,'cash',500)`);
  await db.exec(NEW); await db.exec(NEW);
  const cols = (await db.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('hangtag_returns','hangtag_return_items') AND column_name IN ('value','refund_amount','restock','credit_no','round_off','taxable_value')`)).rows;
  check('return amounts are NUMERIC now; credit note, round off, restock and GST columns added', cols.filter((c) => c.column_name === 'value' || c.column_name === 'refund_amount').every((c) => c.data_type === 'numeric') && cols.length === 7, cols);
  const r1 = (await rows(db, A, `SELECT refund_amount, value, round_off, credit_no FROM public.hangtag_returns WHERE id = 'r1'`))[0];
  check('an existing return keeps its value and refund', num(r1.refund_amount) === 500 && num(r1.value) === 500 && num(r1.round_off) === 0 && r1.credit_no === null, r1);
  const rep = await report(db);
  check('migration report: 52 rows, all ok (incl. returns never exceed bought, return values, event bills, verified payments, receipts once, cash reversals, team members and devices, business types and capabilities)', rep.length === 52 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
  await db.close();
}

console.log('\n=== saving returns (RPC hangtag_save_return) ===');
const db = await fresh();
await db.exec(NEW);
// 3 Tees at ₹333 with 10% off the bill and 12% GST: line totals with paise, a round off
const s1 = bill('s1', [{ q: 3, price: 339, rate: 12 }], { billDisc: { type: 'percent', value: 10 } });
check('the bill as saved', !(await saveBills(db, A, [s1])).err && s1.roundOff !== 0, s1);
const r1 = ret('r1', s1, { 0: 1 });
let r = await saveRet(db, A, r1);
check('a partial return is saved with its line, all in one step', !r.err && r.r.rows[0].r.lines === 1, r.err);
const row = (await rows(db, A, `SELECT * FROM public.hangtag_returns WHERE id = 'r1'`))[0];
check('the refund keeps its paise and its credit note number', num(row.refund_amount) === r1.refund && num(row.value) === r1.value && row.credit_no === 'CN-r1' && String(r1.value).includes('.'), { row, r1 });
const it = (await rows(db, A, `SELECT * FROM public.hangtag_return_items WHERE return_id = 'r1'`))[0];
check('the line keeps the GST reversed (taxable, rate, CGST, SGST), the HSN and "back on the shelf"', num(it.taxable_value) === r1.items[0].tx && num(it.cgst_amount) === r1.items[0].cgst && num(it.gst_rate) === 12 && it.hsn === '6109' && it.restock === true);
const back = rowToReturn(row, [rowToReturnItem(it)]);
check('read back, it is the same return the app made', back.value === r1.value && back.refund === r1.refund && back.no === r1.no && back.items[0].tx === r1.items[0].tx);
r = await saveRet(db, A, r1);
check('saving it again (a retry) changes nothing: one return, one line, one refund posted', !r.err && await n(db, A, 'hangtag_returns') === 1 && await n(db, A, 'hangtag_return_items') === 1 && await n(db, A, 'hangtag_fin_txns', `WHERE return_id = 'r1'`) === 1);
const cb = (await rows(db, A, `SELECT id, amount_out FROM public.hangtag_cash_book WHERE entry_type = 'cash_refund'`))[0];
const appTx = financialTransactions([s1], [r1]).find((x) => x.kind === 'refund');
check('the cash refund is posted to the cash book with paise, the same entry the app derives', cb && cb.id === 'cb:' + appTx.id && num(cb.amount_out) === appTx.amount, { cb, appTx });
const over = ret('r2', s1, { 0: 3 }, { prior: [] });
r = await saveRet(db, A, over);
check('returning more than is left is refused, and nothing of that return is left behind', !!r.err && /already returned/.test(r.err) && await n(db, A, 'hangtag_returns') === 1 && await n(db, A, 'hangtag_fin_txns', `WHERE return_id = 'r2'`) === 0, r.err);
const r3 = ret('r3', s1, { 0: 2 }, { prior: [r1], pay: 'upi', restock: false });
r = await saveRet(db, A, r3);
check('the rest of the bill: its return brings the round off, and all returns add up to the bill total', !r.err && r3.ro === s1.roundOff
  && Math.round((r1.value + r3.value) * 100) === Math.round(s1.total * 100), { r1: r1.value, r3: r3.value, total: s1.total });
check('"not for resale" is kept, and the UPI refund goes to the bank book', (await rows(db, A, `SELECT restock FROM public.hangtag_return_items WHERE return_id = 'r3'`))[0].restock === false
  && num((await rows(db, A, `SELECT amount_out FROM public.hangtag_bank_book WHERE fin_txn_id = 'ft:r3'`))[0].amount_out) === r3.value);
const lie = { ...ret('r4', bill('s2', [{ q: 1, price: 100, rate: 0 }]), { 0: 1 }), value: 150 };
await saveBills(db, A, [bill('s2', [{ q: 1, price: 100, rate: 0 }])]);
r = await saveRet(db, A, lie);
check('a return whose value isn\'t its lines plus round off is refused', !!r.err && /worth/.test(r.err) && await n(db, A, 'hangtag_returns', `WHERE id = 'r4'`) === 0, r.err);
r = await saveRet(db, A, { ...ret('r5', bill('s2', [{ q: 1, price: 100, rate: 0 }]), { 0: 1 }), refund: 120 });
check('a refund larger than the return is refused', !!r.err && await n(db, A, 'hangtag_returns', `WHERE id = 'r5'`) === 0, r.err);
await as(db, A, `UPDATE public.hangtag_sales SET is_void = true WHERE id = 's2'`);
r = await saveRet(db, A, ret('r6', bill('s2', [{ q: 1, price: 100, rate: 0 }]), { 0: 1 }));
check('a cancelled bill can\'t have a return', !!r.err && /cancelled/.test(r.err));
r = await saveRet(db, A, { ...r1, id: 'r7', no: 'CN-r7', sale: 'nope' });
check('a return for a bill that isn\'t there is refused (it waits in the app until the bill has uploaded)', !!r.err && /not found/.test(r.err));
r = await saveRet(db, B, { ...r1, id: 'r8' });
check('another shop can\'t return against this shop\'s bill (it can\'t even see it)', !!r.err && /not found/.test(r.err) && await n(db, B, 'hangtag_returns') === 0);
check('signed out: refused', !!(await tryAs(db, null, `SELECT public.hangtag_save_return('{}'::jsonb, '[]'::jsonb)`)).err);
const lessLines = { ...r3, items: r3.items.slice(0, 1) };
r = await saveRet(db, A, lessLines);
check('saving a return again with its lines (a retry after an edit) keeps exactly those lines', !r.err && await n(db, A, 'hangtag_return_items', `WHERE return_id = 'r3'`) === 1);

console.log('\n=== events ===');
await as(db, A, `INSERT INTO public.hangtag_events (id, name, start_date, end_date, location) VALUES ('e1', 'Diwali pop-up', '2026-10-20', '2026-10-22', 'Pune'), ('e2', 'Unused', '2026-11-01', '2026-11-01', NULL)`);
check('an event is saved (active by default) and only its shop sees it', await n(db, A, 'hangtag_events') === 2 && await n(db, B, 'hangtag_events') === 0
  && (await rows(db, A, `SELECT status FROM public.hangtag_events WHERE id = 'e1'`))[0].status === 'active');
check('end date before start is refused', !!(await tryAs(db, A, `INSERT INTO public.hangtag_events (id, name, start_date, end_date) VALUES ('e3', 'Bad', '2026-10-05', '2026-10-01')`)).err);
check('another shop can\'t change or delete it', (await tryAs(db, B, `UPDATE public.hangtag_events SET name = 'x' WHERE id = 'e1' RETURNING id`)).r.rows.length === 0 && (await tryAs(db, B, `DELETE FROM public.hangtag_events WHERE id = 'e1' RETURNING id`)).r.rows.length === 0);
const eb = bill('s3', [{ q: 1, price: 999, rate: 12 }], { event: 'e1' });
check('a bill made at the event keeps its event', !(await saveBills(db, A, [eb])).err && (await rows(db, A, `SELECT event_id FROM public.hangtag_sales WHERE id = 's3'`))[0].event_id === 'e1');
check('a store bill has none', (await rows(db, A, `SELECT event_id FROM public.hangtag_sales WHERE id = 's1'`))[0].event_id === null);
check('an event with bills can\'t be deleted', /has bills/.test((await tryAs(db, A, `DELETE FROM public.hangtag_events WHERE id = 'e1'`)).err || '') && await n(db, A, 'hangtag_events') === 2);
check('…but can be closed, and an event without bills deleted', !(await tryAs(db, A, `UPDATE public.hangtag_events SET status = 'closed' WHERE id = 'e1'`)).err && !(await tryAs(db, A, `DELETE FROM public.hangtag_events WHERE id = 'e2'`)).err && await n(db, A, 'hangtag_events') === 1);
check('signed out: no access to events', !!(await tryAs(db, null, `SELECT * FROM public.hangtag_events`)).err);
const rep = await report(db);
check('migration report after all this: every row ok', rep.every((x) => x.ok), rep.filter((x) => !x.ok));
await db.query(`DELETE FROM auth.users WHERE id = $1`, [A]);
check('deleting the account still removes everything (events with bills too)', (await db.query(`SELECT count(*)::int n FROM public.hangtag_events`)).rows[0].n === 0 && (await db.query(`SELECT count(*)::int n FROM public.hangtag_returns`)).rows[0].n === 0);
await db.close();

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
