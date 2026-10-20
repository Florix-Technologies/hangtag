// The subscription and subscription-webhook Edge Functions by their behaviour (supabase/functions/*/handler.js), with the
// real Razorpay provider over a scripted Razorpay API and a scripted database: a payment adds paid time only once it is
// captured and recorded; the webhook is answered 2xx only once an event is recorded or can never be (so Razorpay sends
// it again otherwise); test keys work only on a test project; AutoPay records no consent for a mandate it can't make.
// Run: node tests/unit/subscription-handlers.test.mjs
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { handleWebhook } from '../../supabase/functions/subscription-webhook/handler.js';
import { handleSubscription } from '../../supabase/functions/subscription/handler.js';
import { autopayPlanId, autopayProviderFor, keyMode, providerFor, providerNamed } from '../../supabase/functions/subscription/providers/index.js';
import { linkState } from '../../supabase/functions/subscription/providers/razorpay.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const PID = '0b6f3a2e-8c1d-4f6a-9b2e-1c3d4e5f6a7b', SECRET = 'whsec_test';
const ENV = { SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_test_1', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's', SUBSCRIPTION_WEBHOOK_SECRET: SECRET, SUBSCRIPTION_TEST_MODE: 'true',
  SUBSCRIPTION_RAZORPAY_AUTOPAY_PLAN_ID: 'plan_Abc123XYZ', APP_URL: 'https://app.hangtag.in' };

/* a scripted database client: rpc(name, args) and from(t).select().eq()….maybeSingle(); script[key] is an answer or
   (args) => answer; every call is logged in order */
/* A test project's database after the post-repair migration (these tests use test keys, which only it takes): the ledger
   and the billing mode answer in test mode, and the mode-checked activation calls the activation, as the real one does.
   The migration's other functions answer only when a test scripts them (else PGRST202, as before the migration); with
   { premigration: true } none of them exists, as on the live project today. */
const MIGRATED = {
  'rpc:hangtag_billing_event_seen': (a) => ({ data: { duplicate: false, mode_ok: a.p_mode === 'test', billing_mode: 'test' }, error: null }),
  'rpc:hangtag_billing_mode': { data: 'test', error: null },
};
const MIGRATION_RPCS = ['hangtag_billing_event_seen', 'hangtag_billing_event_record', 'hangtag_billing_exception_open', 'hangtag_billing_mode',
  'hangtag_subscription_activate_checked', 'hangtag_autopay_report', 'hangtag_autopay_attach_mandate', 'hangtag_autopay_orphan', 'hangtag_autopay_check_claim',
  'hangtag_autopay_known', 'hangtag_billing_probe_record', 'hangtag_billing_selfcheck_allowed', 'hangtag_billing_call_claim'];
