// Section 3h of schema.sql: verified payments (only with a verified provider intent of the same shop, method and amount;
// never downgraded when the phone uploads the bill again), payment intents and invoice links written only by the Edge
// Functions, automatic receipts once per bill and channel, cash entries that can't be changed (a reversal once, for the
// whole entry), day closes, the reason a bill was cancelled, and each shop seeing only its own. PGlite with Supabase
// stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs, cashMoveRow, dayCloseRow } from '../../src/infrastructure/supabase/mappers.js';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const I1 = '0b8e1f3e-1111-4111-8111-111111111111', I2 = '0b8e1f3e-2222-4222-8222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id), provider text, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;`;
async function as(db, uid, sql, params) {
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
/* the Edge Functions' service-role key: past row security, still bound by the checks and triggers */
async function asService(db, sql, params) { await db.exec('SET ROLE service_role'); try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); } }
const tryAs = async (db, uid, sql, params) => { try { return { r: await as(db, uid, sql, params) }; } catch (e) { return { err: e.message }; } };
const trySvc = async (db, sql, params) => { try { return { r: await asService(db, sql, params) }; } catch (e) { return { err: e.message }; } };
const rows = async (db, uid, sql) => (await as(db, uid, sql)).rows;
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;

function bill(id, price, pays) {
  const T = computeCheckout({ lines: [{ q: 1, price, rate: 0 }], billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, pays(T.total));
  if (S.error) throw new Error(S.error);
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: [{ ln: 0, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: 1, price, cost: null, dAmt: 0, bdAmt: 0, gst: 0, hsn: '6109', tx: price, cgst: 0, sgst: 0, igst: 0, lt: price }],
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: S.payments.length > 1 ? 'split' : S.payments[0].method, payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
const save = (db, uid, bills) => tryAs(db, uid, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(bills.map(billArgs))]);
const intent = (db, owner, id, status, amount, extra = {}) => asService(db, `INSERT INTO public.hangtag_payment_intents (id, owner_id, client_sale_id, amount, method, kind, provider, provider_intent_id, provider_payment_id, reference, status, paid_amount)
  VALUES ($1,$2,$3,$4,$5,$6,'razorpay',$7,$8,$7,$9,$10)`, [id, owner, extra.sale || null, amount, extra.method || 'upi', extra.kind || 'qr', extra.pid || 'qr_' + id.slice(0, 8), extra.pay || null, status, status === 'verified' || status === 'unmatched' ? amount : null]);

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
await db.exec(NEW); await db.exec(NEW);
console.log('=== schema runs twice; report ===');
{
  const rep = await report(db);
  check('migration report: 65 rows, all ok on an empty shop', rep.length === 65 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
}

console.log('=== verified payments ===');
{
  const upi = (id) => bill(id, 500, (d) => [{ method: 'upi', amount: d, via: 'qr', intent: { id: I1, status: 'verified', amount: d, paymentId: 'pay_1' } }]);
  let r = await save(db, A, [upi('v1')]);
  check('a bill claiming a verified payment with no verified intent is refused', /not confirmed/.test(r.err || ''), r);
  await intent(db, A, I1, 'pending', 500, { sale: 'v1' });
  r = await save(db, A, [upi('v1')]);
  check('…also while the intent is only pending', /not confirmed/.test(r.err || ''), r);
  await asService(db, `UPDATE public.hangtag_payment_intents SET status = 'verified', paid_amount = 500, provider_payment_id = 'pay_1' WHERE id = $1`, [I1]);
  r = await save(db, A, [upi('v1')]);
  const p = (await rows(db, A, `SELECT verification, via, intent_id::text, provider_payment_id, reference FROM public.hangtag_payments WHERE id = 'v1:upi'`))[0];
  check('with the provider\'s verified intent the bill saves; the payment is verified with the provider\'s id', !r.err && p.verification === 'verified' && p.via === 'qr' && p.intent_id === I1 && p.provider_payment_id === 'pay_1', { r, p });
  const bb = (await rows(db, A, `SELECT verification FROM public.hangtag_bank_book WHERE sale_id = 'v1'`))[0];
  check('the bank book entry says verified', bb && bb.verification === 'verified', bb);
  r = await save(db, A, [bill('v2', 500, (d) => [{ method: 'upi', amount: d, via: 'qr', intent: { id: I1, status: 'verified', amount: d, paymentId: 'pay_1' } }])]);
  check('one provider payment can\'t pay two bills', /duplicate|unique/i.test(r.err || ''), r);
  await intent(db, B, I2, 'verified', 500, { pay: 'pay_b' });
  r = await save(db, A, [bill('v3', 500, (d) => [{ method: 'upi', amount: d, via: 'qr', intent: { id: I2, status: 'verified', amount: d, paymentId: 'pay_b' } }])]);
  check('another shop\'s verified intent doesn\'t verify this shop\'s bill', /not confirmed/.test(r.err || ''), r);
  // UPI checked by hand, then matched by the function (service role), then the phone uploads the bill again
  r = await save(db, A, [bill('m1', 700, (d) => [{ method: 'upi', amount: d, ref: '412345678901', confirmed: true }])]);
  check('hand-checked UPI saves as unverified with its reference', !r.err && (await rows(db, A, `SELECT verification FROM public.hangtag_payments WHERE id = 'm1:upi'`))[0].verification === 'unverified', r);
  const IM = '0b8e1f3e-3333-4333-8333-333333333333';
  await intent(db, A, IM, 'verified', 700, { kind: 'match', pid: 'pay_m', pay: 'pay_m', sale: 'm1' });
  r = await trySvc(db, `UPDATE public.hangtag_payments SET verification = 'verified', intent_id = $1, provider_payment_id = 'pay_m' WHERE owner_id = $2 AND id = 'm1:upi'`, [IM, A]);
  check('the function upgrades it to verified after matching the provider\'s payment', !r.err, r);
  r = await save(db, A, [bill('m1', 700, (d) => [{ method: 'upi', amount: d, ref: '412345678901', confirmed: true }])]);
  const m = (await rows(db, A, `SELECT verification, intent_id::text, provider_payment_id FROM public.hangtag_payments WHERE id = 'm1:upi'`))[0];
  check('the phone uploading the bill again never downgrades a verified payment', !r.err && m.verification === 'verified' && m.intent_id === IM && m.provider_payment_id === 'pay_m', { r, m });
  r = await save(db, A, [bill('c1', 800, (d) => [{ method: 'card', amount: d, ref: 'APPR1', last4: '4242' }])]);
  const c = (await rows(db, A, `SELECT verification, via, card_last4 FROM public.hangtag_payments WHERE id = 'c1:card'`))[0];
  check('card machine: recorded, with the last 4 digits only', !r.err && c.verification === 'recorded' && c.via === 'terminal' && c.card_last4 === '4242', { r, c });
  r = await tryAs(db, A, `UPDATE public.hangtag_payments SET card_last4 = '4242424242424242' WHERE id = 'c1:card'`);
  check('the database refuses a full card number', /verification_check/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_payments SET verification = 'verified' WHERE id = 'c1:card'`);
  check('the app cannot mark a payment verified by itself', /verification_check|not confirmed/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_payments SET verification = 'verified', intent_id = $1 WHERE id = 'c1:card'`, [I2]);
  check('…not even by pointing at an intent (another shop, another method or amount)', /not confirmed|duplicate|unique/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_payments SET verification = 'unverified' WHERE id = 'c1:card'`);
  check('only UPI can be unverified', /verification_check/.test(r.err || ''), r);
}

console.log('=== payment intents and invoice links: written by the functions only ===');
{
  let r = await tryAs(db, A, `INSERT INTO public.hangtag_payment_intents (id, owner_id, amount, method, provider, provider_intent_id, reference, status, paid_amount) VALUES (gen_random_uuid(), $1, 1, 'upi', 'razorpay', 'x', 'x', 'verified', 1)`, [A]);
  check('the app can\'t write an intent (so it can\'t make a payment verified)', /permission denied/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_payment_intents SET status = 'verified' WHERE id = $1`, [I1]);
  check('…nor change one', /permission denied/.test(r.err || ''), r);
  check('the shop reads its own intents only', (await rows(db, A, `SELECT id FROM public.hangtag_payment_intents`)).every((x) => x.id !== I2) && (await rows(db, B, `SELECT id::text FROM public.hangtag_payment_intents`)).map((x) => x.id).join() === I2);
  r = await trySvc(db, `INSERT INTO public.hangtag_payment_intents (id, owner_id, amount, method, provider, provider_intent_id, reference, status) VALUES (gen_random_uuid(), $1, 1, 'upi', 'razorpay', 'y', 'y', 'verified')`, [A]);
  check('verified or unmatched needs the amount received', /state_check/.test(r.err || ''), r);
  r = await trySvc(db, `INSERT INTO public.hangtag_payment_intents (id, owner_id, amount, method, provider, provider_intent_id, reference, status) VALUES (gen_random_uuid(), $1, 1, 'upi', 'stripe', 'z', 'z', 'pending')`, [A]);
  check('only the configured provider', /state_check/.test(r.err || ''), r);
  const tok = 'T'.repeat(43);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_invoice_links (token, owner_id, sale_id, expires_at) VALUES ($1, $2, 'v1', now() + interval '1 year')`, [tok, A]);
  check('the app can\'t make an invoice link', /permission denied/.test(r.err || ''), r);
  await asService(db, `INSERT INTO public.hangtag_invoice_links (token, owner_id, sale_id, expires_at) VALUES ($1, $2, 'v1', now() + interval '1 year')`, [tok, A]);
  r = await tryAs(db, A, `UPDATE public.hangtag_invoice_links SET revoked_at = now() WHERE sale_id = 'v1'`);
  check('the shop can revoke its link', !r.err && (await rows(db, A, `SELECT revoked_at FROM public.hangtag_invoice_links`))[0].revoked_at, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_invoice_links SET expires_at = now() + interval '10 years'`);
  check('…but not lengthen it or change anything else', /permission denied/.test(r.err || ''), r);
  check('another shop sees none of its links', (await rows(db, B, `SELECT token FROM public.hangtag_invoice_links`)).length === 0);
  r = await trySvc(db, `INSERT INTO public.hangtag_invoice_links (token, owner_id, sale_id, expires_at) VALUES ('short', $1, 'v1', now())`, [A]);
  check('tokens must be long and URL-safe', /check/.test(r.err || ''), r);
}

console.log('=== automatic receipts: once per bill and channel ===');
{
  const ins = (mode, status) => trySvc(db, `INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, mode, provider_message_id) VALUES ($1,'v1','sms','+919876543210',$2,'twilio',$3,$4)`, [A, status, mode, status === 'pending' ? null : 'SM' + Math.random()]);
  let r = await ins('auto', 'pending');
  check('the first automatic SMS takes its place', !r.err, r);
  r = await ins('auto', 'pending');
  check('a second automatic SMS for the same bill is refused', /hangtag_deliveries_auto_once/.test(r.err || ''), r);
  await asService(db, `UPDATE public.hangtag_deliveries SET status = 'failed', error = 'x' WHERE sale_id = 'v1' AND mode = 'auto'`);
  r = await ins('auto', 'pending');
  check('after a failed attempt it can be tried again', !r.err, r);
  r = await ins('manual', 'sent');
  check('a manual send is always allowed', !r.err, r);
  r = await trySvc(db, `UPDATE public.hangtag_deliveries SET status = 'delivered', delivered_at = now() WHERE sale_id = 'v1' AND mode = 'manual'`);
  check('the provider\'s "delivered" is kept', !r.err, r);
}

console.log('=== cash entries, reversals, day closes ===');
{
  const mv = (m) => tryAs(db, A, `INSERT INTO public.hangtag_cash_moves (id, type, amount, reason, category, reverses, t, device_id, event_id) SELECT id, type, amount, reason, category, reverses, t, device_id, event_id FROM jsonb_populate_record(NULL::public.hangtag_cash_moves, $1::jsonb)`, [JSON.stringify(cashMoveRow(m))]);
  let r = await mv({ id: 'cm1', type: 'expense', amount: 200, reason: 'Lunch', category: 'Food', t: 1, dev: 'd1' });
  check('an expense is added', !r.err, r);
  r = await mv({ id: 'cm2', type: 'expense', amount: 200, reason: 'Lunch', t: 1, dev: 'd1' });
  check('an expense needs its category', /kind_check/.test(r.err || ''), r);
  r = await mv({ id: 'cm3', type: 'out', amount: 100, reason: 'x', t: 1, dev: 'd1' });
  check('a reason of at least 3 characters', /check/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_cash_moves SET amount = 1 WHERE id = 'cm1'`);
  check('an entry can\'t be changed', /permission denied/.test(r.err || ''), r);
  r = await tryAs(db, A, `DELETE FROM public.hangtag_cash_moves WHERE id = 'cm1'`);
  check('…nor deleted', /permission denied/.test(r.err || ''), r);
  r = await mv({ id: 'rv1', type: 'reversal', amount: 150, reason: 'Wrong amount', reverses: 'cm1', t: 2, dev: 'd1' });
  check('a reversal must be for the whole entry', /whole of an entry/.test(r.err || ''), r);
  r = await mv({ id: 'rv1', type: 'reversal', amount: 200, reason: 'Paid by owner', reverses: 'cm1', t: 2, dev: 'd1' });
  check('a reversal for the whole entry is added', !r.err, r);
  r = await mv({ id: 'rv2', type: 'reversal', amount: 200, reason: 'Again', reverses: 'cm1', t: 3, dev: 'd1' });
  check('an entry is reversed once only', /reversed_once|duplicate|unique/i.test(r.err || ''), r);
  r = await mv({ id: 'rv3', type: 'reversal', amount: 200, reason: 'Undo undo', reverses: 'rv1', t: 3, dev: 'd1' });
  check('a reversal isn\'t reversed', /whole of an entry/.test(r.err || ''), r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_cash_moves (id, type, amount, reason, t) VALUES ('cm1','in',5,'dup',1) ON CONFLICT DO NOTHING`);
  check('uploading the same entry again changes nothing', !r.err && +(await rows(db, A, `SELECT amount FROM public.hangtag_cash_moves WHERE id = 'cm1'`))[0].amount === 200, r);
  check('another shop sees none of these entries', (await rows(db, B, `SELECT id FROM public.hangtag_cash_moves`)).length === 0);
  const dc = (c) => tryAs(db, A, `INSERT INTO public.hangtag_day_closes (id, day, scope, expected, counted, difference, note, t, device_id) SELECT id, day, scope, expected, counted, difference, note, t, device_id FROM jsonb_populate_record(NULL::public.hangtag_day_closes, $1::jsonb)
    ON CONFLICT (owner_id, id) DO UPDATE SET counted = EXCLUDED.counted, difference = EXCLUDED.difference, expected = EXCLUDED.expected`, [JSON.stringify(dayCloseRow(c))]);
  r = await dc({ id: 'dc:2026-09-28:shop', day: '2026-09-28', scope: 'shop', expected: 1700, counted: 1650, diff: -50, note: 'short', t: 1, dev: 'd1' });
  check('a day close is saved', !r.err, r);
  r = await dc({ id: 'dc:2026-09-28:shop', day: '2026-09-28', scope: 'shop', expected: 1700, counted: 1700, diff: 0, note: '', t: 2, dev: 'd1' });
  check('closing the day again replaces it', !r.err && +(await rows(db, A, `SELECT difference FROM public.hangtag_day_closes`))[0].difference === 0, r);
  r = await dc({ id: 'dc:2026-09-29:shop', day: '2026-09-29', scope: 'shop', expected: 100, counted: 50, diff: 10, note: '', t: 2, dev: 'd1' });
  check('the difference must be counted − expected', /diff_check/.test(r.err || ''), r);
}

console.log('=== cancelling with a reason ===');
{
  let r = await tryAs(db, A, `UPDATE public.hangtag_sales SET void_reason = 'Duplicate bill' WHERE id = 'c1'`);
  check('a reason only on a cancelled bill', /void_reason_check/.test(r.err || ''), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_sales SET is_void = true, void_reason = 'Duplicate bill' WHERE id = 'c1'`);
  check('cancelled with its reason', !r.err, r);
  r = await save(db, A, [{ ...bill('c1', 800, (d) => [{ method: 'card', amount: d, ref: 'APPR1', last4: '4242' }]), void: true }]);
  check('the phone uploading the cancelled bill again keeps the reason', !r.err && (await rows(db, A, `SELECT void_reason FROM public.hangtag_sales WHERE id = 'c1'`))[0].void_reason === 'Duplicate bill', r);
  r = await save(db, A, [bill('c1', 800, (d) => [{ method: 'card', amount: d, ref: 'APPR1', last4: '4242' }])]);
  check('restored: the reason is cleared', !r.err && (await rows(db, A, `SELECT is_void, void_reason FROM public.hangtag_sales WHERE id = 'c1'`))[0].void_reason === null, r);
}

console.log('=== report after use ===');
{
  const rep = await report(db);
  check('migration report: every row ok with verified payments, automatic receipts and reversals present', rep.every((r) => r.ok) && rep.find((r) => r.check_name.startsWith('Verified payments')).expected >= 2
    && rep.find((r) => r.check_name.startsWith('Cash reversals')).expected === 1, rep.filter((r) => !r.ok || /Verified|Automatic|Cash/.test(r.check_name)));
}
await db.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
if (fails) process.exit(1);
