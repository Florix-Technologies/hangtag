// The subscription and subscription-webhook Edge Functions by their behaviour (supabase/functions/*/handler.js), with the
// real Razorpay provider over a scripted Razorpay API and a scripted database: a payment adds paid time only once it is
// captured and recorded; the webhook is answered 2xx only once an event is recorded or can never be (so Razorpay sends
// it again otherwise); test keys work only on a test project; AutoPay records no consent for a mandate it can't make.
// Run: node tests/unit/subscription-handlers.test.mjs
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { handleWebhook } from '../../supabase/functions/subscription-webhook/handler.js';
import { handleSubscription } from '../../supabase/functions/subscription/handler.js';
import { autopayPlanId, keyMode, providerFor } from '../../supabase/functions/subscription/providers/index.js';
import { linkState } from '../../supabase/functions/subscription/providers/razorpay.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const PID = '0b6f3a2e-8c1d-4f6a-9b2e-1c3d4e5f6a7b', SECRET = 'whsec_test';
const ENV = { SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's', SUBSCRIPTION_WEBHOOK_SECRET: SECRET, SUBSCRIPTION_TEST_MODE: 'true',
  SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID: 'plan_Abc123XYZ', APP_URL: 'https://app.hangtag.in' };

/* a scripted database client: rpc(name, args) and from(t).select().eq()….maybeSingle(); script[key] is an answer or
   (args) => answer; every call is logged in order */
function fakeDb(script = {}, log = []) {
  const answer = (key, args) => { const a = script[key]; return typeof a === 'function' ? a(args) : (a || { data: null, error: null }); };
  return {
    log,
    auth: { getUser: async () => ({ data: { user: 'user' in script ? script.user : { id: 'u1', email: 'owner@shop.in' } } }) },
    rpc: async (name, args) => { log.push('rpc:' + name); return answer('rpc:' + name, args); },
    from: (t) => { const filters = []; const q = { select: () => q, eq: (k, v) => { filters.push([k, v]); return q; },
      maybeSingle: async () => { log.push('from:' + t); return answer('from:' + t, filters); } }; return q; },
  };
}
/* Razorpay's API, scripted: "METHOD /path" → JSON (ids in paths are generalised); every call is logged */
function fakeRazorpay(routes, log = []) {
  return async (url, init = {}) => {
    const path = url.replace('https://api.razorpay.com/v1', '').replace(/\/sub_\w+/, '/sub_X').replace(/\/plan_\w+/, '/plan_X').replace(/\/plink_\w+/, '/plink_X');
    const key = (init.method || 'GET') + ' ' + path; log.push('api:' + key);
    const r = routes[key];
    return { ok: !!r, status: r ? 200 : 404, json: async () => r || {} };
  };
}
const spy = () => { const lines = []; return { lines, error: (...a) => lines.push(a.map(String).join(' ')), warn: () => {}, info: () => {} }; };
const sign = (body) => crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const webhook = async (event, { db = fakeDb(), routes = {}, env = ENV, signature, log = spy() } = {}) => {
  const raw = JSON.stringify(event), api = [];
  let made = 0;
  const r = await handleWebhook({ method: 'POST', raw, headers: { 'x-razorpay-signature': signature === undefined ? sign(raw) : signature } },
    { provider: providerFor(env, fakeRazorpay(routes, api)), secret: env.SUBSCRIPTION_WEBHOOK_SECRET, admin: () => { made++; return db; }, log });
  return { ...r, made, db, api, log };
};
const linkEvent = (type, { status = 'paid', paid = 99900, pay = { id: 'pay_9', amount: 99900, status: 'captured' } } = {}) => ({ event: type, payload: {
  payment_link: { entity: { id: 'plink_Abc123xyz', status, amount: 99900, amount_paid: paid, notes: { hangtag_payment: PID } } }, ...(pay ? { payment: { entity: pay } } : {}) } });
const ROW = { id: PID, amount: 999, status: 'created', provider_order_id: 'plink_Abc123xyz' };

