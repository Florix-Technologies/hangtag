// The subscription Edge Functions' logic (supabase/functions/subscription/core.js and providers/): requests are validated
// and never carry a price, discount or amount the server would use; the provider is chosen by secrets (none → not
// configured); Razorpay payment links are created in paise with the payment as reference; a payment is activated only when
// the provider says paid with exactly the amount due; the webhook signature is checked in constant time.
// Run: node tests/unit/subscription-function.test.mjs
import crypto from 'node:crypto';
import { callbackUrl, rpcErrorReply, validateRequest, verifyDecision } from '../../supabase/functions/subscription/core.js';
import { providerFor } from '../../supabase/functions/subscription/providers/index.js';
import { linkState, toPaise, verifySignature } from '../../supabase/functions/subscription/providers/razorpay.js';
import { readFileSync } from 'node:fs';
import { PLAN_ENDED, planGate } from '../../supabase/functions/_shared/plan-gate.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const PID = '0b6f3a2e-8c1d-4f6a-9b2e-1c3d4e5f6a7b';

console.log('=== requests ===');
{
  check('config', validateRequest({ action: 'config' }).ok);
  const c = validateRequest({ action: 'checkout', plan: 'm3', promo: ' launch20 ', amount: 1, discount: 999, price: 1 });
  check('checkout keeps only the plan and the promo code (an amount, discount or price sent by the browser is dropped)',
    c.ok && c.plan === 'm3' && c.promo === 'launch20' && !('amount' in c) && !('discount' in c) && !('price' in c), c);
  check('no promo → null', validateRequest({ action: 'checkout', plan: 'm1', promo: '' }).promo === null);
  check('a bad plan is refused', !validateRequest({ action: 'checkout', plan: "m1'; drop table" }).ok);
  check('a bad promo is refused', !validateRequest({ action: 'checkout', plan: 'm1', promo: 'x'.repeat(40) }).ok && !validateRequest({ action: 'checkout', plan: 'm1', promo: 'a b' }).ok);
  check('verify needs a payment id (uuid)', validateRequest({ action: 'verify', payment_id: PID }).ok && !validateRequest({ action: 'verify', payment_id: '1' }).ok);
  check('unknown action / not JSON', !validateRequest({ action: 'activate' }).ok && !validateRequest(null).ok && !validateRequest([1]).ok);
  const e = rpcErrorReply({ code: 'P0001', message: 'Only the shop owner can choose a plan.' });
  const g = rpcErrorReply({ code: '42P01', message: 'relation "x" does not exist' });
  check('the database\'s own refusals reach the app; internal errors never do', e.status === 400 && /shop owner/.test(e.body.message) && g.status === 503 && !/relation/.test(g.body.message), { e, g });
  check('the return page is the app\'s Plans & Billing (https only)', callbackUrl({ APP_URL: 'https://app.hangtag.in/' }, PID) === `https://app.hangtag.in/#plans?payment=${PID}`
    && callbackUrl({ APP_URL: 'http://x' }, PID) === null && callbackUrl({}, PID) === null);
}

console.log('=== the provider is chosen by secrets ===');
{
  check('no secrets → not configured', providerFor({}) === null);
  check('a key id without its secret → not configured', providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_live_x' }) === null);
  check('an unknown provider → not configured', providerFor({ SUBSCRIPTION_PROVIDER: 'paypal', SUBSCRIPTION_RAZORPAY_KEY_ID: 'a', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 'b' }) === null);
  const p = providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's' });
  check('Razorpay with its keys', p && p.name === 'razorpay');
  check('the shops\' own payment-gateway keys are never used for Hangtag plans', providerFor({ RAZORPAY_KEY_ID: 'rzp_live_shop', RAZORPAY_KEY_SECRET: 'x' }) === null);
}

