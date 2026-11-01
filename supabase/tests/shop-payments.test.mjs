// The shop payments migration (supabase/migrations/20261023120000_hangtag_shop_payments.sql) in the runbook's order, on a
// database built like the live project (the section files of 2026-10-13 over schema.sql, then the repair):
// - before the repair, or with a shop table open to every account, it refuses and changes nothing; after, it applies, and
//   again (also after the post-repair migration); its report and the read-only check agree, all ok; after a run of
//   schema.sql the check says so until it is run again;
// - accounts: no app account reads or writes them; only sealed secrets; one connected account per shop; the key decides
//   test or live;
// - intents: a new one names an account of its own shop (another shop's is refused); older ones stay as they were;
// - notifications: once per account and event; read by the shop's owner and who sees the books, by nobody else;
// - UPI paid to the shop's own QR: a phone can't upload it recorded or confirmed; only the owner or who sees the books
//   confirms it (never a cashier or another shop), once, with who and when (audit log, bank book); a bill sent again —
//   from the owner's phone or a team member's — never undoes it; a changed amount needs confirming again; card, cash
//   and cancelled bills aren't confirmed; a payment saved before verification was kept stays as it was;
// - every shop table, the new ones included, closed to other shops, outsiders and the signed-out;
// - the undo removes the behaviour and keeps every row.
// Run: node supabase/tests/shop-payments.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs } from '../../src/infrastructure/supabase/mappers.js';
import { readLeaks, shopTables, writeLeaks } from '../../tests/helpers/tenancy.mjs';

const at = (p) => new URL(p, import.meta.url);
const read = (p) => fs.readFileSync(at(p), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
const SCHEMA = read('../schema.sql'), MIG = read('../migrations/20261023120000_hangtag_shop_payments.sql');
const POST = read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'), CHECK = read('../checks/shop-payments-report.sql');
const UNDO = read('../operations/shop-payments-undo.sql');
const SECTIONS = fs.readdirSync(at('../migrations/')).filter((f) => /^202610\d{8}_.+\.sql$/.test(f) && f.slice(0, 14) <= '20261013120000').sort().reverse();
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', OUT = '33333333-3333-3333-3333-333333333333';
const CASHIER = '44444444-4444-4444-4444-444444444444', MANAGER = '55555555-5555-5555-5555-555555555555';
const KEY = { [CASHIER]: 'cashier-phone-key-0123456789abcdef', [MANAGER]: 'manager-phone-key-0123456789abcdef' };

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.test'),($2,'b@x.test'),($3,'out@x.test'),($4,'cash@x.test'),($5,'mgr@x.test')`, [A, B, OUT, CASHIER, MANAGER]);
await db.exec(SCHEMA);
/* as the database itself (the SQL Editor, a migration): no signed-in user */
const sql = async (q, p) => { await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`); return (await db.query(q, p)).rows; };
const tryExec = async (q) => { try { await db.exec(q); return { ok: true }; } catch (e) { return { err: e.message }; } };
/* as a person (their enrolled phone for a team member), the service role, or signed out */
async function as(who, q, p) {
  await db.exec(`SET ROLE ${who === 'service' ? 'service_role' : who ? 'authenticated' : 'anon'}`);
  const headers = { authorization: 'Bearer x', ...(KEY[who] ? { 'x-hangtag-device': KEY[who] } : {}) };
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who && who !== 'service' ? who : '', JSON.stringify(headers)]);
  try { return (await db.query(q, p)).rows; } catch (e) { return { err: e.message }; } finally { await db.exec('RESET ROLE'); }
}
const report = async () => (await db.exec(CHECK)).at(-1).rows;

console.log('=== only after the repair, never on a database open across shops ===');
for (const f of SECTIONS) await db.exec(read(`../migrations/${f}`));
let r = await tryExec(MIG);
check('on the live project as it is (the 2026-10-13 section files over schema.sql): refused — "run the database repair first" — and nothing changed',
  /Run the database repair first/.test(r.err || '') && (await sql(`SELECT to_regclass('public.hangtag_payment_accounts') IS NULL AS none`))[0].none, r);
await db.exec(SCHEMA);   // the repair
// an intent from before the migration (an older build's): it has no account and stays as it was
await sql(`INSERT INTO public.hangtag_payment_intents (id, owner_id, amount, method, kind, provider, provider_intent_id, reference, status) VALUES ('0c000000-0000-4000-8000-000000000001', $1, 100, 'upi', 'qr', 'razorpay', 'qr_old', 'qr_old', 'pending')`, [A]);
await db.exec(`CREATE POLICY "Public access to hangtag_sales" ON public.hangtag_sales FOR SELECT USING (true)`);
r = await tryExec(MIG);
check('repaired, but a shop table open to every account (an always-true policy): refused, nothing changed',
  /open to every account/.test(r.err || '') && (await sql(`SELECT to_regclass('public.hangtag_payment_accounts') IS NULL AS none`))[0].none, r);
await db.exec(`DROP POLICY "Public access to hangtag_sales" ON public.hangtag_sales`);
// its report refuses to commit: one of its own steps left out (the plan-ended guard on the notifications), so row 7 is
// false — the whole script, run as one statement as the SQL Editor does, leaves nothing behind
const SABOTAGED = MIG.replace(/CREATE TRIGGER zz_hangtag_subscription_guard BEFORE INSERT OR UPDATE OR DELETE ON public\.hangtag_payment_events[^\n]*\n/, '');
r = SABOTAGED === MIG ? { err: 'the step to leave out was not found' } : await tryExec(SABOTAGED);
check('a run whose report isn\'t all ok: "report not ok" naming the row, and nothing of it committed',
  /report not ok: The new tables wait/.test(r.err || '') && (await sql(`SELECT to_regclass('public.hangtag_payment_accounts') IS NULL AS none`))[0].none
  && !(await sql(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'hangtag_keep_payment_state'`))[0].n, r);
