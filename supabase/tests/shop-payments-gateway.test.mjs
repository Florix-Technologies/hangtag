// The payment-gateway and payment-webhook Edge Functions by their behaviour (supabase/functions/payment-*/handler.js), on
// the real schema.sql with the shop payments migration (PGlite behind the PostgREST stand-in: row security, constraints
// and triggers as in production) and a scripted Razorpay that keeps every shop's own account apart. MOCKED PROVIDER: this
// proves Hangtag's side; Razorpay's own sandbox is a separate, manual step (RELEASE.md).
// - no shared account: with Hangtag's old keys (or the plan billing keys) set, nothing is offered or called;
// - a shop connects its OWN test keys (checked with Razorpay; live keys refused until switched on), kept only sealed: the
//   app reads nothing of it; a sealed secret moved to another account doesn't open; a cashier can't connect;
// - each shop's QR is made, checked and refunded with its own keys; the same bill part asked again gives the same QR;
// - verified only for exactly the amount on an open QR; another amount, or money after it closed, is unmatched;
// - webhooks: only with the account's own signature at its own address, once per event, only that account's intents;
//   a tampered body, another shop's signature, an unknown or disconnected address change nothing;
// - refunds: once however often asked (also at the same moment); the provider's outcome kept;
// - shop B can't see or touch shop A's payments, accounts or notifications, through the function or the database;
// - disconnecting closes what is open and drops the secrets; plan billing stays apart.
// Run: node supabase/tests/shop-payments-gateway.test.mjs
import crypto, { createHmac } from 'node:crypto';
import fs from 'node:fs';
import { createPgRest, serviceToken } from '../../tests/helpers/pg-rest.mjs';
import { pgClient } from '../../tests/helpers/pg-client.mjs';
import { razorpayFake } from '../../tests/helpers/razorpay-fake.mjs';
import { handlePayment } from '../functions/payment-gateway/handler.js';
import { handleWebhook } from '../functions/payment-webhook/handler.js';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs } from '../../src/infrastructure/supabase/mappers.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const at = (p) => new URL(p, import.meta.url);
const MIG = fs.readFileSync(at('../migrations/20261023120000_hangtag_shop_payments.sql'), 'utf8');
const A = 'aaaaaaaa-1111-4111-8111-111111111111', B = 'bbbbbbbb-2222-4222-8222-222222222222';
const CASHIER = 'cccccccc-3333-4333-8333-333333333333', MANAGER = 'dddddddd-4444-4444-8444-444444444444';
const pg = await createPgRest(fs.realpathSync(at('../schema.sql')), { uid: A, email: 'a@shop.test',
  users: [{ id: B, email: 'b@shop.test' }, { id: CASHIER, email: 'cash@shop.test' }, { id: MANAGER, email: 'mgr@shop.test' }], after: [MIG] });
const sql = async (q, p) => (await pg.db.query(q, p)).rows;
for (const [id, mail] of [[A, 'a@shop.test'], [B, 'b@shop.test']])
  await sql(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, onboarded_at) VALUES ($1,$2,'Owner','Shop','9876543210','Pune','Maharashtra',now())
    ON CONFLICT (id) DO UPDATE SET shop_name = 'Shop', onboarded_at = now()`, [id, mail]);
// shop A's team: a cashier and a manager, each on an enrolled phone
const devKey = { [CASHIER]: 'cashier-phone-key-0123456789abcdef', [MANAGER]: 'manager-phone-key-0123456789abcdef' };
for (const [id, role, user] of [[CASHIER, 'cashier', 'cash1'], [MANAGER, 'manager', 'mgr1']]) {
  await sql(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1,$2,$3,$4,$5,'active',$2)`, [id, A, role, user, role]);
  await sql(`INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1,$2,$3,'Phone','Android',$4)`,
    [A, 'dev-' + role, id, crypto.createHash('sha256').update(devKey[id]).digest('hex')]);
}