console.log('=== Razorpay payment links ===');
{
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'POST') return { ok: true, json: async () => ({ id: 'plink_ABC123xyz', short_url: 'https://rzp.io/i/abc', status: 'created' }) };
    return { ok: true, json: async () => ({ id: 'plink_ABC123xyz', status: 'paid', amount_paid: 107920, payments: [{ payment_id: 'pay_9', amount: 107920, status: 'captured' }] }) };
  };
  const p = providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 'sec' }, fake, () => 1_800_000_000_000);
  const page = await p.createPayment({ paymentId: PID, amount: 1079.2, currency: 'INR', description: 'Hangtag 3 months', email: 'owner@shop.in', callbackUrl: 'https://app/#plans' });
  const body = JSON.parse(calls[0].init.body);
  check('a payment link for the amount in paise, the payment as reference, no partial payment', page.orderId === 'plink_ABC123xyz' && page.payUrl === 'https://rzp.io/i/abc'
    && body.amount === 107920 && body.accept_partial === false && body.reference_id === PID.replace(/-/g, '') && body.notes.hangtag_payment === PID, body);
  check('…valid for an hour, Razorpay itself sends nothing, back to the app afterwards', body.expire_by === 1_800_000_000 + 3600 && body.notify.sms === false && body.callback_url === 'https://app/#plans', body);
  check('…with the key in the Authorization header (Basic), never in the URL', /^Basic /.test(calls[0].init.headers.Authorization) && !/sec/.test(calls[0].url));
  const v = await p.getPayment('plink_ABC123xyz');
  check('a paid link: paid, in paise, with the provider\'s payment id', v.state === 'paid' && v.paid === 107920 && v.paymentId === 'pay_9', v);
  check('a malformed order id is never sent to the provider', (await p.getPayment('../payments')).state === 'failed' && calls.length === 2);
  check('link states', linkState({ id: 'plink_1', status: 'created' }).state === 'pending' && linkState({ id: 'plink_1', status: 'expired' }).state === 'expired'
    && linkState({ id: 'plink_1', status: 'cancelled' }).state === 'cancelled' && linkState({ id: 'plink_1', status: 'created', expire_by: 1 }, 5000).state === 'expired'
    && linkState({ id: 'plink_1', status: 'partially_paid', amount_paid: 100 }).state === 'pending' && linkState(null).state === 'failed');
  const failing = providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'k', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's' }, async () => ({ ok: false, status: 401, json: async () => ({ error: { code: 'BAD_REQUEST_ERROR' } }) }));
  let threw = null;
  try { await failing.createPayment({ paymentId: PID, amount: 10 }); } catch (e) { threw = e; }
  check('a provider error is an error (never a fake page)', threw && threw.status === 401, threw && threw.message);
}

console.log('=== activation only with exactly the amount due ===');
{
  const row = { id: PID, amount: '1079.20', status: 'created' };
  let d = verifyDecision(row, { state: 'paid', paid: 107920, paymentId: 'pay_9' });
  check('paid in full → activate with the provider\'s figures', d.action === 'activate' && d.amount === 1079.2 && d.ref === 'pay_9', d);
  d = verifyDecision(row, { state: 'paid', paid: 100, paymentId: 'pay_9' });
  check('paid a different amount → never activated (mismatch)', d.action === 'none' && d.status === 'mismatch', d);
  d = verifyDecision(row, { state: 'paid', paid: 107920, paymentId: null });
  check('paid without a payment id → wait', d.action === 'none' && d.status === 'pending', d);
  check('still open → pending', verifyDecision(row, { state: 'pending', paid: 0 }).status === 'pending');
  check('expired / cancelled → recorded as such', verifyDecision(row, { state: 'expired', paid: 0 }).action === 'fail' && verifyDecision(row, { state: 'cancelled', paid: 0 }).status === 'cancelled');
  check('already paid → nothing to do (idempotent)', verifyDecision({ ...row, status: 'paid' }, { state: 'paid', paid: 107920, paymentId: 'pay_9' }).action === 'none');
  check('no row → nothing', verifyDecision(null, { state: 'paid', paid: 1, paymentId: 'x' }).action === 'none');
  check('paise are counted exactly (no float drift)', toPaise(1079.2) === 107920 && toPaise(0.1 + 0.2) === 30 && toPaise('499') === 49900);
}