console.log('=== keys: test keys only on a test project ===');
{
  check('live keys → live; test keys → refused unless SUBSCRIPTION_TEST_MODE=true; live keys refused on a test project; anything else refused',
    keyMode({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_live_x' }) === 'live' && keyMode({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1' }) === null
    && keyMode({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1', SUBSCRIPTION_TEST_MODE: 'true' }) === 'test'
    && keyMode({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_live_x', SUBSCRIPTION_TEST_MODE: 'true' }) === null && keyMode({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'k' }) === null);
  check('…so the provider is "not configured" with test keys on the live project, and says its mode otherwise',
    providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's' }) === null
    && providerFor(ENV).mode === 'test' && providerFor({ SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_live_x', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's' }).mode === 'live');
  const manifest = JSON.parse(readFileSync(new URL('../../supabase/functions/deploy.json', import.meta.url), 'utf8')), wh = manifest['subscription-webhook'];
  check('deploy.json: the webhook requires the provider keys it uses (to cancel an AutoPay Hangtag no longer tracks); the test flag is declared for both',
    ['SUBSCRIPTION_WEBHOOK_SECRET', 'SUBSCRIPTION_RAZORPAY_KEY_ID', 'SUBSCRIPTION_RAZORPAY_KEY_SECRET'].every((s) => wh.required.includes(s))
    && wh.optional.includes('SUBSCRIPTION_TEST_MODE') && manifest.subscription.optional.includes('SUBSCRIPTION_TEST_MODE'), wh);
  check('a paid link whose payment is only authorised is not money yet (pending, no payment id); captured is',
    JSON.stringify(linkState({ id: 'plink_1', status: 'paid', amount_paid: 49900, payments: [{ payment_id: 'pay_1', amount: 49900, status: 'authorized' }] })) === JSON.stringify({ state: 'pending', paid: 0, paymentId: null })
    && linkState({ id: 'plink_1', status: 'paid', amount_paid: 49900, payments: [{ payment_id: 'pay_1', amount: 49900, status: 'captured' }] }).state === 'paid');
}

console.log('=== the webhook ===');
{
  const get = await handleWebhook({ method: 'GET', raw: '', headers: {} }, { provider: providerFor(ENV), secret: SECRET, admin: () => { throw new Error('no'); } });
  const none = await webhook(linkEvent('payment_link.paid'), { env: {} });
  check('not POST → 405; no provider or no secret → 503', get.status === 405 && none.status === 503 && none.made === 0);
  const bad = await webhook(linkEvent('payment_link.paid'), { signature: 'f'.repeat(64) });
  check('a wrong signature → 400, and the database is never reached', bad.status === 400 && bad.made === 0);
  const db = fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_activate': { data: { ok: true }, error: null } });
  let args; db.rpc = ((orig) => async (n, a) => { if (n === 'hangtag_subscription_activate') args = a; return orig(n, a); })(db.rpc);
  const paid = await webhook(linkEvent('payment_link.paid'), { db });
  check('payment_link.paid, captured, for a Hangtag payment → activated once with the captured payment and the amount in rupees → 200',
    paid.status === 200 && paid.body.status === 'paid' && db.log.filter((x) => x === 'rpc:hangtag_subscription_activate').length === 1
    && args.p_payment === PID && args.p_provider_payment === 'pay_9' && args.p_amount === 999, { paid, args });
  const lookup = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: null, error: { code: '57014' } } }) });
  check('the payment lookup fails (a timeout) → 503, nothing activated: Razorpay sends it again', lookup.status === 503 && !lookup.db.log.includes('rpc:hangtag_subscription_activate'), lookup);
  const transient = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_activate': { data: null, error: { code: '08006' } } }) });
  check('activation fails for a reason that may pass (a lost connection) → 500: Razorpay sends it again', transient.status === 500, transient);
  const forGood = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_activate': { data: null, error: { code: 'P0001' } } }) });
  check('activation refused for good (P0001) → 200 (a retry can\'t help) and an error line naming the payment and the provider\'s ids',
    forGood.status === 200 && forGood.body.ok === false && forGood.log.lines.some((l) => /settle by hand/.test(l) && l.includes(PID) && l.includes('plink_Abc123xyz') && l.includes('pay_9')), forGood);
  const authorised = await webhook(linkEvent('payment_link.paid', { pay: { id: 'pay_9', amount: 99900, status: 'authorized' } }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  check('a paid link whose payment is only authorised → nothing activated, pending', authorised.status === 200 && authorised.body.status === 'pending' && !authorised.db.log.includes('rpc:hangtag_subscription_activate'), authorised);
  const mismatch = await webhook(linkEvent('payment_link.paid', { paid: 49900, pay: { id: 'pay_9', amount: 49900, status: 'captured' } }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  check('an amount that isn\'t the amount due → never activated, and an error line for Hangtag to settle', mismatch.status === 200 && mismatch.body.status === 'mismatch'
    && !mismatch.db.log.includes('rpc:hangtag_subscription_activate') && mismatch.log.lines.some((l) => /amount paid isn't the amount due/.test(l) && l.includes(PID)), mismatch);
  const expired = await webhook(linkEvent('payment_link.expired', { status: 'expired', paid: 0, pay: null }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  const failErr = await webhook(linkEvent('payment_link.expired', { status: 'expired', paid: 0, pay: null }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_fail': { data: null, error: { code: '08006' } } }) });
  check('an expired link → the payment marked expired → 200; if that can\'t be recorded → 500', expired.status === 200 && expired.db.log.includes('rpc:hangtag_subscription_fail') && failErr.status === 500, { expired, failErr });
  const other = await webhook(linkEvent('payment_link.paid'), { db: fakeDb() });
  check('a link that isn\'t a Hangtag plan payment → 200, ignored', other.status === 200 && other.body.ignored === true);
  const sub = (ev, pay) => ({ event: 'subscription.' + ev, payload: { subscription: { entity: { id: 'sub_Fx12345678', status: 'active', charge_at: 1800000000, notes: { hangtag_owner: 'u1' } } },
    ...(pay ? { payment: { entity: pay } } : {}) } });
  let ev; const adb = fakeDb({ 'rpc:hangtag_autopay_event': (a) => { ev = a; return { data: { known: true }, error: null }; } });
  const charged = await webhook(sub('charged', { id: 'pay_1', amount: 99900, status: 'captured' }), { db: adb });
  check('an AutoPay charge, captured → hangtag_autopay_event("charged", the payment, 999) → 200', charged.status === 200 && ev.p_event === 'charged' && ev.p_payment === 'pay_1' && ev.p_amount === 999, ev);
  const aErr = await webhook(sub('charged', { id: 'pay_1', amount: 99900, status: 'captured' }), { db: fakeDb({ 'rpc:hangtag_autopay_event': { data: null, error: { code: '08006' } } }) });
  check('…that can\'t be recorded → 500 (sent again)', aErr.status === 500);
  const unknown = await webhook(sub('charged', { id: 'pay_2', amount: 99900, status: 'captured' }), { db: fakeDb({ 'rpc:hangtag_autopay_event': { data: { known: false }, error: null } }),
    routes: { 'POST /subscriptions/sub_X/cancel': { id: 'sub_Fx12345678', status: 'cancelled' } } });
  check('…a charge on an AutoPay Hangtag no longer tracks → cancelled at Razorpay, and an error line to refund it', unknown.status === 200 && unknown.api.includes('api:POST /subscriptions/sub_X/cancel')
    && unknown.log.lines.some((l) => /refund it/.test(l) && l.includes('pay_2')), unknown);
}

console.log('=== the subscription function ===');
{
  const call = async (body, { script = {}, routes = {}, env = ENV, auth = 'Bearer t', method = 'POST' } = {}) => {
    const log = [], db = fakeDb(script, log), api = [];
    const provider = providerFor(env, fakeRazorpay(routes, api), () => 1_800_000_000_000);
    const r = await handleSubscription({ method, auth, device: null, json: async () => body },
      { env, provider, planId: autopayPlanId(env), userDb: () => db, admin: () => db, now: () => 1_800_000_000_000, log: spy() });
    return { ...r, log, api };
  };
  check('not POST → 405; no sign-in → 401; a token that isn\'t a user → 401', (await call({}, { method: 'GET' })).status === 405 && (await call({}, { auth: null })).status === 401
    && (await call({ action: 'config' }, { script: { user: null } })).status === 401);
  const cfgNone = await call({ action: 'config' }, { env: {} }), cfg = await call({ action: 'config' });
  check('config: nothing set up → not available; keys and the AutoPay plan → available with AutoPay', cfgNone.body.available === false && cfgNone.body.autopay === false && cfg.body.available === true && cfg.body.autopay === true);
  const free = await call({ action: 'checkout', plan: 'm1', promo: 'FREE100' }, { script: { 'rpc:hangtag_subscription_quote': { data: { amount: 0 }, error: null },
    'rpc:hangtag_subscription_checkout': { data: { payment_id: PID, amount: 0, currency: 'INR' }, error: null }, 'rpc:hangtag_subscription_activate': { data: { ok: true, state: 'paid_active' }, error: null } } });
  check('a checkout with nothing to pay → activated as "free:<payment>", and Razorpay never called', free.status === 200 && free.body.free === true && free.api.length === 0 && free.log.includes('rpc:hangtag_subscription_activate'), free);
  const noProvider = await call({ action: 'checkout', plan: 'm1' }, { env: {}, script: { 'rpc:hangtag_subscription_quote': { data: { amount: 499 }, error: null } } });
  check('something to pay with online payment not set up → 503, and no payment created', noProvider.status === 503 && !noProvider.log.includes('rpc:hangtag_subscription_checkout'), noProvider);
  const terms = { available: true, plan: { code: 'm1', months: 1 }, price: 999, currency: 'INR', today: 0, first_charge_at: new Date(1_800_000_000_000 + 20 * 864e5).toISOString(), consent_version: 'terms-1' };
  const planRoute = (amount) => ({ 'GET /plans/plan_X': { id: 'plan_Abc123XYZ', period: 'monthly', interval: 1, item: { amount, currency: 'INR' } },
    'POST /subscriptions': { id: 'sub_Fx12345678', short_url: 'https://rzp.io/i/abc', status: 'created', customer_id: 'cust_9' } });
  const wrongPlan = await call({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }, { routes: planRoute(49900),
    script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'rpc:hangtag_autopay_begin': { data: terms, error: null } } });
  check('AutoPay: the provider\'s plan isn\'t the AutoPay price → 503, and NO consent recorded (hangtag_autopay_begin never called), no mandate',
    wrongPlan.status === 503 && !wrongPlan.log.includes('rpc:hangtag_autopay_begin') && !wrongPlan.api.includes('api:POST /subscriptions'), wrongPlan);
  const started = await call({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }, { routes: planRoute(99900),
    script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'rpc:hangtag_autopay_begin': { data: terms, error: null }, 'rpc:hangtag_autopay_attach': { data: { ok: true }, error: null } } });
  // the database's and Razorpay's calls in one log, to see their order
  const all = [], db2 = fakeDb({ 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'rpc:hangtag_autopay_begin': { data: terms, error: null },
    'rpc:hangtag_autopay_attach': { data: { ok: true }, error: null } }, all);
  await handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => ({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }) },
    { env: ENV, provider: providerFor(ENV, fakeRazorpay(planRoute(99900), all), () => 1_800_000_000_000), planId: autopayPlanId(ENV), userDb: () => db2, admin: () => db2, now: () => 1_800_000_000_000, log: spy() });
  const seq = all.filter((x) => /quote|plans|begin|POST \/subscriptions$|attach/.test(x));
  check('…a matching plan: the terms, the provider\'s plan, then the consent, the mandate and its record, in that order',
    started.status === 200 && started.body.auth_url === 'https://rzp.io/i/abc'
    && JSON.stringify(seq) === JSON.stringify(['rpc:hangtag_autopay_quote', 'api:GET /plans/plan_X', 'rpc:hangtag_autopay_begin', 'api:POST /subscriptions', 'rpc:hangtag_autopay_attach']), seq);
  const notOwner = await call({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }, { routes: planRoute(99900),
    script: { 'rpc:hangtag_autopay_quote': { data: null, error: { code: 'P0001', message: 'Only the shop owner can set up AutoPay.' } } } });
  check('…a team member (the database refuses the terms) → 400 with the reason, and Razorpay never asked', notOwner.status === 400 && notOwner.api.length === 0 && /shop owner/.test(notOwner.body.message), notOwner);
  let evd; const verified = await call({ action: 'autopay_verify' }, { routes: { 'GET /subscriptions/sub_X': { id: 'sub_Fx12345678', status: 'active', charge_at: 1800000000 } },
    script: { 'from:hangtag_subscriptions': { data: { autopay_provider: 'razorpay', autopay_subscription_id: 'sub_Fx12345678', autopay_status: 'active' }, error: null },
      'rpc:hangtag_autopay_event': (a) => { evd = a; return { data: { known: true }, error: null }; } } });
  check('autopay_verify records the mandate\'s state from Razorpay, never a charge', verified.status === 200 && evd.p_event === 'activated' && evd.p_event !== 'charged' && !('p_payment' in evd), evd);
  const payRow = { id: PID, owner_id: 'u1', amount: 999, status: 'created', provider: 'razorpay', provider_order_id: 'plink_Abc123xyz' };
  const link = { 'GET /payment_links/plink_X': { id: 'plink_Abc123xyz', status: 'paid', amount_paid: 99900, payments: [{ payment_id: 'pay_9', amount: 99900, status: 'captured' }] } };
  const vTransient = await call({ action: 'verify', payment_id: PID }, { routes: link, script: { 'from:hangtag_subscription_payments': { data: payRow, error: null }, 'rpc:hangtag_subscription_activate': { data: null, error: { code: '08006' } } } });
  const vForGood = await call({ action: 'verify', payment_id: PID }, { routes: link, script: { 'from:hangtag_subscription_payments': { data: payRow, error: null }, 'rpc:hangtag_subscription_activate': { data: null, error: { code: 'P0001' } } } });
  const vOk = await call({ action: 'verify', payment_id: PID }, { routes: link, script: { 'from:hangtag_subscription_payments': { data: payRow, error: null }, 'rpc:hangtag_subscription_activate': { data: { ok: true, state: 'paid_active', plan_code: 'm1' }, error: null } } });
  check('verify: captured → activated (200); a passing failure → 503 "try again"; a refusal for good → 409 "contact support"',
    vOk.status === 200 && vOk.body.status === 'paid' && vTransient.status === 503 && /Try again/.test(vTransient.body.message) && vForGood.status === 409, { vOk, vTransient, vForGood });
  const theirs = await call({ action: 'verify', payment_id: PID }, { script: { 'from:hangtag_subscription_payments': { data: { ...payRow, owner_id: 'someone-else' }, error: null } } });
  check('verify: another shop\'s payment → 404', theirs.status === 404);
}

console.log('=== the Edge Functions are only the wiring ===');
{
  for (const fn of ['subscription', 'subscription-webhook']) {
    const src = readFileSync(new URL(`../../supabase/functions/${fn}/index.ts`, import.meta.url), 'utf8');
    check(`${fn}/index.ts imports its handler and makes no database or provider call of its own`, /from "\.\/handler\.js"/.test(src) && !/\.rpc\(|\.from\(|provider\.\w+\(/.test(src), fn);
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
