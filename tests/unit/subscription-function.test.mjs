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

console.log('=== AutoPay: consent, the provider\'s plan, mandates, and only captured charges ===');
{
  const { autopayPlanMatches, autopayStartAt } = await import('../../supabase/functions/subscription/core.js');
  const { autopayPlanId } = await import('../../supabase/functions/subscription/providers/index.js');
  const { autopayState } = await import('../../supabase/functions/subscription/providers/razorpay.js');
  check('autopay_start needs the owner\'s explicit consent and the terms\' version', validateRequest({ action: 'autopay_start', consent: true, consent_version: 'autopay-2026-10' }).consentVersion === 'autopay-2026-10'
    && !validateRequest({ action: 'autopay_start', consent: 'yes', consent_version: 'autopay-2026-10' }).ok && !validateRequest({ action: 'autopay_start', consent: true }).ok
    && validateRequest({ action: 'autopay_start', consent: false, consent_version: 'v1x' }).error === 'consent_required');
  check('autopay_verify / autopay_cancel take nothing else', validateRequest({ action: 'autopay_verify' }).ok && validateRequest({ action: 'autopay_cancel', amount: 1 }).ok
    && !('amount' in validateRequest({ action: 'autopay_cancel', amount: 1 })));
  const terms = { plan: { code: 'm1', months: 1 }, price: 999, currency: 'INR', first_charge_at: new Date(Date.now() + 30 * 864e5).toISOString() };
  check('the provider\'s plan must be exactly the AutoPay plan: 99900 paise, INR, monthly', autopayPlanMatches({ amount: 99900, currency: 'INR', period: 'monthly', interval: 1 }, terms)
    && !autopayPlanMatches({ amount: 49900, currency: 'INR', period: 'monthly', interval: 1 }, terms) && !autopayPlanMatches({ amount: 99900, currency: 'USD', period: 'monthly', interval: 1 }, terms)
    && !autopayPlanMatches({ amount: 99900, currency: 'INR', period: 'weekly', interval: 1 }, terms) && !autopayPlanMatches(null, terms));
  check('the first charge: when the trial ends (ms); at once when it ends within ten minutes', autopayStartAt(terms) === Date.parse(terms.first_charge_at)
    && autopayStartAt({ ...terms, first_charge_at: new Date(Date.now() + 5 * 60e3).toISOString() }) === null && autopayStartAt({}) === null);
  check('the provider\'s AutoPay plan comes from a secret (a malformed one = not set up)', autopayPlanId({ SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID: 'plan_Abc123XYZ' }) === 'plan_Abc123XYZ'
    && autopayPlanId({ SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID: 'x' }) === '' && autopayPlanId({}) === '');
  check('a mandate\'s state: created → nothing yet; authenticated / active / halted → their events, with the next charge', autopayState({ id: 'sub_1', status: 'created' }).event === null
    && autopayState({ id: 'sub_1', status: 'authenticated', charge_at: 1800000000 }).event === 'authenticated'
    && autopayState({ id: 'sub_1', status: 'authenticated', charge_at: 1800000000 }).nextChargeAt === new Date(1800000000e3).toISOString()
    && autopayState({ id: 'sub_1', status: 'active' }).event === 'activated' && autopayState({ id: 'sub_1', status: 'halted' }).event === 'halted' && autopayState(null).event === null);
  // the Razorpay calls, against a fake API
  const calls = [];
  const api = (routes) => async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const path = url.replace('https://api.razorpay.com/v1', '').replace(/\/sub_\w+/, '/sub_X').replace(/\/plan_\w+/, '/plan_X'), r = routes[(init.method || 'GET') + ' ' + path];
    return { ok: !!r, status: r ? 200 : 404, json: async () => r || {} };
  };
  const p = providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's', SUBSCRIPTION_WEBHOOK_SECRET: 'whsec' }, api({
    'GET /plans/plan_X': { id: 'plan_Abc123XYZ', period: 'monthly', interval: 1, item: { amount: 99900, currency: 'INR' } },
    'POST /subscriptions': { id: 'sub_Fx12345678', short_url: 'https://rzp.io/i/abc', status: 'created', customer_id: 'cust_9' },
    'POST /subscriptions/sub_X/cancel': { id: 'sub_Fx12345678', status: 'cancelled' },
    'GET /subscriptions/sub_X': { id: 'sub_Fx12345678', status: 'authenticated', charge_at: 1800000000 } }));
  const plan = await p.getPlan('plan_Abc123XYZ');
  check('the provider\'s plan is read (amount in paise) and matches', plan.amount === 99900 && plan.period === 'monthly' && plan.interval === 1 && autopayPlanMatches(plan, terms), plan);
  const start = Date.now() + 30 * 864e5, made = await p.createAutopay({ planId: 'plan_Abc123XYZ', startAt: start, notes: { hangtag_owner: 'u1' }, expireBy: Date.now() + 864e5 });
  const body = calls.find((c) => c.method === 'POST' && /\/subscriptions$/.test(c.url)).body;
  check('the mandate: on the plan, nothing charged before the trial\'s end (start_at in seconds), the shop noted, no amount sent',
    made.subscriptionId === 'sub_Fx12345678' && made.authUrl === 'https://rzp.io/i/abc' && made.customerId === 'cust_9' && body.plan_id === 'plan_Abc123XYZ'
    && body.start_at === Math.floor(start / 1000) && body.notes.hangtag_owner === 'u1' && body.quantity === 1 && body.total_count > 0 && body.customer_notify === 1 && !('amount' in body), body);
  check('its state, and turning it off at once (not at the cycle\'s end)', (await p.getAutopay('sub_Fx12345678')).event === 'authenticated'
    && (await p.cancelAutopay('sub_Fx12345678')).event === 'cancelled' && calls.some((c) => /\/cancel$/.test(c.url) && c.body.cancel_at_cycle_end === 0));
  let threw = false; try { await p.cancelAutopay('bogus'); } catch { threw = true; }
  check('a malformed subscription id is never sent', threw && (await p.getAutopay('../x')).event === null);
  const sub = (ev, pay) => ({ event: 'subscription.' + ev, payload: { subscription: { entity: { id: 'sub_Fx12345678', status: 'active', charge_at: 1800000000, notes: { hangtag_owner: 'u1' } } },
    ...(pay !== undefined ? { payment: { entity: pay } } : {}) } });
  const ch = p.readWebhook(sub('charged', { id: 'pay_1', amount: 99900, status: 'captured' }));
  check('webhook: a captured charge → { charged, its payment, the amount in rupees, the next charge, the shop }', ch.kind === 'autopay' && ch.event === 'charged' && ch.paymentId === 'pay_1'
    && ch.amount === 999 && ch.nextChargeAt === new Date(1800000000e3).toISOString() && ch.owner === 'u1', ch);
  check('…a charge not captured (only authorised, nothing paid, no payment) is not money: ignored', p.readWebhook(sub('charged', { id: 'pay_2', amount: 99900, status: 'authorized' })) === null
    && p.readWebhook(sub('charged', { id: 'pay_3', amount: 0, status: 'captured' })) === null && p.readWebhook(sub('charged', null)) === null);
  check('…the mandate\'s other reports', ['authenticated', 'activated', 'pending', 'halted', 'cancelled', 'completed', 'resumed'].every((e) => p.readWebhook(sub(e)).event === e)
    && p.readWebhook(sub('updated')) === null && p.readWebhook({ event: 'subscription.charged', payload: {} }) === null);
  check('…plan payment links read as before', p.readWebhook({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', status: 'paid', amount: 99900, amount_paid: 99900, notes: {} } },
    payment: { entity: { id: 'pay_9', amount: 99900, status: 'captured' } } } }).kind === 'payment');
  const wh = readFileSync(new URL('../../supabase/functions/subscription-webhook/index.ts', import.meta.url), 'utf8');
  const fn = readFileSync(new URL('../../supabase/functions/subscription/index.ts', import.meta.url), 'utf8');
  check('the webhook records AutoPay only through hangtag_autopay_event, after the signature check', wh.indexOf('provider.verifyWebhook(') > 0 && wh.indexOf('provider.verifyWebhook(') < wh.indexOf('admin.rpc("hangtag_autopay_event"') && /p_payment: target\.paymentId/.test(wh));
  check('the function records the consent AS the owner and checks the provider\'s plan before making a mandate; it never records a charge itself',
    fn.indexOf('db.rpc("hangtag_autopay_begin"') > 0 && fn.indexOf('db.rpc("hangtag_autopay_begin"') < fn.indexOf('provider.createAutopay') && fn.indexOf('provider.getPlan') < fn.indexOf('provider.createAutopay')
    && !/p_event: "charged"/.test(fn));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