function fakeDb(script = {}, log = [], { premigration = false } = {}) {
  const answer = (key, args) => {
    if (key in script) { const a = script[key]; return typeof a === 'function' ? a(args) : (a || { data: null, error: null }); }
    if (!premigration && key in MIGRATED) { const a = MIGRATED[key]; return typeof a === 'function' ? a(args) : a; }
    if (MIGRATION_RPCS.includes(key.slice(4)) && (premigration || key !== 'rpc:hangtag_subscription_activate_checked')) return { data: null, error: { code: 'PGRST202', message: 'not found' } };
    return { data: null, error: null };
  };
  return {
    log,
    auth: { getUser: async () => ({ data: { user: 'user' in script ? script.user : { id: 'u1', email: 'owner@shop.in' } } }) },
    rpc: async (name, args) => {
      log.push('rpc:' + name);
      if (name === 'hangtag_subscription_activate_checked' && !premigration && !('rpc:hangtag_subscription_activate_checked' in script)) {
        const { p_mode, ...inner } = args;
        log.push('rpc:hangtag_subscription_activate');
        return answer('rpc:hangtag_subscription_activate', inner);
      }
      return answer('rpc:' + name, args);
    },
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
const linkEvent = (type, { status = 'paid', paid = 99900, pay = { id: 'pay_9', amount: 99900, status: 'captured' }, notes = { hangtag_payment: PID } } = {}) => ({ event: type, payload: {
  payment_link: { entity: { id: 'plink_Abc123xyz', status, amount: 99900, amount_paid: paid, notes } }, ...(pay ? { payment: { entity: pay } } : {}) } });
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
  const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  check('deploy.json: the webhook needs Razorpay\'s webhook secret with its keys (it cancels an AutoPay Hangtag no longer tracks), or Cashfree\'s keys; the test flag is declared for both',
    wh.anyOf.length === 2 && sameSet(wh.anyOf[0], ['SUBSCRIPTION_WEBHOOK_SECRET', 'SUBSCRIPTION_RAZORPAY_KEY_ID', 'SUBSCRIPTION_RAZORPAY_KEY_SECRET'])
    && sameSet(wh.anyOf[1], ['SUBSCRIPTION_CASHFREE_APP_ID', 'SUBSCRIPTION_CASHFREE_SECRET_KEY']) && !wh.required
    && wh.optional.includes('SUBSCRIPTION_TEST_MODE') && manifest.subscription.optional.includes('SUBSCRIPTION_TEST_MODE') && manifest.subscription.required.join() === 'APP_URL', wh);
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
  let args; db.rpc = ((orig) => async (n, a) => { if (n === 'hangtag_subscription_activate_checked') args = a; return orig(n, a); })(db.rpc);
  const paid = await webhook(linkEvent('payment_link.paid'), { db });
  check('payment_link.paid, captured, for a Hangtag payment → activated once (in the database\'s billing mode) with the captured payment and the amount in rupees → 200',
    paid.status === 200 && paid.body.status === 'paid' && db.log.filter((x) => x === 'rpc:hangtag_subscription_activate').length === 1
    && args.p_payment === PID && args.p_provider_payment === 'pay_9' && args.p_amount === 999 && args.p_mode === 'test', { paid, args });
  const lookup = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: null, error: { code: '57014' } } }) });
  check('the payment lookup fails (a timeout) → 503, nothing activated: Razorpay sends it again', lookup.status === 503 && !lookup.db.log.includes('rpc:hangtag_subscription_activate'), lookup);
  const transient = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_activate': { data: null, error: { code: '08006' } } }) });
  check('activation fails for a reason that may pass (a lost connection) → 500: Razorpay sends it again', transient.status === 500, transient);
  const forGood = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_activate': { data: null, error: { code: 'P0001' } } }) });
  check('activation refused for good (P0001) → 200 (a retry can\'t help), kept for review, and an error line naming the payment and the provider\'s ids',
    forGood.status === 200 && forGood.body.ok === false && forGood.db.log.includes('rpc:hangtag_billing_exception_open')
    && forGood.log.lines.some((l) => /activation_refused \(review\)/.test(l) && l.includes(PID) && l.includes('pay_9')), forGood);
  const authorised = await webhook(linkEvent('payment_link.paid', { pay: { id: 'pay_9', amount: 99900, status: 'authorized' } }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  check('a paid link whose payment is only authorised → nothing activated, pending', authorised.status === 200 && authorised.body.status === 'pending' && !authorised.db.log.includes('rpc:hangtag_subscription_activate'), authorised);
  const mismatch = await webhook(linkEvent('payment_link.paid', { paid: 49900, pay: { id: 'pay_9', amount: 49900, status: 'captured' } }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  check('an amount that isn\'t the amount due → never activated, and an error line for Hangtag to settle', mismatch.status === 200 && mismatch.body.status === 'mismatch'
    && !mismatch.db.log.includes('rpc:hangtag_subscription_activate') && mismatch.db.log.includes('rpc:hangtag_billing_exception_open')
    && mismatch.log.lines.some((l) => /amount_mismatch \(review\)/.test(l) && l.includes(PID)), mismatch);
  const expired = await webhook(linkEvent('payment_link.expired', { status: 'expired', paid: 0, pay: null }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  const failErr = await webhook(linkEvent('payment_link.expired', { status: 'expired', paid: 0, pay: null }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_fail': { data: null, error: { code: '08006' } } }) });
  check('an expired link → the payment marked expired → 200; if that can\'t be recorded → 500', expired.status === 200 && expired.db.log.includes('rpc:hangtag_subscription_fail') && failErr.status === 500, { expired, failErr });
  const other = await webhook(linkEvent('payment_link.paid', { notes: { florix_order: 'shop-77' } }), { db: fakeDb() });
  check('a link that isn\'t a Hangtag plan payment → 200, ignored', other.status === 200 && other.body.ignored === true && !other.db.log.includes('rpc:hangtag_billing_exception_open'));
  const unrecorded = await webhook(linkEvent('payment_link.paid'), { db: fakeDb() });
  check('…one whose note names a Hangtag payment but that no payment recorded, paid → never activated, kept for review (unknown_order)',
    unrecorded.status === 200 && unrecorded.body.status === 'unmatched' && !unrecorded.db.log.includes('rpc:hangtag_subscription_activate')
    && unrecorded.log.lines.some((l) => /unknown_order \(review\)/.test(l) && l.includes('plink_Abc123xyz')), unrecorded);
  const sub = (ev, pay, notes = { hangtag_owner: 'u1' }) => ({ event: 'subscription.' + ev, created_at: 1790000000,
    payload: { subscription: { entity: { id: 'sub_Fx12345678', status: 'active', charge_at: 1800000000, created_at: 1700000000, notes } },
    ...(pay ? { payment: { entity: pay } } : {}) } });
  let ev; const adb = fakeDb({ 'rpc:hangtag_autopay_report': (a) => { ev = a; return { data: { known: true, recorded: true }, error: null }; } });
  const charged = await webhook(sub('charged', { id: 'pay_1', amount: 99900, currency: 'INR', status: 'captured' }), { db: adb });
  check('an AutoPay charge, captured → hangtag_autopay_report("charged", the payment, 999, INR, the event\'s own time — not the subscription\'s — in the billing mode) → 200',
    charged.status === 200 && ev.p_event === 'charged' && ev.p_payment === 'pay_1' && ev.p_amount === 999 && ev.p_currency === 'INR'
    && ev.p_event_at === new Date(1790000000e3).toISOString() && ev.p_mode === 'test' && !adb.log.includes('rpc:hangtag_autopay_event'), ev);
  const aErr = await webhook(sub('charged', { id: 'pay_1', amount: 99900, status: 'captured' }), { db: fakeDb({ 'rpc:hangtag_autopay_report': { data: null, error: { code: '08006' } } }) });
  check('…that can\'t be recorded → 500 (sent again)', aErr.status === 500);
  const unknown = await webhook(sub('charged', { id: 'pay_2', amount: 99900, status: 'captured' }), { db: fakeDb({ 'rpc:hangtag_autopay_report': { data: { known: false }, error: null } }),
    routes: { 'POST /subscriptions/sub_X/cancel': { id: 'sub_Fx12345678', status: 'cancelled' } } });
  check('…a charge on an AutoPay Hangtag no longer tracks → cancelled at Razorpay, kept for review (to refund it), and an error line with its id',
    unknown.status === 200 && unknown.api.includes('api:POST /subscriptions/sub_X/cancel') && unknown.db.log.includes('rpc:hangtag_billing_exception_open')
    && unknown.log.lines.some((l) => /unknown_mandate_charge \(review\)/.test(l) && l.includes('pay_2')) && !unknown.db.log.includes('rpc:hangtag_autopay_orphan'), unknown);
  const stuck = await webhook(sub('activated'), { db: fakeDb({ 'rpc:hangtag_autopay_report': { data: { known: false }, error: null }, 'rpc:hangtag_autopay_orphan': { data: { registered: true }, error: null } }),
    routes: { 'POST /subscriptions/sub_X/cancel': null } });
  check('…an untracked one that can\'t be cancelled now → kept in the registry to be cancelled by the reconciler (no 5xx: Razorpay would stop sending)',
    stuck.status === 200 && stuck.db.log.includes('rpc:hangtag_autopay_orphan'), stuck);
  let rep = []; const replaced = await webhook(sub('activated'), { db: fakeDb({ 'rpc:hangtag_autopay_report': (a) => { rep.push(a.p_event); return { data: { known: true, current: false, cancel: true }, error: null }; } }),
    routes: { 'POST /subscriptions/sub_X/cancel': { id: 'sub_Fx12345678', status: 'cancelled' } } });
  check('a replaced set-up still on at Razorpay → cancelled within the answer\'s budget, and the cancellation reported', replaced.status === 200
    && replaced.api.includes('api:POST /subscriptions/sub_X/cancel') && JSON.stringify(rep) === JSON.stringify(['activated', 'cancelled']), { rep, api: replaced.api });
  // a database before the post-repair migration (live today): the older functions, live keys only
  const LIVE_ENV = { ...ENV, SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_live_1', SUBSCRIPTION_TEST_MODE: '' };
  let legacy; const old = await webhook(sub('charged', { id: 'pay_1', amount: 99900, status: 'captured' }), { env: LIVE_ENV,
    db: fakeDb({ 'rpc:hangtag_autopay_event': (a) => { legacy = a; return { data: { known: true }, error: null }; } }, [], { premigration: true }) });
  const oldLink = await webhook(linkEvent('payment_link.paid'), { env: LIVE_ENV, db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null },
    'rpc:hangtag_subscription_activate': { data: { ok: true }, error: null } }, [], { premigration: true }) });
  check('before the migration, live keys: the older AutoPay function and the plain activation are used (the newer ones answer "not found")',
    old.status === 200 && legacy && legacy.p_event === 'charged' && !('p_mode' in legacy) && oldLink.status === 200 && oldLink.body.status === 'paid'
    && oldLink.db.log.includes('rpc:hangtag_subscription_activate_checked') && oldLink.db.log.includes('rpc:hangtag_subscription_activate'), { old, oldLink: oldLink.db.log });
  const testOnOld = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }, [], { premigration: true }) });
  check('…test keys on such a database: never acted on (200, a notification in another billing mode)', testOnOld.status === 200 && testOnOld.body.mode_mismatch === true
    && !testOnOld.db.log.some((l) => /activate|from:hangtag_subscription_payments/.test(l)), testOnOld.db.log);
  const otherMode = await webhook(linkEvent('payment_link.paid'), { db: fakeDb({ 'rpc:hangtag_billing_event_seen': { data: { duplicate: false, mode_ok: false, billing_mode: 'live' }, error: null },
    'rpc:hangtag_billing_exception_open': { data: { opened: true }, error: null } }) });
  check('…and on a live database: kept for review as mode_mismatch, nothing read or activated', otherMode.status === 200 && otherMode.body.mode_mismatch === true
    && otherMode.db.log.includes('rpc:hangtag_billing_exception_open') && !otherMode.db.log.some((l) => /activate|from:hangtag_subscription_payments/.test(l)), otherMode.db.log);
  let recorded; const probeDb = fakeDb({ 'rpc:hangtag_billing_event_record': (a) => { recorded = a; return { data: { duplicate: false }, error: null }; } });
  const probe = await webhook({ event: 'payment_link.cancelled', created_at: 1790000100, payload: { payment_link: { entity: { id: 'plink_Prb12345', status: 'cancelled', amount: 100,
    amount_paid: 0, notes: { hangtag_probe: 'r1' } } } } }, { db: probeDb });
  check('the self-check\'s link cancelled → noted (type, link, its signed time, test mode, probe), never looked up or acted on',
    probe.status === 200 && probe.body.probe === true && recorded && recorded.p_type === 'payment_link.cancelled' && recorded.p_entity === 'plink_Prb12345'
    && recorded.p_created_at === new Date(1790000100e3).toISOString() && recorded.p_mode === 'test' && recorded.p_probe === true
    && !probeDb.log.some((l) => /from:hangtag_subscription_payments|autopay_report/.test(l)), { recorded, log: probeDb.log });
  const opened = (db) => db.calls || [];
  let refundArgs; const refundDb = fakeDb({ 'from:hangtag_subscription_payments': { data: { id: PID, owner_id: 'u1', status: 'paid', provider_order_id: 'plink_Abc123xyz' }, error: null },
    'rpc:hangtag_billing_exception_open': (a) => { refundArgs = a; return { data: { opened: true }, error: null }; } });
  const refund = await webhook({ event: 'refund.processed', created_at: 1790000200, payload: { refund: { entity: { id: 'rfnd_Aa12345678', payment_id: 'pay_Ref1234567', amount: 49900, currency: 'INR', status: 'processed' } },
    payment: { entity: { id: 'pay_Ref1234567', amount: 99900, status: 'captured', refund_status: 'partial', notes: {} } } } }, { db: refundDb });
  check('refund.processed for a recorded payment → kept for review (refund, its own id, the provider payment, ₹499), no time touched',
    refund.status === 200 && refundArgs && refundArgs.p_kind === 'refund' && refundArgs.p_ref === 'rfnd_Aa12345678' && refundArgs.p_provider_payment === 'pay_Ref1234567'
    && refundArgs.p_amount === 499 && refundArgs.p_payment === PID && !refundDb.log.some((l) => /activate|autopay_report|subscription_fail/.test(l)), refundArgs);
  const foreignRefund = await webhook({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_Bb12345678', payment_id: 'pay_Other1234', amount: 100, currency: 'INR', status: 'processed' } },
    payment: { entity: { id: 'pay_Other1234', amount: 100, status: 'refunded', notes: { order: 'x' } } } } }, { db: fakeDb({ 'from:hangtag_subscription_payments': { data: null, error: null } }) });
  let disputeArgs; const dispute = await webhook({ event: 'payment.dispute.created', payload: { dispute: { entity: { id: 'disp_Cc12345678', payment_id: 'pay_Dsp1234567', amount: 99900, currency: 'INR', status: 'open' } },
    payment: { entity: { id: 'pay_Dsp1234567', amount: 99900, status: 'captured', notes: { hangtag_payment: PID } } } } },
    { db: fakeDb({ 'from:hangtag_subscription_payments': { data: null, error: null }, 'rpc:hangtag_billing_exception_open': (a) => { disputeArgs = a; return { data: { opened: true }, error: null }; } }) });
  check('…another product\'s refund → ignored; a dispute on Hangtag money not recorded yet → kept for review too (its payment then adds no time)',
    foreignRefund.status === 200 && foreignRefund.body.ignored === true && dispute.status === 200 && disputeArgs && disputeArgs.p_kind === 'dispute'
    && disputeArgs.p_ref === 'disp_Cc12345678' && disputeArgs.p_provider_payment === 'pay_Dsp1234567' && disputeArgs.p_detail.recorded === false, { foreignRefund: foreignRefund.body, disputeArgs });
  void opened;
}