r = await tryExec(MIG);
const r2 = await tryExec(MIG);
check('repaired and closed: it applies, and again (nothing changes the second time)', r.ok && r2.ok, { r, r2 });
let rep = await report();
check('the read-only check: 7 rows, all ok', rep.length === 7 && rep.every((x) => x.ok), rep);
const names = (s) => [...s.matchAll(/SELECT \d+(?: AS n)?, '((?:[^']|'')+)'/g)].map((m) => m[1]);
check('…the same rows, in the same words, as the migration\'s own report', JSON.stringify(names(CHECK)) === JSON.stringify(names(MIG.slice(MIG.indexOf('DO $report$')))) && names(CHECK).length === 7,
  { check: names(CHECK), mig: names(MIG.slice(MIG.indexOf('DO $report$'))) });
r = await tryExec(POST);
const r3 = await tryExec(MIG);
check('the post-repair migration after it, and this one again after that: both apply, the check still all ok', r.ok && r3.ok && (await report()).every((x) => x.ok), { r, r3 });
await db.exec(SCHEMA);
rep = await report();
check('after a run of schema.sql the check says so (row 5: section 3h\'s older rule is back) …', rep.find((x) => x.check_name.startsWith('UPI confirmed')).ok === false, rep);
await db.exec(MIG);
check('… and the migration run again puts it right', (await report()).every((x) => x.ok));
const old = await as('service', `UPDATE public.hangtag_payment_intents SET status = 'expired' WHERE id = '0c000000-0000-4000-8000-000000000001' RETURNING status`);
check('an intent from before the migration (no account) is left as it was, and can still be updated', old[0] && old[0].status === 'expired', old);

console.log('=== the shop\'s own payment account ===');
const box = 'v1.' + 'A'.repeat(16) + '.' + 'B'.repeat(40);
const acct = (owner, id, extra = {}) => as('service', `INSERT INTO public.hangtag_payment_accounts (id, owner_id, provider, mode, key_id, secret_box, webhook_box, hook_id, status)
  VALUES ($1, $2, 'razorpay', $3, $4, $5, $6, $7, 'connected') RETURNING id`, [id, owner, extra.mode || 'test', extra.key || 'rzp_test_Shop' + id.slice(0, 4), extra.secret ?? box, extra.hook ?? box, extra.hookId || crypto.randomBytes(32).toString('base64url')]);
