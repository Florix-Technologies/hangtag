// Section 3m of schema.sql: customer credit (a bill's part on account for a saved customer only; its payments come to
// total − credit − due_amount; payments collected later posted to the cash or bank book; returns refunded to the account
// within what the bill has on account, with no book entry), held bills and the orders engine (hangtag_save_order: all or
// nothing, optimistic concurrency, status moves, delivered quantities never going down). Permissions (collect_credit,
// create_sale, create_order) are checked by the database for team members; shop A and shop B never see each other.
// PGlite with Supabase stand-ins (a member "acts as a device" through request.headers). Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { financialTransactions } from '../../src/domain/finance/books.js';
import { billArgs, collectionRow, heldRow, orderArgs, rowToCollection, rowToOrder, rowToOrderItem } from '../../src/infrastructure/supabase/mappers.js';

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
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const rows = async (db, who, sql, params) => (await as(db, who, sql, params)).rows;
const one = async (db, who, sql, params) => (await rows(db, who, sql, params))[0];
const count = async (db, who, t, where = '') => (await one(db, who, `SELECT count(*)::int AS n FROM public.${t} ${where}`)).n;
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const rls = (r) => /row-level security/.test(r.err || '');
const denied = (r) => /permission denied/.test(r.err || '');

const CUST = { id: 'c1', name: 'Asha', phone: '9876543210' };
/* A bill of one line: parts [{ method, amount, ref? }] + { method: 'due', amount } through the app's own settlePayments */
function bill(id, price, parts, { cust = CUST, order = null, credit = 0 } = {}) {
  const T = computeCheckout({ lines: [{ q: 1, price, rate: 0 }], billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total - credit, parts(T.total - credit), { customer: !!(cust && cust.id) });
  if (S.error) throw new Error(S.error);
  const L = T.lines[0];
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit, cust,
    items: [{ ln: 0, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: 1, price, cost: null, dAmt: 0, bdAmt: 0, gst: 0, hsn: '6109', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total }],
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: S.payments.length > 1 ? 'split' : S.payments.length ? S.payments[0].method : 'credit',
    payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })), ...(S.onAccount > 0 ? { dueAmt: S.onAccount } : {}), ...(order ? { order } : {}) };
}
const saveBills = (db, who, bills) => tryAs(db, who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(bills.map(billArgs))]);
const saveRaw = (db, who, args) => tryAs(db, who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(args)]);
const retArgs = (id, saleId, amount, method) => [JSON.stringify({ id, sale_id: saleId, t: 1790000005000, kind: 'return', refund_amount: amount, refund_method: method, value: amount, round_off: 0, credit_no: 'CN-' + id, device_id: 'd1' }),
  JSON.stringify([{ line_no: 0, sale_line_no: 0, variant_id: 'p1:M', product_id: 'p1', product_name: 'Tee', quantity: 1, unit_price: amount, value: amount, restock: true }])];
const saveReturn = (db, who, id, saleId, amount, method) => tryAs(db, who, `SELECT public.hangtag_save_return($1::jsonb, $2::jsonb) AS r`, retArgs(id, saleId, amount, method));
const collect = (db, who, c) => { const r = collectionRow({ t: 1790000009000, dev: 'd1', ...c }); return tryAs(db, who,
  `INSERT INTO public.hangtag_collections (id, customer_id, amount, method, reference, verification, t, device_id, note, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [r.id, r.customer_id, r.amount, r.method, r.reference, r.verification, r.t, r.device_id, r.note, r.status]); };
const saveOrder = (db, who, o) => { const a = orderArgs(o); return tryAs(db, who, `SELECT public.hangtag_save_order($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a.p_order), JSON.stringify(a.p_items)]); };
const quote = (over = {}) => ({ id: 'q1', kind: 'quote', no: 'QT-260929-ABC001', status: 'draft', cust: CUST, billDisc: null, notes: 'Wedding order', validUntil: '2026-10-30',
  source: 'staff', saleIds: [], version: 0, t: 1790000000000, updatedT: 1790000000000, dev: 'd1',
  items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Tee', vl: 'M', q: 10, price: 450, gst: 5, fq: 0, disc: { type: 'percent', value: 10 } },
    { ln: 1, p: 'p1', v: 'p1:M', name: 'Tee (gift wrap)', vl: 'M', q: 2.5, price: 20, gst: null, fq: 0 }], ...over });