console.log('=== the subscription function ===');
{
  const call = async (body, { script = {}, routes = {}, env = ENV, auth = 'Bearer t', method = 'POST' } = {}) => {
    const log = [], db = fakeDb(script, log), api = [];
    const fx = fakeRazorpay(routes, api), at = () => 1_800_000_000_000, provider = providerFor(env, fx, at);
    const r = await handleSubscription({ method, auth, device: null, json: async () => body },
      { env, provider, autopay: autopayProviderFor(env, fx, at), named: (n) => providerNamed(n, env, fx, at), planId: autopayPlanId(env), userDb: () => db, admin: () => db, now: at, log: spy() });
    return { ...r, log, api };
  };
  check('not POST → 405; no sign-in → 401; a token that isn\'t a user → 401', (await call({}, { method: 'GET' })).status === 405 && (await call({}, { auth: null })).status === 401
    && (await call({ action: 'config' }, { script: { user: null } })).status === 401);
  const cfgNone = await call({ action: 'config' }, { env: {} }), cfg = await call({ action: 'config' }, { script: { 'rpc:hangtag_autopay_quote': { data: { available: true }, error: null } } });
  const cfgOff = await call({ action: 'config' }, { script: { 'rpc:hangtag_autopay_quote': { data: { available: false }, error: null } } });
  const cfgTeam = await call({ action: 'config' }, { script: { 'rpc:hangtag_autopay_quote': { data: null, error: { code: 'P0001', message: 'Only the shop owner…' } } } });
  check('config: nothing set up → not available; keys and the AutoPay plan → available, with AutoPay only when the database offers it (switched on, its webhook proven; never to a team member)',
    cfgNone.body.available === false && cfgNone.body.autopay === false && cfg.body.available === true && cfg.body.autopay === true
    && cfgOff.body.available === true && cfgOff.body.autopay === false && cfgTeam.body.autopay === false, { cfg: cfg.body, cfgOff: cfgOff.body, cfgTeam: cfgTeam.body });
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
    { env: ENV, provider: providerFor(ENV, fakeRazorpay(planRoute(99900), all), () => 1_800_000_000_000), autopay: autopayProviderFor(ENV, fakeRazorpay(planRoute(99900), all), () => 1_800_000_000_000), planId: autopayPlanId(ENV), userDb: () => db2, admin: () => db2, now: () => 1_800_000_000_000, log: spy() });
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