const ACC_A = 'aaaa0000-0000-4000-8000-00000000000a', ACC_B = 'bbbb0000-0000-4000-8000-00000000000b';
r = await acct(A, ACC_A);
check('the payment-gateway function (service role) keeps a shop\'s account with its sealed secrets', r[0] && r[0].id === ACC_A, r);
r = await acct(A, 'aaaa0000-0000-4000-8000-00000000000c');
check('one connected account per shop', /duplicate key|unique/.test(r.err || ''), r);
r = await acct(B, 'bbbb0000-0000-4000-8000-00000000000d', { secret: 'BBsecretBBsecretBBsecret' });
check('a secret that isn\'t sealed can\'t be stored (only "v1.<iv>.<ciphertext>")', /hangtag_payment_accounts_check/.test(r.err || ''), r);
r = await acct(B, 'bbbb0000-0000-4000-8000-00000000000d', { key: 'rzp_live_ShopBbbb', mode: 'test' });
check('the key decides test or live (a live key can\'t be kept as test)', /hangtag_payment_accounts_check/.test(r.err || ''), r);
await acct(B, ACC_B);
for (const [label, who] of [['the shop\'s owner', A], ['another shop\'s owner', B], ['signed out', null]]) {
  const sel = await as(who, `SELECT count(*)::int n FROM public.hangtag_payment_accounts`);
  const ins = await as(who, `INSERT INTO public.hangtag_payment_accounts (id, owner_id, provider, mode, key_id, secret_box, webhook_box, hook_id) VALUES (gen_random_uuid(), $1, 'razorpay', 'test', 'rzp_test_Forged01', $2, $2, $3)`, [A, box, 'f'.repeat(43)]);
  const upd = await as(who, `UPDATE public.hangtag_payment_accounts SET status = 'disconnected'`);
  check(`${label}: can't read, add or change any payment account (no privilege at all)`, /permission denied/.test(sel.err || '') && /permission denied/.test(ins.err || '') && /permission denied/.test(upd.err || ''), { sel, ins, upd });
}

console.log('=== intents name an account of their own shop ===');
const intent = (owner, id, account, extra = {}) => as('service', `INSERT INTO public.hangtag_payment_intents (id, owner_id, account_id, client_sale_id, amount, method, kind, provider, provider_intent_id, provider_payment_id, reference, status, paid_amount)
  VALUES ($1, $2, $3, $4, $5, 'upi', $6, 'razorpay', $7, $8, $7, $9, $10) RETURNING id`, [id, owner, account, extra.sale || null, extra.amount || 500, extra.kind || 'qr', extra.pid || 'qr_' + id.slice(0, 8), extra.pay || null, extra.status || 'pending', extra.status === 'verified' ? extra.amount || 500 : null]);
r = await intent(A, '0c000000-0000-4000-8000-000000000002', null);
check('a new intent naming no account is refused', /names none/.test(r.err || ''), r);
r = await intent(A, '0c000000-0000-4000-8000-000000000003', ACC_B);
check('…as is one naming another shop\'s account', /foreign key|violates/.test(r.err || ''), r);
r = await intent(A, '0c000000-0000-4000-8000-000000000004', ACC_A, { sale: 'v1', status: 'verified', pay: 'pay_v1' });
check('one on the shop\'s own account is kept', r[0] && r[0].id === '0c000000-0000-4000-8000-000000000004', r);
r = await as(A, `INSERT INTO public.hangtag_payment_intents (id, owner_id, account_id, amount, method, provider, provider_intent_id, reference, status, paid_amount) VALUES (gen_random_uuid(), $1, $2, 1, 'upi', 'razorpay', 'x', 'x', 'verified', 1)`, [A, ACC_A]);
check('the app still can\'t write an intent', /permission denied/.test(r.err || ''), r);