// ---------- two shops; shop A's team ----------
const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const member = (n, role, key) => ({ id: uid(n), role, key, username: role + n, dev: 'dev-' + role + '-' + n });
const CA = member(1, 'cashier', 'key-cashier-0001-abcdefghijklmnop');
const SA = member(2, 'server', 'key-server-00002-abcdefghijklmnop');
const KA = member(3, 'kitchen', 'key-kitchen-0003-abcdefghijklmnop');
const MA = member(4, 'manager', 'key-manager-0004-abcdefghijklmnop');   // the shop's managers: no collect_credit (hangtag_roles below)
const CB = member(5, 'cashier', 'key-shopb-cash-05-abcdefghijklmno');

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
for (const m of [CA, SA, KA, MA, CB]) await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"staff":true}')`, [m.id, m.username + '@staff.hangtag.invalid']);
await db.exec(NEW); await db.exec(NEW);
console.log('=== schema runs twice; report ===');
{
  const rep = await report(db);
  check('migration report: 40 rows (45-49 are credit and orders), all ok on an empty shop', rep.length === 40 && rep.every((r) => r.ok) && rep.some((r) => /on account, for a saved customer/.test(r.check_name)), rep.filter((r) => !r.ok));
  const pub = (await db.query(`SELECT count(*)::int n FROM pg_class WHERE relname IN ('hangtag_collections','hangtag_held_carts','hangtag_orders','hangtag_order_items') AND relrowsecurity`)).rows[0].n;
  check('row security is on for the four new tables', pub === 4, pub);
}
for (const owner of [A, B]) {
  await as(db, owner, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1', 'Asha', '9876543210'), ('c2', 'Ravi', '9876500000')`);
  await as(db, owner, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Tee', 500, '{"opts":[{"name":"Size","values":["M"]}]}')`);
  await as(db, owner, `INSERT INTO public.hangtag_variants (id, product_id, option_values, size) VALUES ('p1:M', 'p1', '["M"]', 'M')`);
}
for (const [m, shop] of [[CA, A], [SA, A], [KA, A], [MA, A], [CB, B]]) {
  await asService(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1, $2, $3, $4, $5, 'active', $2)`, [m.id, shop, 'Staff ' + m.username, m.username, m.role]);
  await asService(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Phone', 'Android', $4)`, [shop, m.dev, m.id, hash(m.key)]);
}
await as(db, A, `INSERT INTO public.hangtag_roles (role, permissions) VALUES ('manager', $1)`, [['view_products', 'create_sale', 'perform_return', 'view_reports']]);

console.log('=== (a) selling on account ===');
{
  let r = await saveBills(db, A, [bill('b1', 1000, () => [{ method: 'cash', amount: 400 }, { method: 'due', amount: 600 }])]);
  const s = await one(db, A, `SELECT due_amount::float AS due, payment_method AS pm FROM public.hangtag_sales WHERE id = 'b1'`);
  const cb = await one(db, A, `SELECT sum(amount_in)::float AS n FROM public.hangtag_cash_book WHERE sale_id = 'b1'`);
  check('₹400 cash now + ₹600 on account for a saved customer: saved; ₹600 kept as due_amount; only the ₹400 is in the cash book', !r.err && s.due === 600 && s.pm === 'cash' && cb.n === 400, { r, s, cb });
  r = await saveBills(db, A, [bill('b2', 800, () => [{ method: 'due', amount: 800 }])]);
  const b2 = await one(db, A, `SELECT due_amount::float AS due, payment_method AS pm, (SELECT count(*)::int FROM public.hangtag_payments p WHERE p.sale_id = 'b2') AS pays FROM public.hangtag_sales WHERE id = 'b2'`);
  check('nothing paid now (all ₹800 on account, method "credit"): saved with no payment and no book entry', !r.err && b2.due === 800 && b2.pm === 'credit' && b2.pays === 0 && (await count(db, A, 'hangtag_fin_txns', `WHERE sale_id = 'b2'`)) === 0, { r, b2 });
  const walkin = billArgs({ ...bill('b3', 500, () => [{ method: 'cash', amount: 100 }, { method: 'due', amount: 400 }]), cust: null });
  r = await saveRaw(db, A, [walkin]);
  check('an amount on account for a walk-in (no customer) is refused', /due_check/.test(r.err || '') && (await count(db, A, 'hangtag_sales', `WHERE id = 'b3'`)) === 0, r.err);
  const short = billArgs(bill('b4', 500, () => [{ method: 'cash', amount: 100 }, { method: 'due', amount: 400 }])); short.sale.due_amount = 300;
  r = await saveRaw(db, A, [short]);
  check('payments + amount on account that don\'t make the total are refused (₹100 paid + ₹300 on account of ₹500)', /come to 100(\.00)? but 200(\.00)? is due/.test(r.err || '') && (await count(db, A, 'hangtag_sales', `WHERE id = 'b4'`)) === 0, r.err);
  const over = billArgs(bill('b5', 500, () => [{ method: 'due', amount: 500 }])); over.sale.due_amount = 600;
  r = await saveRaw(db, A, [over]);
  check('more on account than the bill is refused', /due_check/.test(r.err || ''), r.err);
  const extra = billArgs(bill('b6', 500, () => [{ method: 'cash', amount: 200 }, { method: 'due', amount: 300 }])); extra.payments[0].amount = 300;
  r = await saveRaw(db, A, [extra]);
  check('a payment above what is due now (total − on account) is refused by the payments trigger', /would come to 300(\.00)? but only 200(\.00)? is due/.test(r.err || ''), r.err);
  r = await saveBills(db, CA, [bill('b7', 300, () => [{ method: 'upi', amount: 100, ref: '412345678901' }, { method: 'due', amount: 200 }])]);
  check('a cashier (collect_credit) sells on account', !r.err && (await count(db, A, 'hangtag_sales', `WHERE id = 'b7' AND due_amount = 200`)) === 1, r);
  r = await saveBills(db, MA, [bill('b8', 300, () => [{ method: 'cash', amount: 100 }, { method: 'due', amount: 200 }])]);
  check('a role without collect_credit can\'t put anything on account (nothing saved)', /Not allowed to sell on credit/.test(r.err || '') && (await count(db, A, 'hangtag_sales', `WHERE id = 'b8'`)) === 0, r);
  r = await saveBills(db, MA, [bill('b9', 300, () => [{ method: 'cash', amount: 300 }])]);
  check('…but sells for cash as before', !r.err, r);
  r = await saveBills(db, A, [bill('b1', 1000, () => [{ method: 'cash', amount: 400 }, { method: 'due', amount: 600 }])]);
  check('uploading a credit bill again changes nothing (same due, one payment)', !r.err && (await count(db, A, 'hangtag_payments', `WHERE sale_id = 'b1'`)) === 1, r);
}

console.log('=== (a) payments collected later ===');
{
  let r = await collect(db, A, { id: 'col1', cust: 'c1', amount: 250, method: 'cash', note: 'Part payment' });
  const ft = await one(db, A, `SELECT kind, direction, method, amount::float AS a, sale_id, customer_id, status FROM public.hangtag_fin_txns WHERE id = 'ft:col1'`);
  const cb = await one(db, A, `SELECT entry_type, amount_in::float AS a, status, sale_id FROM public.hangtag_cash_book WHERE fin_txn_id = 'ft:col1'`);
  check('a cash collection posts a "collection" transaction (no bill) and a cash book entry', !r.err && ft && ft.kind === 'collection' && ft.direction === 'in' && ft.a === 250 && ft.sale_id === null && ft.customer_id === 'c1'
    && cb && cb.entry_type === 'collection' && cb.a === 250 && cb.status === 'posted', { r, ft, cb });
  r = await collect(db, A, { id: 'col2', cust: 'c1', amount: 100, method: 'upi' });
  check('UPI without its reference (UTR) is refused', /ref_check/.test(r.err || ''), r.err);
  r = await collect(db, A, { id: 'col2', cust: 'c1', amount: 100, method: 'upi', ref: '412345678999', verification: 'unverified' });
  const bb = await one(db, A, `SELECT entry_type, method, verification, reference, amount_in::float AS a FROM public.hangtag_bank_book WHERE fin_txn_id = 'ft:col2'`);
  check('a UPI collection goes to the bank book, unverified, with its reference', !r.err && bb && bb.entry_type === 'collection' && bb.method === 'upi' && bb.verification === 'unverified' && bb.reference === '412345678999' && bb.a === 100, { r, bb });
  r = await collect(db, A, { id: 'col3', cust: 'c-none', amount: 10, method: 'cash' });
  check('a collection for a customer that isn\'t in the shop is refused', /foreign key|customer_fkey/.test(r.err || ''), r.err);
  r = await collect(db, A, { id: 'col4', cust: 'c1', amount: 0, method: 'cash' });
  check('…and one of ₹0', /check/.test(r.err || ''), r.err);
  r = await tryAs(db, A, `UPDATE public.hangtag_collections SET amount = 1 WHERE id = 'col1'`);
  check('the amount of a collection never changes (not even by the owner)', /permission denied|can't be changed/.test(r.err || ''), r.err);
  r = await tryAs(db, A, `UPDATE public.hangtag_collections SET status = 'cancelled' WHERE id = 'col2' RETURNING id`);
  const cx = await one(db, A, `SELECT (SELECT status FROM public.hangtag_fin_txns WHERE id = 'ft:col2') AS f, (SELECT status FROM public.hangtag_bank_book WHERE fin_txn_id = 'ft:col2') AS b`);
  check('the owner cancels one: its transaction and bank entry are marked cancelled (they leave the balances)', !r.err && r.r.rows.length === 1 && cx.f === 'cancelled' && cx.b === 'cancelled', { r, cx });
  r = await collect(db, CA, { id: 'col5', cust: 'c1', amount: 50, method: 'card', ref: 'APPR77' });
  const c5 = await one(db, A, `SELECT user_id::text AS u, owner_id::text AS o FROM public.hangtag_collections WHERE id = 'col5'`);
  check('a cashier collects (collect_credit): the row is the shop\'s, stamped with the cashier', !r.err && c5.o === A && c5.u === CA.id, { r, c5 });
  r = await tryAs(db, CA, `UPDATE public.hangtag_collections SET status = 'cancelled' WHERE id = 'col5' RETURNING id`);
  check('…but can\'t cancel one (owner only: no row changes)', !r.err && r.r.rows.length === 0, r);
  r = await collect(db, MA, { id: 'col6', cust: 'c1', amount: 10, method: 'cash' });
  check('a role without collect_credit can\'t collect', rls(r), r.err);
  r = await collect(db, SA, { id: 'col7', cust: 'c1', amount: 10, method: 'cash' });
  check('…nor a server', rls(r), r.err);
  const cols = (await rows(db, A, `SELECT * FROM public.hangtag_collections ORDER BY id`)).map(rowToCollection);
  const mine = financialTransactions([], [], [], cols).map((x) => x.id + ':' + x.status).sort().join();
  const theirs = (await rows(db, A, `SELECT id || ':' || status AS k FROM public.hangtag_fin_txns WHERE kind = 'collection' ORDER BY 1`)).map((x) => x.k).join();
  check('the app\'s books (financialTransactions with collections) post the same transactions as the database', mine === theirs && mine.includes('ft:col1:posted'), { mine, theirs });
}

console.log('=== (a) returns refunded to the account ===');
{
  let r = await saveReturn(db, A, 'rd1', 'b2', 500, 'due');
  check('a return on a bill with ₹800 on account refunds ₹500 to the account: saved, no transaction, no book entry', !r.err && (await count(db, A, 'hangtag_fin_txns', `WHERE return_id = 'rd1'`)) === 0, r);
  r = await saveReturn(db, A, 'rd2', 'b2', 400, 'due');
  check('…a second one can\'t take off more than is left on account (₹300)', /at most 300/.test(r.err || ''), r.err);
  r = await saveReturn(db, A, 'rd3', 'b9', 100, 'due');
  check('a bill with nothing on account can\'t be refunded to the account', /at most 0/.test(r.err || ''), r.err);
  r = await saveReturn(db, CA, 'rd4', 'b7', 100, 'due');
  check('a cashier (collect_credit, perform_return) refunds to the account', !r.err, r);
  r = await saveReturn(db, MA, 'rd5', 'b1', 100, 'due');
  check('a role without collect_credit can\'t change what customers owe', /Not allowed to change what customers owe/.test(r.err || ''), r.err);
  r = await saveReturn(db, MA, 'rd6', 'b9', 100, 'cash');
  check('…but refunds by cash as before', !r.err, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, refund_amount, refund_method, value) VALUES ('rd7', 'b1', 1, 10, 'cheque', 10)`);
  check('refund methods are cash, UPI, card or the account', /money_check/.test(r.err || ''), r.err);
}

console.log('=== (b) held bills ===');
{
  const h = heldRow({ id: 'h1', name: 'Asha', data: { cart: [{ v: 'p1:M', q: 2, price: 500 }], disc: null, cust: CUST, note: 'back at 5' }, t: 1790000000000, dev: 'd1' });
  let r = await tryAs(db, CA, `INSERT INTO public.hangtag_held_carts (id, name, data, device_id, t) VALUES ($1, $2, $3, $4, $5) RETURNING owner_id::text AS o, user_id::text AS u`, [h.id, h.name, h.data, h.device_id, h.t]);
  check('a cashier holds a bill (the shop\'s row, stamped with the cashier)', !r.err && r.r.rows[0].o === A && r.r.rows[0].u === CA.id, r);
  check('the owner and the cashier see it; a server, the kitchen and shop B don\'t', (await count(db, A, 'hangtag_held_carts')) === 1 && (await count(db, CA, 'hangtag_held_carts')) === 1
    && (await count(db, SA, 'hangtag_held_carts')) === 0 && (await count(db, KA, 'hangtag_held_carts')) === 0 && (await count(db, B, 'hangtag_held_carts')) === 0 && (await count(db, CB, 'hangtag_held_carts')) === 0);
  r = await tryAs(db, SA, `INSERT INTO public.hangtag_held_carts (id, name, t) VALUES ('h2', 'X', 1)`);
  check('a server (no create_sale) can\'t hold bills', rls(r), r.err);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_held_carts (id, name, t) VALUES ('h3', '  ', 1)`);
  check('a held bill needs a name', /check/.test(r.err || ''), r.err);
  r = await tryAs(db, CB, `DELETE FROM public.hangtag_held_carts WHERE id = 'h1' RETURNING id`);
  check('shop B can\'t recall (remove) A\'s held bill', !r.err && r.r.rows.length === 0 && (await count(db, A, 'hangtag_held_carts')) === 1, r);
  r = await tryAs(db, CA, `DELETE FROM public.hangtag_held_carts WHERE id = 'h1' RETURNING id`);
  check('recalling it on another till removes it', !r.err && r.r.rows.length === 1 && (await count(db, A, 'hangtag_held_carts')) === 0, r);
}

console.log('=== (c) orders: saved all or nothing, one version at a time ===');
{
  const before = (await one(db, A, `SELECT public.hangtag_order_changes() AS c`)).c;
  let r = await saveOrder(db, A, quote());
  const o = await one(db, A, `SELECT version, status, customer_id, (customer ->> 'name') AS cn, valid_until::text AS vu, user_id::text AS u FROM public.hangtag_orders WHERE id = 'q1'`);
  const items = (await rows(db, A, `SELECT * FROM public.hangtag_order_items WHERE order_id = 'q1' ORDER BY line_no`)).map(rowToOrderItem);
  check('a new quotation (version 0 on the phone) is saved as version 1 with its lines (decimal quantity, line discount, GST rate)', !r.err && r.r.rows[0].r.version === 1 && o.version === 1 && o.cn === 'Asha' && o.vu === '2026-10-30'
    && o.u === A && items.length === 2 && items[1].q === 2.5 && items[0].disc.value === 10 && items[0].gst === 5 && items[1].gst === null, { r, o, items });
  const after = (await one(db, A, `SELECT public.hangtag_order_changes() AS c`)).c;
  check('the fingerprint for a member\'s poll moves', before.orders !== after.orders, { before, after });
  const back = rowToOrder(await one(db, A, `SELECT * FROM public.hangtag_orders WHERE id = 'q1'`), items);
  check('it comes back to the app as it went (customer, lines, validity, version)', back.cust.name === 'Asha' && back.items.length === 2 && back.validUntil === '2026-10-30' && back.version === 1 && back.kind === 'quote', back);
  r = await saveOrder(db, A, quote({ status: 'sent', version: 1 }));
  check('saving on version 1 moves it to version 2', !r.err && r.r.rows[0].r.version === 2, r);
  const stale = await saveOrder(db, A, quote({ status: 'accepted', notes: 'Changed on the other till', version: 1 }));
  check('a save from a phone that still had version 1 is refused as changed on another device (40001), not overwritten', stale.code === '40001' && /changed on another device/.test(stale.err || '')
    && (await one(db, A, `SELECT status FROM public.hangtag_orders WHERE id = 'q1'`)).status === 'sent', stale);
  r = await saveOrder(db, A, quote({ status: 'sent', version: 1 }));
  check('…but the very same save sent again (its answer was lost) answers "saved" and changes nothing', !r.err && r.r.rows[0].r.version === 2 && (await one(db, A, `SELECT version FROM public.hangtag_orders WHERE id = 'q1'`)).version === 2, r);
  r = await saveOrder(db, A, quote({ status: 'sent', version: 5 }));
  check('a version from the future is refused too', r.code === '40001', r);
  r = await saveOrder(db, A, quote({ id: 'q-new', status: 'draft', version: 3 }));
  check('an order the cloud never had, sent with a version, is refused (it was removed)', r.code === '40001' && /no longer in the cloud/.test(r.err || ''), r);
  r = await saveOrder(db, A, quote({ kind: 'sales', status: 'draft', version: 2 }));
  check('an order can\'t change its kind', /change its kind/.test(r.err || ''), r.err);
  r = await saveOrder(db, A, quote({ status: 'completed', version: 2 }));
  check('a status of another kind is refused (a quotation is never "completed")', /status_check|can't become completed/.test(r.err || ''), r.err);
  r = await saveOrder(db, A, quote({ items: [], status: 'sent', version: 2 }));
  check('an order needs at least one line', /at least one line/.test(r.err || ''), r.err);
  const badLine = quote({ status: 'sent', version: 2 }); badLine.items[1] = { ...badLine.items[1], q: -1 };
  r = await saveOrder(db, A, badLine);
  check('…and every line a quantity above 0: nothing of the save is kept', /qty_check|check/.test(r.err || '') && (await one(db, A, `SELECT version FROM public.hangtag_orders WHERE id = 'q1'`)).version === 2
    && (await one(db, A, `SELECT qty::float AS q FROM public.hangtag_order_items WHERE order_id = 'q1' AND line_no = 1`)).q === 2.5, r.err);
  r = await saveOrder(db, A, quote({ status: 'cancelled', version: 2 }));
  r = r.err ? r : await saveOrder(db, A, quote({ status: 'draft', version: 3 }));
  check('a cancelled quotation is final: it can\'t be opened again', /cancelled and can't be changed/.test(r.err || ''), r.err);
}

console.log('=== (c) a sales order delivered over two bills ===');
{
  const so = (over = {}) => ({ id: 'so1', kind: 'sales', no: 'SO-260929-ABC001', status: 'confirmed', cust: CUST, billDisc: null, notes: '', validUntil: '', source: 'staff', saleIds: [],
    version: 0, t: 1790000000000, updatedT: 1790000000000, dev: 'd1', items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Tee', vl: 'M', q: 3, price: 450, gst: 0, fq: 0 }], ...over });
  let r = await saveOrder(db, CA, so());
  check('a cashier (create_order) makes a sales order', !r.err && r.r.rows[0].r.version === 1, r);
  r = await saveBills(db, CA, [bill('bo1', 900, () => [{ method: 'cash', amount: 900 }], { order: 'so1' })]);
  r = r.err ? r : await saveOrder(db, CA, so({ status: 'partial', version: 1, saleIds: ['bo1'], items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Tee', vl: 'M', q: 3, price: 450, gst: 0, fq: 2 }] }));
  const x = await one(db, A, `SELECT o.status, o.sale_ids, i.fulfilled_qty::float AS fq, (SELECT order_id FROM public.hangtag_sales WHERE id = 'bo1') AS so FROM public.hangtag_orders o JOIN public.hangtag_order_items i ON i.owner_id = o.owner_id AND i.order_id = o.id WHERE o.id = 'so1'`);
  check('the first bill (order_id so1) delivers 2 of 3: partial, the bill listed', !r.err && x.status === 'partial' && x.fq === 2 && x.sale_ids.includes('bo1') && x.so === 'so1', { r, x });
  r = await saveOrder(db, CA, so({ status: 'partial', version: 2, items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Tee', vl: 'M', q: 3, price: 450, gst: 0, fq: 1 }] }));
  check('what was delivered can\'t go down', /already delivered/.test(r.err || ''), r.err);
  r = await saveOrder(db, CA, so({ status: 'partial', version: 2, items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Tee', vl: 'M', q: 3, price: 450, gst: 0, fq: 4 }] }));
  check('…nor go above what was ordered', /fulfilled_check/.test(r.err || ''), r.err);
  r = await saveOrder(db, CA, so({ status: 'confirmed', version: 2 }));
  check('a partly delivered order can\'t go back to confirmed', /can't become confirmed/.test(r.err || ''), r.err);
  r = await saveOrder(db, CA, so({ status: 'completed', version: 2, saleIds: ['bo1', 'bo2'], items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Tee', vl: 'M', q: 3, price: 450, gst: 0, fq: 3 }] }));
  check('the second bill completes it', !r.err && (await one(db, A, `SELECT status FROM public.hangtag_orders WHERE id = 'so1'`)).status === 'completed', r);
  r = await saveOrder(db, A, so({ status: 'completed', notes: 'late note', version: 3, items: [{ ln: 0, p: 'p1', v: 'p1:M', name: 'Tee', vl: 'M', q: 3, price: 450, gst: 0, fq: 3 }] }));
  check('a completed order is final', /completed and can't be changed/.test(r.err || ''), r.err);
  const audit = await rows(db, A, `SELECT action, entity, entity_id FROM public.hangtag_audit_log WHERE entity = 'orders' AND entity_id = 'so1' ORDER BY id`);
  check('orders added and moved to another status are in the audit log', audit.length >= 3 && audit[0].action === 'insert', audit);
}

console.log('=== (c) who may save and read orders ===');
{
  let r = await saveOrder(db, SA, quote({ id: 'q-server', no: 'QT-2', version: 0 }));
  check('a server (create_order) saves orders', !r.err, r);
  r = await saveOrder(db, KA, quote({ id: 'q-kitchen', no: 'QT-3', version: 0 }));
  check('the kitchen (no create_order) can\'t', r.code === '42501' && /Not allowed to save orders/.test(r.err || ''), r);
  check('…but reads the orders (manage_kitchen), as do the cashier and the server', (await count(db, KA, 'hangtag_orders')) >= 3 && (await count(db, CA, 'hangtag_order_items')) >= 3 && (await count(db, SA, 'hangtag_orders')) >= 3);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_orders (id, kind, status, t) VALUES ('direct', 'quote', 'draft', 1)`);
  const r2 = await tryAs(db, A, `UPDATE public.hangtag_orders SET status = 'accepted' WHERE id = 'q-server'`);
  const r3 = await tryAs(db, A, `DELETE FROM public.hangtag_order_items WHERE order_id = 'q-server'`);
  check('orders are written only through hangtag_save_order (no direct insert, change or removal, not even by the owner)', denied(r) && denied(r2) && denied(r3), { r, r2, r3 });
  r = await tryAs(db, null, `SELECT public.hangtag_save_order('{"id":"x","kind":"quote","status":"draft"}'::jsonb, '[{"line_no":0,"name":"x","qty":1}]'::jsonb)`);
  check('signed out: no orders', !!r.err, r);
  check('shop B (owner or cashier) sees none of A\'s orders, lines, collections or credit', (await count(db, B, 'hangtag_orders')) === 0 && (await count(db, CB, 'hangtag_order_items')) === 0
    && (await count(db, B, 'hangtag_collections')) === 0 && (await count(db, CB, 'hangtag_fin_txns', `WHERE kind = 'collection'`)) === 0);
  r = await saveOrder(db, B, quote());
  const both = (await db.query(`SELECT owner_id::text AS o, version FROM public.hangtag_orders WHERE id = 'q1' ORDER BY owner_id`)).rows;
  check('B saving an order with the same id makes B\'s own (A\'s untouched)', !r.err && both.length === 2 && both.find((x) => x.o === B).version === 1 && both.find((x) => x.o === A).version === 3, { r, both });
  r = await saveOrder(db, CB, quote({ status: 'sent', version: 3 }));
  check('B\'s cashier can\'t reach A\'s version of it (conflict on B\'s own, version 1)', r.code === '40001', r);
}

console.log('=== the report after all of it ===');
{
  const rep = await report(db);
  check('every row ok (credit bills for saved customers, collections posted, refunds to the account within the bill, bills from orders that exist, orders with lines)', rep.length === 40 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
  await db.query(`UPDATE public.hangtag_sales SET order_id = 'missing' WHERE id = 'b9'`);
  const bad = (await report(db)).find((x) => /made from an order/.test(x.check_name));
  check('…and a bill pointing at an order that doesn\'t exist shows up', bad && !bad.ok, bad);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