console.log('=== the billing remediation, through the subscription function ===');
{
  const run = async (body, { script = {}, routes = {}, env = ENV, premigration = false } = {}) => {
    const log = [], db = fakeDb(script, log, { premigration }), api = [], calls = [];
    const rec = (n, a) => calls.push({ n, a });
    db.rpc = ((orig) => async (n, a) => { rec(n, a); return orig(n, a); })(db.rpc);
    const fx = fakeRazorpay(routes, api), at = () => 1_800_000_000_000;
    const r = await handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => body },
      { env, provider: providerFor(env, fx, at), autopay: autopayProviderFor(env, fx, at), named: (n) => providerNamed(n, env, fx, at), planId: autopayPlanId(env),
        userDb: () => db, admin: () => db, now: at, log: spy(), newId: () => 'probe-ref-1' });
    return { ...r, log, api, calls };
  };
  const terms = { available: true, plan: { code: 'm1', months: 1 }, price: 999, currency: 'INR', today: 0, first_charge_at: new Date(1_800_000_000_000 + 20 * 864e5).toISOString(), consent_version: 'terms-1' };
  const planRoute = { 'GET /plans/plan_X': { id: 'plan_Abc123XYZ', period: 'monthly', interval: 1, item: { amount: 99900, currency: 'INR' } },
    'POST /subscriptions': { id: 'sub_New1234567', short_url: 'https://rzp.io/i/new', status: 'created', customer_id: 'cust_9' },
    'POST /subscriptions/sub_X/cancel': { id: 'sub_Old1234567', status: 'cancelled' } };
  const begin = { ...terms, mandate_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', to_cancel: [{ provider: 'razorpay', subscription_id: 'sub_Old1234567' }] };
  let made = null;
  const routes = { ...planRoute };
  const st = await run({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }, { routes,
    script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'rpc:hangtag_autopay_begin': { data: begin, error: null },
      'rpc:hangtag_autopay_report': { data: { known: true }, error: null },
      'rpc:hangtag_autopay_attach_mandate': (a) => { made = a; return { data: { ok: true, current: true }, error: null }; } } });
  const reports = st.calls.filter((c) => c.n === 'hangtag_autopay_report').map((c) => c.a.p_subscription + ':' + c.a.p_event);
  check('AutoPay set up again: the earlier set-up the database hands back is cancelled at Razorpay and reported; the new one is attached by its registry id, in the billing mode',
    st.status === 200 && st.api.includes('api:POST /subscriptions/sub_X/cancel') && reports.includes('sub_Old1234567:cancelled')
    && made && made.p_mandate === begin.mandate_id && made.p_subscription === 'sub_New1234567' && made.p_mode === 'test'
    && !st.calls.some((c) => c.n === 'hangtag_autopay_attach'), { status: st.status, reports, made, api: st.api });
  const replaced = await run({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }, { routes,
    script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'rpc:hangtag_autopay_begin': { data: { ...begin, to_cancel: [] }, error: null },
      'rpc:hangtag_autopay_report': { data: { known: true }, error: null }, 'rpc:hangtag_autopay_attach_mandate': { data: { ok: true, current: false }, error: null } } });
  check('…turned off (or set up again) meanwhile: the mandate just made is cancelled at once, and the owner asked to try again (409)',
    replaced.status === 409 && replaced.api.filter((x) => x === 'api:POST /subscriptions/sub_X/cancel').length === 1, { status: replaced.status, api: replaced.api });
  // the owner's own check: the registry claims a read at most every 5 minutes, and it recovers a charge no notification recorded
  const row = { autopay_provider: 'razorpay', autopay_subscription_id: 'sub_Fx12345678', autopay_status: 'active' };
  const charges = [];
  const verify = await run({ action: 'autopay_verify' }, {
    routes: { 'GET /subscriptions/sub_X': { id: 'sub_Fx12345678', status: 'active', charge_at: 1800000000, paid_count: 2 },
      'GET /invoices?count=100&skip=0&subscription_id=sub_Fx12345678': { items: [{ id: 'inv_A12345678', status: 'paid', payment_id: 'pay_One1234567' },
        { id: 'inv_B12345678', status: 'paid', payment_id: 'pay_Two1234567' }] },
      'GET /payments/pay_Two1234567': { id: 'pay_Two1234567', status: 'captured', captured: true, amount: 99900, currency: 'INR', created_at: 1799000000 } },
    script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'from:hangtag_subscriptions': { data: row, error: null },
      'rpc:hangtag_autopay_check_claim': { data: { id: 'm-1', provider: 'razorpay', subscription_id: 'sub_Fx12345678', price: 999, currency: 'INR', recorded: ['pay_One1234567'] }, error: null },
      'rpc:hangtag_autopay_report': (a) => { charges.push(a); return { data: { known: true, recorded: a.p_event === 'charged' }, error: null }; } } });
  const ch = charges.find((c) => c.p_event === 'charged');
  check('autopay_verify (claimed): the state reported as read now, and the paid invoice no one recorded → that captured payment recorded once (its own time, amount, currency)',
    verify.status === 200 && charges.some((c) => c.p_event === 'activated' && c.p_event_at) && ch && ch.p_payment === 'pay_Two1234567' && ch.p_amount === 999
    && ch.p_currency === 'INR' && ch.p_event_at === new Date(1799000000e3).toISOString() && !verify.api.includes('api:GET /payments/pay_One1234567'), { charges, api: verify.api });
  const throttled = await run({ action: 'autopay_verify' }, { script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'from:hangtag_subscriptions': { data: row, error: null },
    'rpc:hangtag_autopay_check_claim': { data: null, error: null } } });
  check('…read within the last 5 minutes (no claim): the stored state, Razorpay not asked', throttled.status === 200 && throttled.body.status === 'active' && throttled.api.length === 0, throttled.api);
  // a manual payment while AutoPay is halted: that mandate is cancelled first, or no payment
  const payRoutes = { 'POST /payment_links': { id: 'plink_Abc123xyz', short_url: 'https://rzp.io/l/x' }, 'POST /subscriptions/sub_X/cancel': { id: 'sub_Halt123456', status: 'cancelled' } };
  const quote = { 'rpc:hangtag_subscription_quote': { data: { amount: 999 }, error: null } };
  const halted = await run({ action: 'checkout', plan: 'm1' }, { routes: payRoutes, script: { ...quote, 'rpc:hangtag_autopay_report': { data: { known: true }, error: null },
    'rpc:hangtag_subscription_checkout': { data: { payment_id: PID, amount: 999, currency: 'INR', cancel_mandate: { provider: 'razorpay', subscription_id: 'sub_Halt123456' } }, error: null } } });
  check('checkout while AutoPay is halted: the halted mandate cancelled at Razorpay and reported, then the page made',
    halted.status === 200 && halted.api.indexOf('api:POST /subscriptions/sub_X/cancel') >= 0 && halted.api.indexOf('api:POST /subscriptions/sub_X/cancel') < halted.api.indexOf('api:POST /payment_links')
    && halted.calls.some((c) => c.n === 'hangtag_autopay_report' && c.a.p_event === 'cancelled' && c.a.p_subscription === 'sub_Halt123456'), { status: halted.status, api: halted.api });
  const haltedFails = await run({ action: 'checkout', plan: 'm1' }, { routes: { 'POST /payment_links': payRoutes['POST /payment_links'] },
    script: { ...quote, 'rpc:hangtag_subscription_checkout': { data: { payment_id: PID, amount: 999, currency: 'INR', cancel_mandate: { provider: 'razorpay', subscription_id: 'sub_Halt123456' } }, error: null } } });
  check('…when it can\'t be turned off: the payment failed, 502, and no page made', haltedFails.status === 502 && !haltedFails.api.includes('api:POST /payment_links')
    && haltedFails.calls.some((c) => c.n === 'hangtag_subscription_fail'), { status: haltedFails.status, api: haltedFails.api });
  const attachGone = await run({ action: 'checkout', plan: 'm1' }, { routes: { 'POST /payment_links': payRoutes['POST /payment_links'], 'POST /payment_links/plink_X/cancel': {} },
    script: { ...quote, 'rpc:hangtag_subscription_checkout': { data: { payment_id: PID, amount: 999, currency: 'INR' }, error: null },
      'rpc:hangtag_subscription_attach': { data: null, error: { code: 'P0001', message: 'This payment can\'t take a payment page any more.' } } } });
  check('a page that can\'t be attached (the payment no longer open) → withdrawn at Razorpay, 409, and the payment left as it is',
    attachGone.status === 409 && attachGone.api.includes('api:POST /payment_links/plink_X/cancel') && !attachGone.calls.some((c) => c.n === 'hangtag_subscription_fail'), { status: attachGone.status, api: attachGone.api });
  const testKeysOld = await run({ action: 'checkout', plan: 'm1' }, { premigration: true, routes: payRoutes, script: { ...quote } });
  check('test keys on a database without the billing mode (before the migration): no checkout (503), nothing made', testKeysOld.status === 503 && testKeysOld.api.length === 0
    && !testKeysOld.calls.some((c) => c.n === 'hangtag_subscription_checkout'), testKeysOld.body);
  // REMEDIATION step 11: the provider asked a limited number of times per account (the database counts)
  const vPay = { 'from:hangtag_subscription_payments': { data: { id: PID, owner_id: 'u1', amount: 999, currency: 'INR', status: 'created', provider: 'razorpay', provider_order_id: 'plink_Abc123xyz' }, error: null } };
  const vLink = { 'GET /payment_links/plink_X': { id: 'plink_Abc123xyz', status: 'paid', amount_paid: 99900, payments: [{ payment_id: 'pay_9', amount: 99900, status: 'captured' }] } };
  const vActivate = { 'rpc:hangtag_subscription_activate': { data: { ok: true, state: 'paid_active', plan_code: 'm1' }, error: null } };
  const over = { 'rpc:hangtag_billing_call_claim': { data: { ok: false, retry_after: 42 }, error: null } };
  const vUnder = await run({ action: 'verify', payment_id: PID }, { routes: vLink, script: { ...vPay, ...vActivate, 'rpc:hangtag_billing_call_claim': { data: { ok: true }, error: null } } });
  const vClaim = vUnder.calls.find((c) => c.n === 'hangtag_billing_call_claim');
  const vOver = await run({ action: 'verify', payment_id: PID }, { routes: vLink, script: { ...vPay, ...vActivate, ...over } });
  const vBroken = await run({ action: 'verify', payment_id: PID }, { routes: vLink, script: { ...vPay, ...vActivate, 'rpc:hangtag_billing_call_claim': { data: null, error: { code: '57014' } } } });
  check('the app\'s payment check, within the account\'s limit: counted as "verify" for the owner, then the provider asked and the payment activated',
    vUnder.status === 200 && vUnder.body.status === 'paid' && vClaim && vClaim.a.p_owner === 'u1' && vClaim.a.p_kind === 'verify' && vUnder.api.includes('api:GET /payment_links/plink_X'), { body: vUnder.body, vClaim, api: vUnder.api });
  check('…over the limit, or when the count can\'t be read: the database\'s own answer ("pending", with when to ask again), the provider not asked, nothing activated',
    vOver.status === 200 && vOver.body.status === 'pending' && vOver.body.retry_after === 42 && vOver.api.length === 0 && !vOver.calls.some((c) => /activate/.test(c.n))
    && vBroken.status === 200 && vBroken.body.status === 'pending' && !('retry_after' in vBroken.body) && vBroken.api.length === 0 && !vBroken.calls.some((c) => /activate/.test(c.n)),
    { over: [vOver.status, vOver.body, vOver.api], broken: [vBroken.status, vBroken.body, vBroken.api] });
  const LIVE_ENV = { ...ENV, SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_live_1' }; delete LIVE_ENV.SUBSCRIPTION_TEST_MODE;
  const vOld = await run({ action: 'verify', payment_id: PID }, { env: LIVE_ENV, premigration: true, routes: vLink, script: { ...vPay, ...vActivate } });
  check('…before the post-repair migration (no count in the database): no limit, as before — the provider asked, the payment activated',
    vOld.status === 200 && vOld.body.status === 'paid' && vOld.api.includes('api:GET /payment_links/plink_X'), { status: vOld.status, body: vOld.body, api: vOld.api });
  const sOver = await run({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }, { routes, script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, ...over } });
  const sBroken = await run({ action: 'autopay_start', consent: true, consent_version: 'terms-1' }, { routes,
    script: { 'rpc:hangtag_autopay_quote': { data: terms, error: null }, 'rpc:hangtag_billing_call_claim': { data: null, error: { code: '57014' } } } });
  check('starting AutoPay over the account\'s limit → 429 "too many tries" with when to try again; its count unreadable → 503; either way the provider not asked and no consent recorded',
    sOver.status === 429 && sOver.body.error === 'too_many' && sOver.body.retry_after === 42 && sOver.api.length === 0 && !sOver.calls.some((c) => c.n === 'hangtag_autopay_begin')
    && sOver.calls.some((c) => c.n === 'hangtag_billing_call_claim' && c.a.p_kind === 'autopay_start')
    && sBroken.status === 503 && sBroken.api.length === 0 && !sBroken.calls.some((c) => c.n === 'hangtag_autopay_begin'), { over: [sOver.status, sOver.body, sOver.api], broken: [sBroken.status, sBroken.body] });
  // the webhook self-check: console staff who manage settings only; a ₹1 link and a far-off subscription, made, noted and cancelled
  const notStaff = await run({ action: 'billing_selfcheck' }, { script: { 'rpc:hangtag_billing_selfcheck_allowed': { data: null, error: { code: '42501', message: 'denied' } } } });
  const probes = [];
  const selfcheck = await run({ action: 'billing_selfcheck' }, {
    routes: { 'POST /payment_links': { id: 'plink_Prb1234567' }, 'POST /payment_links/plink_X/cancel': {}, 'POST /subscriptions': { id: 'sub_Prb1234567', status: 'created' },
      'POST /subscriptions/sub_X/cancel': { id: 'sub_Prb1234567', status: 'cancelled' } },
    script: { 'rpc:hangtag_billing_selfcheck_allowed': { data: true, error: null }, 'rpc:hangtag_billing_probe_record': (a) => { probes.push(a); return { data: { ok: true }, error: null }; } } });
  check('billing self-check: refused (403) to anyone the database refuses; for staff, a probe link and subscription made, noted as probes in the billing mode, cancelled — every step ok, no ids sent back',
    notStaff.status === 403 && notStaff.api.length === 0 && selfcheck.status === 200 && selfcheck.body.ok === true && Object.keys(selfcheck.body.steps).length === 4
    && JSON.stringify(probes.map((p) => p.p_kind + ':' + p.p_entity + ':' + p.p_mode)) === JSON.stringify(['payment_link:plink_Prb1234567:test', 'subscription:sub_Prb1234567:test'])
    && !JSON.stringify(selfcheck.body).includes('plink_Prb') && !JSON.stringify(selfcheck.body).includes('sub_Prb'), { notStaff: notStaff.status, body: selfcheck.body, probes, api: selfcheck.api });
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