const rz = razorpayFake();
const KA = { id: 'rzp_test_ShopAaaa001', secret: 'AAsecretAAsecretAAsecret', hook: 'whsec-shop-A-0001' };
const KB = { id: 'rzp_test_ShopBbbb002', secret: 'BBsecretBBsecretBBsecret', hook: 'whsec-shop-B-0002' };
rz.keys.set(KA.id, KA.secret); rz.keys.set(KB.id, KB.secret);
const SEAL_KEY = Buffer.alloc(32, 7).toString('base64');
const ENV = { SUPABASE_URL: 'https://project.supabase.co', PAYMENT_ACCOUNTS_KEY: SEAL_KEY, PAYMENT_ALLOWED_USERS: 'a@shop.test,b@shop.test',
  // the old, shared Hangtag keys and the plan billing keys may still be set on a project: neither is ever used for a shop
  RAZORPAY_KEY_ID: 'rzp_test_HangtagShared', RAZORPAY_KEY_SECRET: 'sharedsharedshared', SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_HangtagPlans', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 'plansplansplans' };
rz.keys.set(ENV.RAZORPAY_KEY_ID, ENV.RAZORPAY_KEY_SECRET); rz.keys.set(ENV.SUBSCRIPTION_RAZORPAY_KEY_ID, ENV.SUBSCRIPTION_RAZORPAY_KEY_SECRET);
let clock = Date.now();
const quiet = { error: () => {}, warn: () => {}, log: () => {} };
const tok = (who) => pg.session(who).access_token;
const svc = () => pgClient(pg, { token: serviceToken() });
const fn = (who, body, { env = ENV } = {}) => handlePayment({ method: 'POST', auth: who ? 'Bearer ' + tok(who) : null, device: devKey[who] || null, json: async () => body }, {
  env, userDb: (auth, dev) => pgClient(pg, { token: auth.replace(/^Bearer /, ''), headers: dev ? { 'x-hangtag-device': dev } : {} }), admin: svc, fetch: rz.fetch, now: () => clock, log: quiet });
const hook = (hookId, event, { secret, eventId = 'evt_' + crypto.randomUUID().slice(0, 12), tamper = false, env = ENV } = {}) => {
  const raw = JSON.stringify(event), sig = createHmac('sha256', secret).update(raw).digest('hex');
  return handleWebhook({ method: 'POST', hookId, signature: sig, eventId, text: async () => (tamper ? raw.replace('captured', 'captured ') : raw) }, { env, admin: svc, now: () => clock, log: quiet });
};
const providerCalls = (kid) => rz.calls.filter((c) => c.kid === kid).length;
const hookOf = (r) => new URL(r.body.gateway.webhookUrl).searchParams.get('a');
const qrEvent = (q, pay) => ({ event: 'qr_code.credited', payload: { qr_code: { entity: q }, ...(pay ? { payment: { entity: pay } } : {}) } });

console.log('=== no shared account: nothing without the shop\'s own ===');
{
  let r = await fn(A, { action: 'config' }, { env: { ...ENV, PAYMENT_ACCOUNTS_KEY: '' } });
  check('without the sealing key: nothing offered, and connecting isn\'t available', r.status === 200 && r.body.upi === false && r.body.gateway.available === false, r.body);
  r = await fn(A, { action: 'config' }, { env: { ...ENV, PAYMENT_ALLOWED_USERS: '' } });
  check('a shop not switched on (PAYMENT_ALLOWED_USERS): nothing offered, nothing to connect', r.body.upi === false && r.body.gateway.available === false, r.body);
  r = await fn(A, { action: 'config' });
  check('switched on, nothing connected: connecting available, no UPI QR or card link offered', r.body.gateway.available === true && r.body.gateway.connected === false && !r.body.upi && !r.body.cardLink && r.body.provider === null, r.body);
  r = await fn(A, { action: 'create', method: 'upi', amount: 500, sale_id: 's-none' });
  check('…a payment asked for anyway is refused: "connect your Razorpay account first"', r.status === 503 && /Connect your Razorpay account/.test(r.body.message), r);
  check('…and Razorpay was never called, with Hangtag\'s shared keys or the plan billing keys or any other', rz.calls.length === 0, rz.calls);
}

console.log('=== connecting the shop\'s own account ===');
let hookA = '', hookB = '';
{
  let r = await fn(A, { action: 'connect', key_id: 'rzp_test_ShopAaaa001', key_secret: 'short', webhook_secret: KA.hook });
  check('a Key Secret that isn\'t one is refused, saying where to find it', r.status === 422 && r.body.error === 'bad_key_secret', r.body);
  r = await fn(A, { action: 'connect', key_id: 'rzp_live_ShopAaaa001', key_secret: KA.secret, webhook_secret: KA.hook });
  check('live keys are refused until live payments are switched on (PAYMENT_LIVE_MODE), before Razorpay is asked', r.status === 422 && r.body.error === 'live_not_allowed' && rz.calls.length === 0, r.body);
  r = await fn(A, { action: 'connect', key_id: KA.id, key_secret: 'WrongWrongWrongWrong1', webhook_secret: KA.hook });
  check('keys Razorpay refuses: not connected, nothing kept', r.status === 422 && r.body.error === 'keys_refused' && (await sql(`SELECT count(*)::int n FROM public.hangtag_payment_accounts`))[0].n === 0, r.body);
  r = await fn(CASHIER, { action: 'connect', key_id: KA.id, key_secret: KA.secret, webhook_secret: KA.hook });
  check('a cashier can\'t connect the shop\'s account (a shop setting)', r.status === 403, r);
  r = await fn(A, { action: 'connect', key_id: KA.id, key_secret: KA.secret, webhook_secret: KA.hook });
  check('the owner connects the shop\'s own test keys: connected, test mode, the key masked, the webhook address and events to set up',
    r.status === 200 && r.body.gateway.connected && r.body.gateway.mode === 'test' && r.body.gateway.keyId === 'rzp_test_…a001' && r.body.upi === true
    && /\/functions\/v1\/payment-webhook\?a=/.test(r.body.gateway.webhookUrl) && r.body.gateway.events.includes('qr_code.credited'), r.body);
  check('…no secret in the answer', !JSON.stringify(r.body).includes(KA.secret) && !JSON.stringify(r.body).includes(KA.hook), r.body);
  hookA = hookOf(r);
  const row = (await sql(`SELECT row_to_json(a)::text AS j, secret_box, webhook_box FROM public.hangtag_payment_accounts a WHERE owner_id = $1`, [A]))[0];
  check('…kept only sealed: neither secret appears anywhere in the row', /^v1\./.test(row.secret_box) && /^v1\./.test(row.webhook_box) && !row.j.includes(KA.secret) && !row.j.includes(KA.hook), row);
  const asApp = await pgClient(pg, { token: tok(A) }).from('hangtag_payment_accounts').select('*');
  check('…and the shop\'s own app session can\'t read the table at all', !!asApp.error && !asApp.data, asApp);
  r = await fn(MANAGER, { action: 'config' });
  check('a manager (shop settings) sees the account and its webhook address; a cashier sees it connected without the address',
    r.body.gateway.connected && !!r.body.gateway.webhookUrl && (await fn(CASHIER, { action: 'config' })).body.gateway.webhookUrl === undefined, r.body);
  r = await fn(B, { action: 'connect', key_id: KB.id, key_secret: KB.secret, webhook_secret: KB.hook });
  hookB = hookOf(r);
  check('shop B connects its own account: another account, another webhook address', r.status === 200 && hookB && hookB !== hookA, r.body);
  const live = await fn(B, { action: 'config' }, { env: { ...ENV, PAYMENT_LIVE_MODE: 'on' } });
  check('(live keys would be taken only with PAYMENT_LIVE_MODE=on; nothing live is connected here)', live.body.gateway.mode === 'test', live.body);
}

console.log('=== payments on each shop\'s own account ===');
let qA = null, iA = null;
{
  const before = providerCalls(KA.id);
  let r = await fn(A, { action: 'create', method: 'upi', amount: 1890, sale_id: 'sale-a1', note: 'Bill A1' });
  iA = r.body; qA = rz.qrs.get(iA.reference);
  check('shop A\'s QR is made on shop A\'s own account', r.status === 200 && iA.status === 'pending' && qA && qA.kid === KA.id && providerCalls(KA.id) > before && providerCalls(ENV.RAZORPAY_KEY_ID) === 0, { body: r.body, calls: rz.calls.slice(-3) });
  const row = (await sql(`SELECT i.account_id::text, a.owner_id::text AS acct_owner FROM public.hangtag_payment_intents i JOIN public.hangtag_payment_accounts a ON a.id = i.account_id WHERE i.id = $1`, [iA.id]))[0];
  check('…the intent names that account, of the same shop', !!row && row.acct_owner === A, row);
  const qrCount = rz.qrs.size;
  r = await fn(A, { action: 'create', method: 'upi', amount: 1890, sale_id: 'sale-a1', note: 'Bill A1' });
  check('the same bill part asked for again (a retry, a double tap): the same QR, not a second one to pay', r.body.id === iA.id && rz.qrs.size === qrCount, { a: r.body.id, b: iA.id });
  const rB = await fn(B, { action: 'create', method: 'upi', amount: 1890, sale_id: 'sale-a1' });
  check('shop B, the same bill id and amount: its own QR on its own account', rB.body.id !== iA.id && rz.qrs.get(rB.body.reference).kid === KB.id, rB.body);
  r = await fn(A, { action: 'status', id: iA.id });
  check('nothing paid yet: pending', r.body.status === 'pending', r.body);
  const pay = rz.payQr(qA.id);
  r = await fn(A, { action: 'status', id: iA.id });
  check('paid exactly at Razorpay: verified, with the provider\'s payment id', r.body.status === 'verified' && r.body.paymentId === pay.id && r.body.paidAmount === 1890, r.body);
  r = await fn(B, { action: 'status', id: iA.id });
  check('shop B asking about shop A\'s payment: not found', r.status === 404, r);
  r = await fn(B, { action: 'cancel', id: iA.id });
  check('…nor can it cancel it', r.status === 404 && (await sql(`SELECT status FROM public.hangtag_payment_intents WHERE id = $1`, [iA.id]))[0].status === 'verified', r);
  // another amount
  r = await fn(A, { action: 'create', method: 'upi', amount: 700, sale_id: 'sale-a2' });
  const q2 = rz.qrs.get(r.body.reference); rz.payQr(q2.id, 50000);
  r = await fn(A, { action: 'status', id: r.body.id });
  check('₹500 paid on a ₹700 QR: unmatched, never verified', r.body.status === 'unmatched' && r.body.paidAmount === 500, r.body);
  // a forged claim from the app
  const app = pgClient(pg, { token: tok(A) });
  const forge = await app.from('hangtag_payment_intents').update({ status: 'verified', paid_amount: 700 }).eq('id', r.body.id).select('id');
  check('the app can\'t mark an intent verified itself (read-only for it)', !!forge.error || !(forge.data || []).length, forge);
  const T = computeCheckout({ lines: [{ q: 1, price: 700, rate: 0 }], billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, [{ method: 'upi', amount: T.total, via: 'qr', intent: { id: r.body.id, status: 'verified', amount: T.total, paymentId: 'pay_forged' } }]);
  const billA2 = { id: 'sale-a2', no: 'INV-A2', t: clock, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: [{ ln: 0, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: 1, price: 700, cost: null, dAmt: 0, bdAmt: 0, gst: 0, hsn: '6109', tx: 700, cgst: 0, sgst: 0, igst: 0, lt: 700 }],
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'upi', payments: S.payments.map((p) => ({ id: paymentId('sale-a2', p.method), ...p })) };
  const saved = await app.rpc('hangtag_save_sales', { p_bills: [billArgs(billA2)] });
  check('a bill whose phone claims that unmatched QR as verified is refused by the database', !!saved.error && /not confirmed/.test(saved.error.message), saved);
}

console.log('=== the webhook: each account\'s own address and signature, once ===');
{
  const r0 = await fn(A, { action: 'create', method: 'upi', amount: 300, sale_id: 'sale-a3' });
  const q = rz.qrs.get(r0.body.reference), pay = rz.payQr(q.id), ev = qrEvent(q, pay), id = r0.body.id;
  const st = async () => (await sql(`SELECT status FROM public.hangtag_payment_intents WHERE id = $1`, [id]))[0].status;
  const events = async () => (await sql(`SELECT count(*)::int n FROM public.hangtag_payment_events WHERE owner_id = $1`, [A]))[0].n;
  const n0 = await events();
  let r = await hook(hookA, ev, { secret: 'not-the-secret' });
  check('a wrong signature: refused, nothing written', r.status === 400 && (await st()) === 'pending' && (await events()) === n0, r);
  r = await hook(hookA, ev, { secret: KB.hook });
  check('shop B\'s signature at shop A\'s address: refused', r.status === 400 && (await st()) === 'pending', r);
  r = await hook(hookA, ev, { secret: KA.hook, tamper: true });
  check('a body changed after signing: refused', r.status === 400 && (await st()) === 'pending', r);
  r = await hook('x'.repeat(43), ev, { secret: KA.hook });
  check('an address no account has: refused', r.status === 404, r);
  r = await hook(hookB, ev, { secret: KB.hook });
  check('shop A\'s QR sent (validly signed) to shop B\'s address: nothing of shop A changes', r.status === 200 && r.body.ignored === true && (await st()) === 'pending', r.body);
  r = await hook(hookA, ev, { secret: KA.hook, eventId: 'evt_A3_paid' });
  check('the paid QR at shop A\'s own address, signed with its secret: verified', r.status === 200 && r.body.status === 'verified' && (await st()) === 'verified', r.body);
  const n1 = await events();
  r = await hook(hookA, ev, { secret: KA.hook, eventId: 'evt_A3_paid' });
  check('the same notification again: "duplicate", recorded once, nothing changes', r.status === 200 && r.body.duplicate === true && (await events()) === n1, r.body);
  r = await hook(hookA, ev, { secret: KA.hook, eventId: 'evt_A3_paid_again' });
  check('the same payment told again under another event id: unchanged (verified once)', r.body.unchanged === true && (await st()) === 'verified', r.body);
  const hist = await sql(`SELECT outcome, from_status, to_status FROM public.hangtag_payment_events WHERE owner_id = $1 AND intent_id = $2 ORDER BY received_at`, [A, id]);
  check('the shop\'s payment history: pending → verified, then unchanged', hist.some((h) => h.outcome === 'changed' && h.from_status === 'pending' && h.to_status === 'verified') && hist.some((h) => h.outcome === 'unchanged'), hist);
  // a late payment: the QR expired, then the money and its notification arrive
  const r1 = await fn(A, { action: 'create', method: 'upi', amount: 450, sale_id: 'sale-a4', expiry_min: 2 });
  const q4 = rz.qrs.get(r1.body.reference);
  clock += 3 * 60_000;
  r = await fn(A, { action: 'status', id: r1.body.id });
  check('its time is up: expired', r.body.status === 'expired', r.body);
  const late = rz.payQr(q4.id);
  r = await hook(hookA, qrEvent(q4, late), { secret: KA.hook });
  check('money (and its notification) after it expired: an unmatched receipt, never verified', r.body.status === 'unmatched', r.body);
  const seenA = await pgClient(pg, { token: tok(A) }).from('hangtag_payment_events').select('id');
  const seenB = await pgClient(pg, { token: tok(B) }).from('hangtag_payment_events').select('id').eq('owner_id', A);
  check('the shop reads its own payment history; shop B reads none of it', (seenA.data || []).length >= 3 && (seenB.data || []).length === 0, { a: (seenA.data || []).length, b: seenB });
  const cash = await pgClient(pg, { token: tok(CASHIER), headers: { 'x-hangtag-device': devKey[CASHIER] } }).from('hangtag_payment_events').select('id');
  check('…nor does a cashier (it\'s a report)', (cash.data || []).length === 0, cash);
}

console.log('=== refunds: once, on the account that took the payment ===');
{
  // the bill paid by shop A's verified QR (sale-a1) and a return of ₹890 by UPI
  const T = computeCheckout({ lines: [{ q: 1, price: 1890, rate: 0 }], billDisc: null, gst: { mode: 'none', inclusive: true } });
  const paidId = (await sql(`SELECT provider_payment_id FROM public.hangtag_payment_intents WHERE id = $1`, [iA.id]))[0].provider_payment_id;
  const S = settlePayments(T.total, [{ method: 'upi', amount: T.total, via: 'qr', intent: { id: iA.id, status: 'verified', amount: T.total, paymentId: paidId } }]);
  const bill = { id: 'sale-a1', no: 'INV-A1', t: clock, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: [{ ln: 0, p: 'p1', v: 'p1:M', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: 1, price: 1890, cost: null, dAmt: 0, bdAmt: 0, gst: 0, hsn: '6109', tx: 1890, cgst: 0, sgst: 0, igst: 0, lt: 1890 }],
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'upi', payments: S.payments.map((p) => ({ id: paymentId('sale-a1', p.method), ...p })) };
  const saved = await pgClient(pg, { token: tok(A) }).rpc('hangtag_save_sales', { p_bills: [billArgs(bill)] });
  check('(the bill paid by shop A\'s verified QR saves as verified)', !saved.error && (await sql(`SELECT verification FROM public.hangtag_payments WHERE owner_id = $1 AND id = 'sale-a1:upi'`, [A]))[0].verification === 'verified', saved);
  await sql(`INSERT INTO public.hangtag_returns (owner_id, id, sale_id, t, kind, refund_amount, refund_method, value) VALUES ($1, 'ret-a1', 'sale-a1', $2, 'return', 890, 'upi', 890)`, [A, clock]);
  const [r1, r2] = await Promise.all([fn(A, { action: 'refund_return', return_id: 'ret-a1' }), fn(A, { action: 'refund_return', return_id: 'ret-a1' })]);
  const made = rz.refunds.filter((x) => x.notes && x.notes.return_id === 'ret-a1');
  check('two refund requests at the same moment: one refund at Razorpay, on shop A\'s own account', made.length === 1 && made[0].kid === KA.id && [r1, r2].every((r) => r.status === 200), { made, r1: r1.body, r2: r2.body });
  check('…one of them says it was already done', [r1, r2].filter((r) => r.body.already).length === 1, [r1.body, r2.body]);
  let ret = (await sql(`SELECT provider_refund_id, provider_refund_status FROM public.hangtag_returns WHERE owner_id = $1 AND id = 'ret-a1'`, [A]))[0];
  check('the return keeps the refund id and the provider\'s word: pending', ret.provider_refund_id === made[0].id && ret.provider_refund_status === 'pending', ret);
  const r3 = await fn(A, { action: 'refund_return', return_id: 'ret-a1' });
  check('asked again later: already refunded, Razorpay not asked', r3.body.already === true && rz.refunds.filter((x) => x.notes && x.notes.return_id === 'ret-a1').length === 1, r3.body);
  let w = await hook(hookA, { event: 'refund.processed', payload: { refund: { entity: { ...made[0], status: 'processed' } } } }, { secret: KA.hook });
  ret = (await sql(`SELECT provider_refund_status FROM public.hangtag_returns WHERE owner_id = $1 AND id = 'ret-a1'`, [A]))[0];
  check('Razorpay says the refund was processed: kept on the return', w.body.refund === 'processed' && ret.provider_refund_status === 'processed', { w: w.body, ret });
  w = await hook(hookB, { event: 'refund.failed', payload: { refund: { entity: { ...made[0], status: 'failed' } } } }, { secret: KB.hook });
  ret = (await sql(`SELECT provider_refund_status FROM public.hangtag_returns WHERE owner_id = $1 AND id = 'ret-a1'`, [A]))[0];
  check('…shop B\'s address can\'t change shop A\'s refund', w.body.ignored === true && ret.provider_refund_status === 'processed', { w: w.body, ret });
  // an unmatched receipt refunded: once
  const um = (await fn(A, { action: 'unmatched' })).body.items.find((x) => x.status === 'unmatched' && x.paidAmount === 500);
  const [u1, u2] = await Promise.all([fn(A, { action: 'resolve', id: um.id, resolution: 'refund' }), fn(A, { action: 'resolve', id: um.id, resolution: 'refund' })]);
  const umRefunds = rz.refunds.filter((x) => x.notes && x.notes.intent_id === um.id);
  check('an unmatched receipt refunded twice at once: one refund, the receipt resolved', umRefunds.length === 1 && [u1, u2].every((r) => r.status === 200) && (await sql(`SELECT resolution FROM public.hangtag_payment_intents WHERE id = $1`, [um.id]))[0].resolution === 'refunded', { umRefunds, u1: u1.body, u2: u2.body });
  w = await hook(hookA, { event: 'refund.failed', payload: { refund: { entity: { ...umRefunds[0], status: 'failed' } } } }, { secret: KA.hook });
  check('…a refund Razorpay then fails is kept as failed (to pay back by hand)', (await sql(`SELECT refund_status FROM public.hangtag_payment_intents WHERE id = $1`, [um.id]))[0].refund_status === 'failed', w.body);
  const rB = await fn(B, { action: 'resolve', id: um.id, resolution: 'allocated' });
  check('shop B can\'t settle shop A\'s receipt', rB.status === 404, rB);
}

console.log('=== a sealed secret opens only where it was sealed ===');
{
  const a = (await sql(`SELECT secret_box, webhook_box FROM public.hangtag_payment_accounts WHERE owner_id = $1 AND status = 'connected'`, [A]))[0];
  const bRow = (await sql(`SELECT id, secret_box, webhook_box FROM public.hangtag_payment_accounts WHERE owner_id = $1 AND status = 'connected'`, [B]))[0];
  await sql(`UPDATE public.hangtag_payment_accounts SET secret_box = $1, webhook_box = $2 WHERE id = $3`, [a.secret_box, a.webhook_box, bRow.id]);
  const before = providerCalls(KA.id);
  const r = await fn(B, { action: 'create', method: 'upi', amount: 100, sale_id: 'sale-b9' });
  const w = await hook(hookB, { event: 'qr_code.closed', payload: { qr_code: { entity: { id: 'qr_x', status: 'closed' } } } }, { secret: KA.hook });
  check('shop A\'s sealed secrets copied into shop B\'s row open nowhere: no payment, no notification, shop A\'s keys never used',
    r.status === 503 && w.status === 400 && providerCalls(KA.id) === before, { r: r.body, w });
  await sql(`UPDATE public.hangtag_payment_accounts SET secret_box = $1, webhook_box = $2 WHERE id = $3`, [bRow.secret_box, bRow.webhook_box, bRow.id]);
  const r2 = await fn(B, { action: 'create', method: 'upi', amount: 100, sale_id: 'sale-b9' }, { env: { ...ENV, PAYMENT_ACCOUNTS_KEY: Buffer.alloc(32, 9).toString('base64') } });
  check('another sealing key (PAYMENT_ACCOUNTS_KEY changed): the keys don\'t open, nothing is paid', r2.status === 503, r2.body);
}

console.log('=== disconnecting ===');
{
  const u0 = await fn(A, { action: 'create', method: 'upi', amount: 200, sale_id: 'sale-a7' });
  rz.payQr(rz.qrs.get(u0.body.reference).id, 10000);
  const um2 = (await fn(A, { action: 'status', id: u0.body.id })).body;
  const open = await fn(A, { action: 'create', method: 'card', amount: 999, sale_id: 'sale-a5' });
  const link = rz.links.get(open.body.reference);
  const r = await fn(A, { action: 'disconnect' });
  const row = (await sql(`SELECT status, secret_box, webhook_box, disconnected_at FROM public.hangtag_payment_accounts WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 1`, [A]))[0];
  check('disconnected: the open card link closed at Razorpay and cancelled here, the secrets dropped', r.status === 200 && !r.body.gateway.connected && link.status === 'cancelled'
    && (await sql(`SELECT status FROM public.hangtag_payment_intents WHERE id = $1`, [open.body.id]))[0].status === 'cancelled' && row.status === 'disconnected' && !row.secret_box && !row.webhook_box && !!row.disconnected_at, { r: r.body, row, link });
  const c = await fn(A, { action: 'create', method: 'upi', amount: 100, sale_id: 'sale-a6' });
  const w = await hook(hookA, { event: 'qr_code.closed', payload: { qr_code: { entity: { id: 'qr_y', status: 'closed' } } } }, { secret: KA.hook });
  check('…then no payment is taken, and its old webhook address is gone (410)', c.status === 503 && w.status === 410, { c: c.body, w });
  const list = await fn(A, { action: 'unmatched' });
  check('its unmatched money is still listed', um2.status === 'unmatched' && list.status === 200 && list.body.items.some((x) => x.id === um2.id), { um2, list: list.body });
  const before = rz.refunds.length, rf = await fn(A, { action: 'resolve', id: um2.id, resolution: 'refund' });
  check('…but not refunded through the disconnected account ("refund it from your Razorpay dashboard")', rf.status === 422 && /Razorpay dashboard/.test(rf.body.message) && rz.refunds.length === before, rf.body);
  const hand = await fn(A, { action: 'resolve', id: um2.id, resolution: 'refunded', note: 'Paid back in cash' });
  check('…and can be marked paid back by hand', hand.status === 200 && hand.body.resolution === 'refunded', hand.body);
}

console.log('=== plan billing stays apart ===');
{
  const src = (p) => fs.readFileSync(at(p), 'utf8');
  const shopFns = ['../functions/payment-gateway/core.js', '../functions/payment-gateway/handler.js', '../functions/payment-gateway/index.ts', '../functions/payment-webhook/handler.js', '../functions/payment-webhook/index.ts'].map(src).join('\n');
  const planFns = fs.readdirSync(at('../functions/subscription/'), { recursive: true }).filter((f) => /\.(js|ts)$/.test(f)).map((f) => src('../functions/subscription/' + f.replace(/\\/g, '/'))).join('\n')
    + fs.readdirSync(at('../functions/subscription-webhook/')).filter((f) => /\.(js|ts)$/.test(f)).map((f) => src('../functions/subscription-webhook/' + f)).join('\n');
  check('the shop payment functions read no plan billing setting or table, and no shared Razorpay key', !/SUBSCRIPTION_|hangtag_subscription|RAZORPAY_KEY_|RAZORPAY_WEBHOOK_SECRET/.test(shopFns));
  check('the plan billing functions read no shop payment table, account or setting', !/hangtag_payment_(intents|accounts|events)|PAYMENT_ACCOUNTS_KEY|PAYMENT_ALLOWED_USERS/.test(planFns));
  check('the plan billing keys were never used for a shop\'s payment', providerCalls(ENV.SUBSCRIPTION_RAZORPAY_KEY_ID) === 0 && providerCalls(ENV.RAZORPAY_KEY_ID) === 0);
  const planRows = (await sql(`SELECT (SELECT count(*) FROM public.hangtag_subscription_payments)::int AS p`))[0].p;
  check('no plan payment was made by any of the above', planRows === 0, planRows);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