console.log('=== the provider\'s notifications ===');
// shop A's team: a cashier and a manager on their enrolled phones
for (const [id, role, user] of [[CASHIER, 'cashier', 'cash1'], [MANAGER, 'manager', 'mgr1']]) {
  await sql(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1,$2,$3,$4,$5,'active',$2)`, [id, A, role, user, role]);
  await sql(`INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1,$2,$3,'Phone','Android',$4)`, [A, 'dev-' + role, id, crypto.createHash('sha256').update(KEY[id]).digest('hex')]);
}
const ev = (owner, account, eventId) => as('service', `INSERT INTO public.hangtag_payment_events (owner_id, account_id, event_id, event, outcome) VALUES ($1, $2, $3, 'qr_code.credited', 'changed') RETURNING id`, [owner, account, eventId]);
r = await ev(A, ACC_A, 'evt_1');
const dup = await ev(A, ACC_A, 'evt_1');
check('a notification is kept once per account and event id', r[0] && /duplicate key|unique/.test(dup.err || ''), { r, dup });
r = await ev(A, ACC_B, 'evt_2');
check('…and under its own shop\'s account only', /foreign key|violates/.test(r.err || ''), r);
await ev(B, ACC_B, 'evt_1');
const seen = async (who) => { const x = await as(who, `SELECT count(*)::int n FROM public.hangtag_payment_events WHERE owner_id = $1`, [A]); return x.err ? -1 : x[0].n; };
check('shop A\'s history: its owner and its manager read it; its cashier, shop B and the signed-out see none of it',
  (await seen(A)) === 1 && (await seen(MANAGER)) === 1 && (await seen(CASHIER)) === 0 && (await seen(B)) === 0 && (await seen(null)) <= 0, { a: await seen(A), m: await seen(MANAGER), c: await seen(CASHIER), b: await seen(B) });
r = await as(A, `INSERT INTO public.hangtag_payment_events (owner_id, account_id, event_id, event) VALUES ($1, $2, 'evt_forged', 'qr_code.credited')`, [A, ACC_A]);
check('no app account writes a notification', /permission denied/.test(r.err || ''), r);

console.log('=== UPI paid to the shop\'s own QR: unverified until the shop confirms it ===');
function bill(id, price, pays, extra = {}) {
  const T = computeCheckout({ lines: [{ q: 1, price, rate: 0 }], billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, pays(T.total));
  if (S.error) throw new Error(S.error);
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: [{ ln: 0, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: 1, price, cost: null, dAmt: 0, bdAmt: 0, gst: 0, hsn: '6109', tx: price, cgst: 0, sgst: 0, igst: 0, lt: price }],
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: S.payments.length > 1 ? 'split' : S.payments[0].method, payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })), ...extra };
}
const save = async (who, bills, tweak = (x) => x) => as(who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify(bills.map(billArgs).map(tweak))]);
const upiByHand = (d) => [{ method: 'upi', amount: d, ref: '412345678901', confirmed: true }];
const pay = async (id) => (await sql(`SELECT verification, confirmed_by::text, confirmed_at, amount FROM public.hangtag_payments WHERE owner_id = $1 AND id = $2`, [A, id]))[0];
r = await save(A, [bill('u1', 700, upiByHand)]);
check('UPI checked by hand saves as unverified', !r.err && (await pay('u1:upi')).verification === 'unverified', r);
const forge = (v) => (a) => ({ ...a, p_payments: (a.p_payments || []).map((p) => ({ ...p, verification: v })) });
const claims = (bills) => bills.map(billArgs).map((a) => JSON.stringify(a));
const argsWith = (b, v) => { const a = billArgs(b); for (const k of Object.keys(a)) if (Array.isArray(a[k])) a[k] = a[k].map((p) => (p && p.method === 'upi' ? { ...p, verification: v } : p)); return a; };
r = await as(A, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([argsWith(bill('u2', 300, upiByHand), 'recorded'), argsWith(bill('u3', 400, upiByHand), 'confirmed')])]);
check('a phone uploading hand-checked UPI as "recorded" or "confirmed": saved, but unverified', !r.err && (await pay('u2:upi')).verification === 'unverified' && (await pay('u3:upi')).verification === 'unverified', { r, u2: await pay('u2:upi'), u3: await pay('u3:upi') });
r = await as(A, `UPDATE public.hangtag_payments SET verification = 'confirmed', confirmed_at = NOW(), confirmed_by = $1 WHERE id = 'u1:upi' RETURNING verification`, [A]);
check('the owner\'s app setting "confirmed" on the row itself: it stays unverified (only the confirmation function confirms)', (r[0] || {}).verification === 'unverified' && (await pay('u1:upi')).verification === 'unverified', r);
const confirm = (who, id) => as(who, `SELECT public.hangtag_confirm_upi_payment($1) AS r`, [id]);
r = await confirm(CASHIER, 'u1:upi');
check('a cashier can\'t confirm (the one who took it isn\'t the one who checks the bank)', /Only the owner, or a role that sees the books/.test(r.err || '') && (await pay('u1:upi')).verification === 'unverified', r);
r = await confirm(B, 'u1:upi');
check('another shop\'s owner: not found (its own shop has no such payment), nothing changes', r[0] && r[0].r.status === 'not_found' && (await pay('u1:upi')).verification === 'unverified', r);
r = await confirm(null, 'u1:upi');
check('signed out: refused', !!r.err, r);
r = await confirm(MANAGER, 'u1:upi');
let p1 = await pay('u1:upi');
check('the manager (sees the books) confirms it: confirmed, by the manager, with the time', r[0] && r[0].r.status === 'confirmed' && p1.verification === 'confirmed' && p1.confirmed_by === MANAGER && !!p1.confirmed_at && r[0].r.confirmedAt > 0, { r, p1 });
r = await confirm(A, 'u1:upi');
check('confirming again: already confirmed, by whom it was', r[0] && r[0].r.already === true && r[0].r.status === 'confirmed' && r[0].r.confirmedBy === MANAGER, r);
const bb = (await sql(`SELECT verification FROM public.hangtag_bank_book WHERE owner_id = $1 AND sale_id = 'u1'`, [A]))[0];
check('the bank book entry says confirmed', bb && bb.verification === 'confirmed', bb);
const audit = await sql(`SELECT count(*)::int n FROM public.hangtag_audit_log WHERE owner_id = $1 AND entity = 'payments' AND entity_id = 'u1:upi' AND user_id = $2`, [A, MANAGER]).catch(() => [{ n: -1 }]);
check('the audit log keeps the change, by the manager', audit[0].n >= 1, audit);
r = await save(A, [bill('u1', 700, upiByHand)]);
p1 = await pay('u1:upi');
check('the owner\'s phone sending the bill again (as it knew it: unverified): still confirmed, by the manager', !r.err && p1.verification === 'confirmed' && p1.confirmed_by === MANAGER, { r, p1 });
r = await save(CASHIER, [bill('u1', 700, upiByHand)]);
p1 = await pay('u1:upi');
check('…a cashier\'s phone sending it again: saved as before (no "only the owner can change a saved bill"), still confirmed', !r.err && p1.verification === 'confirmed', { r, p1 });
r = await save(A, [bill('u1', 700, (d) => [{ method: 'upi', amount: d - 100, ref: '412345678901', confirmed: true }, { method: 'cash', amount: 100, received: 100 }])]);
p1 = await pay('u1:upi');
check('the owner changes the bill so the UPI part is another amount: it isn\'t the payment confirmed any more — unverified again', !r.err && p1.verification === 'unverified' && !p1.confirmed_by && +p1.amount === 600, { r, p1 });
await save(A, [bill('c1', 900, (d) => [{ method: 'card', amount: d, ref: 'APR123', confirmed: true }]), bill('k1', 50, (d) => [{ method: 'cash', amount: d, received: d }])]);
r = await confirm(A, 'c1:card');
const rc = await confirm(A, 'k1:cash');
check('a card or cash payment isn\'t confirmed this way', /Only a UPI payment/.test(r.err || '') && /Only a UPI payment/.test(rc.err || ''), { r, rc });
await save(A, [bill('u4', 250, upiByHand)]);
await as(A, `UPDATE public.hangtag_sales SET is_void = TRUE, void_reason = 'Customer left' WHERE id = 'u4'`);
await save(A, [bill('u4', 250, upiByHand, { void: true, voidReason: 'Customer left' })]);
r = await confirm(A, 'u4:upi');
check('a cancelled bill\'s UPI isn\'t confirmed', r[0] && ['cancelled', 'unverified'].includes(r[0].r.status) && (await pay('u4:upi')).verification !== 'confirmed', { r, p: await pay('u4:upi') });
// a payment saved before verification was kept (an older bill, upgraded by the database itself)
await sql(`INSERT INTO public.hangtag_sales (owner_id, id, bill_no, timestamp, subtotal, discount, total, payment_method, tax_rate, tax_amount, tax_inclusive) VALUES ($1, 'old1', 'OLD-1', 1700000000000, 500, 0, 500, 'upi', 0, 0, TRUE)`, [A]).catch(() => null);
const legacy = await sql(`SELECT verification FROM public.hangtag_payments WHERE owner_id = $1 AND sale_id = 'old1'`, [A]);
if (!legacy.length) await sql(`INSERT INTO public.hangtag_payments (owner_id, id, sale_id, method, amount, verification, t) VALUES ($1, 'old1:upi', 'old1', 'upi', 500, 'recorded', 1700000000000)`, [A]).catch((e) => console.log('  (legacy row:', e.message, ')'));
const lp = (await sql(`SELECT verification FROM public.hangtag_payments WHERE owner_id = $1 AND sale_id = 'old1'`, [A]))[0];
r = await confirm(A, 'old1:upi');
check('a payment saved before verification was kept (by the database, not a phone) stays "recorded"; confirming answers so', lp && lp.verification === 'recorded' && r[0] && r[0].r.status === 'recorded' && r[0].r.already === true, { lp, r });
r = await as(A, `UPDATE public.hangtag_payments SET reference = 'UTR-OLD' WHERE id = 'old1:upi' RETURNING verification`);
check('…and stays so when the owner changes something else on it', (r[0] || {}).verification === 'recorded', r);
// confirmed by the shop, later matched with the provider's own record (the payment-gateway function's "verify"): verified
r = await confirm(A, 'u3:upi');
const mi = await intent(A, '0c000000-0000-4000-8000-000000000005', ACC_A, { sale: 'u3', status: 'verified', pid: 'pay_u3', pay: 'pay_u3', amount: 400, kind: 'match' });
if (mi.err) console.log('  (match intent:', mi.err, ')');
const up = await as('service', `UPDATE public.hangtag_payments SET verification = 'verified', intent_id = '0c000000-0000-4000-8000-000000000005', provider_payment_id = 'pay_u3'
  WHERE owner_id = $1 AND id = 'u3:upi' RETURNING verification`, [A]);
check('a payment the shop confirmed, later matched with the provider\'s own record: verified (the stronger proof wins)', r[0] && r[0].r.status === 'confirmed' && (up[0] || {}).verification === 'verified', { r, up });
r = await save(A, [bill('u3', 400, upiByHand)]);
check('…and a phone sending the bill again (as it knew it: unverified) keeps it verified', !r.err && (await pay('u3:upi')).verification === 'verified', { r, p: await pay('u3:upi') });

console.log('=== every shop table, the new ones included, closed to everyone outside the shop ===');
const tables = await shopTables(db), run = async (who, q, p) => {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(q, p); } finally { await db.exec('RESET ROLE'); }
};
check(`the new tables are among the shop tables swept (${tables.length})`, tables.includes('hangtag_payment_accounts') && tables.includes('hangtag_payment_events'));
const rl = await readLeaks({ run, tables, victim: A, attackers: [['B', B], ['outsider', OUT], ['signed out', null]] });
const wl = await writeLeaks({ db, run, tables, victim: A, attackers: [['B', B], ['outsider', OUT], ['signed out', null]] });
check('nothing of shop A is seen, changed, deleted or added to by anyone outside it, in any shop table', rl.length === 0 && wl.leaks.length === 0, { rl, wl: wl.leaks });

console.log('=== the undo ===');
r = await confirm(A, 'u2:upi');
check('(the owner confirms another UPI payment before the undo)', r[0] && r[0].r.status === 'confirmed', r);
const rowsBefore = (await sql(`SELECT (SELECT count(*) FROM public.hangtag_payment_accounts) + (SELECT count(*) FROM public.hangtag_payment_events) + (SELECT count(*) FROM public.hangtag_payment_intents) AS n`))[0].n;
const und = (await db.exec(UNDO)).at(-1).rows;
const rowsAfter = (await sql(`SELECT (SELECT count(*) FROM public.hangtag_payment_accounts) + (SELECT count(*) FROM public.hangtag_payment_events) + (SELECT count(*) FROM public.hangtag_payment_intents) AS n`))[0].n;
check('the undo says it took: the confirmation and its trigger gone, every account, notification and intent kept', und[0].undone === true && rowsAfter === rowsBefore
  && (await sql(`SELECT to_regprocedure('public.hangtag_confirm_upi_payment(text)') IS NULL AS gone`))[0].gone, { und, rowsBefore, rowsAfter });
check('…confirmed payments keep the rule that allows them (section 3h\'s older one would refuse their next upload)',
  (await sql(`SELECT pg_get_constraintdef(oid) LIKE '%confirmed%' AS keeps FROM pg_constraint WHERE conname = 'hangtag_payments_verification_check'`))[0].keeps);
r = await as(A, `SELECT count(*)::int n FROM public.hangtag_payment_accounts`);
check('…and the accounts stay closed to every app account', /permission denied/.test(r.err || ''), r);
await db.exec(MIG);
check('the migration again after the undo: all ok', (await report()).every((x) => x.ok));

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