console.log('=== the webhook ===');
{
  const secret = 'whsec_test';
  const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_ABC123xyz', status: 'paid', amount_paid: 49900, notes: { hangtag_payment: PID } } },
    payment: { entity: { id: 'pay_7', amount: 49900, status: 'captured' } } } });
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  check('a valid signature passes', await verifySignature(raw, sig, secret));
  check('a wrong, empty or missing-secret signature fails', !(await verifySignature(raw, sig.replace(/.$/, '0'), secret)) && !(await verifySignature(raw, '', secret)) && !(await verifySignature(raw, sig, '')));
  check('a changed body fails', !(await verifySignature(raw.replace('49900', '1'), sig, secret)));
  const p = providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'k', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's', SUBSCRIPTION_WEBHOOK_SECRET: secret });
  check('the provider checks its own header', await p.verifyWebhook(raw, { 'x-razorpay-signature': sig }) && !(await p.verifyWebhook(raw, {})));
  const t = p.readWebhook(JSON.parse(raw));
  check('the event → the link, the Hangtag payment and what was paid', t && t.orderId === 'plink_ABC123xyz' && t.paymentRef === PID && t.view.state === 'paid' && t.view.paid === 49900 && t.view.paymentId === 'pay_7', t);
  check('other events are ignored', p.readWebhook({ event: 'payment.captured', payload: { payment: { entity: {} } } }) === null && p.readWebhook({}) === null);
}

console.log('=== the plan gate of the business Edge Functions ===');
{
  const fake = (r) => ({ rpc: async (name, args) => { fake.last = { name, args }; if (r instanceof Error) throw r; return r; } });
  const open = await planGate(fake({ data: true, error: null }), 'shop-1');
  check('a running trial or plan: go ahead (the shop is asked by its id)', open === null && fake.last.name === 'hangtag_access_ok' && fake.last.args.p_owner === 'shop-1');
  const ended = await planGate(fake({ data: false, error: null }), 'shop-1');
  check('a plan that has ended: 402 "subscription_inactive" with a way to renew', ended && ended.status === 402 && ended.body === PLAN_ENDED && PLAN_ENDED.error === 'subscription_inactive' && /Plans & Billing/.test(PLAN_ENDED.message));
  check('a database without the plans update: nothing to enforce, go ahead', (await planGate(fake({ data: null, error: { code: 'PGRST202' } }), 's')) === null && (await planGate(fake({ data: null, error: { code: '42883' } }), 's')) === null);
  const err = await planGate(fake({ data: null, error: { code: '57014' } }), 's'), thrown = await planGate(fake(new Error('network')), 's');
  check('the check failing otherwise: refused (503), never let through', err.status === 503 && thrown.status === 503);
  for (const fn of ['agent', 'extract-bill', 'send-receipt', 'payment-gateway']) {
    const src = readFileSync(new URL(`../../supabase/functions/${fn}/index.ts`, import.meta.url), 'utf8');
    const at = src.indexOf('await planGate('), after = (re) => { const m = src.slice(at).search(re); return m >= 0; }, before = (re) => src.slice(0, at).search(re) < 0;
    check(`${fn}: checks the shop's plan before any provider call or service-role write`, at > 0 && /import \{ planGate \} from "\.\.\/_shared\/plan-gate\.js"/.test(src)
      && before(/fetch\(|\.extract\(|admin\.from\(|admin\.rpc\("hangtag_agent_take"|createPayment|sendVia|\.insert\(|\.update\(/) && after(/return reply\(gate\.status, gate\.body\)/), fn);
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
