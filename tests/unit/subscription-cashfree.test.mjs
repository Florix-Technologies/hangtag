// Cashfree for Hangtag plans (supabase/functions/subscription/providers/cashfree.js and both handlers), against a fake
// Cashfree that answers as its documentation (API 2026-01-01) says, and a scripted database. No network, no keys.
// The provider: environments and credentials (sandbox only on a test project), the payment link it asks for (amount in
// rupees, the payment's id as idempotency key and note, Hangtag's own mark, the return and notify addresses), how a link
// reads (only a PAID order with a SUCCESS payment is money), the webhook signature (Base64 HMAC-SHA256 of timestamp + raw
// body), and what a notification is about (a link, a refund, or nothing of Hangtag's).
// The payment lifecycle, scenario by scenario (the same list as AUDIT.md's Cashfree matrix): success, a rejected
// attempt, a forged client claim, a bad signature, a duplicate, retries, a late notification, out of order, an amount or
// currency that isn't due, a link naming another payment, a refund, another product's order, test keys on a live project.
// Run: node tests/unit/subscription-cashfree.test.mjs
import crypto from 'node:crypto';
import { handleWebhook } from '../../supabase/functions/subscription-webhook/handler.js';
import { handleSubscription } from '../../supabase/functions/subscription/handler.js';
import { cashfreeEnv, providerFor, providerNamed, webhookProviderFor } from '../../supabase/functions/subscription/providers/index.js';
import { API_VERSION, linkIdFor, linkView, readCashfreeWebhook, verifySignature } from '../../supabase/functions/subscription/providers/cashfree.js';
import { payerPhone } from '../../supabase/functions/subscription/core.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const PID = '0b6f3a2e-8c1d-4f6a-9b2e-1c3d4e5f6a7b', LINK = linkIdFor(PID), SECRET = 'cfsk_ma_test_secret_x';
const ENV = { SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: 'TEST10app', SUBSCRIPTION_CASHFREE_SECRET_KEY: SECRET, SUBSCRIPTION_TEST_MODE: 'true',
  APP_URL: 'https://app.hangtag.in', SUPABASE_URL: 'https://proj.supabase.co' };

/* A fake Cashfree: links, the orders on them, the payments on those orders; every request logged with its headers */
function fakeCashfree() {
  const links = new Map(), orders = new Map(), log = [];
  let fail = null;
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname.replace(/^\/pg/, ''), method = init.method || 'GET';
    log.push({ method, path: p + u.search, host: u.host, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (fail) return res(fail, { code: 'server_error' });
    let m;
    if (method === 'POST' && p === '/links') {
      const b = JSON.parse(init.body);
      links.set(b.link_id, { link_id: b.link_id, link_status: 'ACTIVE', link_amount: b.link_amount, link_currency: b.link_currency, link_expiry_time: b.link_expiry_time,
        link_notes: b.link_notes, link_url: 'https://payments-test.cashfree.com/links/x' + b.link_id.slice(3, 9) });
      return res(200, links.get(b.link_id));
    }
    if ((m = /^\/links\/([^/]+)$/.exec(p))) return links.has(m[1]) ? res(200, links.get(m[1])) : res(404, { code: 'link_not_found' });
    if ((m = /^\/links\/([^/]+)\/orders$/.exec(p))) return res(200, [...orders.values()].filter((o) => o.link_id === m[1] && (u.searchParams.get('status') !== 'PAID' || o.order_status === 'PAID')));
    if ((m = /^\/orders\/([^/]+)\/payments$/.exec(p))) return res(200, (orders.get(m[1]) || {}).payments || []);
    if ((m = /^\/orders\/([^/]+)$/.exec(p))) return orders.has(m[1]) ? res(200, { order_id: m[1], order_tags: { link_id: orders.get(m[1]).link_id } }) : res(404, {});
    return res(404, {});
  };
  return {
    fetch, log, links, orders,
    failNext: (status) => { fail = status; },
    ok: () => { fail = null; },
    // Cashfree's side: an attempt that failed (the link stays open), money taken, the link expired or cancelled
    attemptFailed: (linkId) => orders.set('CF_' + linkId + '_f', { order_id: 'CF_' + linkId + '_f', link_id: linkId, order_status: 'ACTIVE', order_amount: links.get(linkId).link_amount, order_currency: 'INR',
      payments: [{ cf_payment_id: '900', payment_status: 'FAILED' }] }),
    paid: (linkId, { amount, currency = 'INR', cf = '5114910' } = {}) => {
      const l = links.get(linkId), oid = 'CF_' + linkId + '_p';
      l.link_status = 'PAID';
      orders.set(oid, { order_id: oid, link_id: linkId, order_status: 'PAID', order_amount: amount == null ? l.link_amount : amount, order_currency: currency,
        payments: [{ cf_payment_id: cf, payment_status: 'SUCCESS', payment_amount: amount == null ? l.link_amount : amount }] });
      return oid;
    },
    setStatus: (linkId, st) => { links.get(linkId).link_status = st; },
  };
}
const sign = (ts, raw, secret = SECRET) => crypto.createHmac('sha256', secret).update(ts + raw).digest('base64');
const ALL = [];   // every line the handlers log, across all scenarios
const spy = () => { const lines = []; return { lines, error: (...a) => { const l = a.map(String).join(' '); lines.push(l); ALL.push(l); }, warn: () => {}, info: () => {} }; };
/* A database after the post-repair migration, in test billing mode (sandbox keys are taken only there): the ledger answers
   in that mode, and the mode-checked activation calls the activation, as the real one does */
const MIGRATED = {
  'rpc:hangtag_billing_event_seen': (a) => ({ data: { duplicate: false, mode_ok: a.p_mode === 'test', billing_mode: 'test' }, error: null }),
  'rpc:hangtag_billing_mode': { data: 'test', error: null },
};
function fakeDb(script = {}, log = []) {
  const answer = (key, args) => { const a = key in script ? script[key] : MIGRATED[key]; return typeof a === 'function' ? a(args) : (a || { data: null, error: null }); };
  return {
    log, calls: [],
    auth: { getUser: async () => ({ data: { user: 'user' in script ? script.user : { id: 'u1', email: 'owner@shop.in' } } }) },
    rpc: async function (name, args) {
      log.push('rpc:' + name); this.calls.push({ name, args });
      if (name === 'hangtag_subscription_activate_checked' && !('rpc:hangtag_subscription_activate_checked' in script)) {
        const { p_mode, ...inner } = args;
        log.push('rpc:hangtag_subscription_activate'); this.calls.push({ name: 'hangtag_subscription_activate', args: inner });
        return answer('rpc:hangtag_subscription_activate', inner);
      }
      return answer('rpc:' + name, args);
    },
    from: (t) => { const filters = []; const q = { select: () => q, eq: (k, v) => { filters.push([k, v]); return q; }, limit: () => q,
      maybeSingle: async () => { log.push('from:' + t); return answer('from:' + t, filters); } }; return q; },
  };
}
const ROW = { id: PID, owner_id: 'u1', amount: 999, currency: 'INR', status: 'created', provider: 'cashfree', provider_order_id: LINK };
const event = (type, data) => JSON.stringify({ type, event_time: '2026-10-18T12:00:00+05:30', data });
const successEvent = (linkId = LINK, extra = {}) => event('PAYMENT_SUCCESS_WEBHOOK', { order: { order_id: 'CF_' + linkId + '_p', order_amount: 999, order_currency: 'INR', order_tags: { link_id: linkId } },
  payment: { cf_payment_id: '5114910', payment_status: 'SUCCESS', payment_amount: 999.0 }, ...extra });
async function deliver(cf, raw, { db = fakeDb(), env = ENV, headers = {}, log = spy() } = {}) {
  const ts = '1792310000000', h = { 'x-webhook-timestamp': ts, 'x-webhook-signature': sign(ts, raw), ...headers };
  let made = 0;
  const r = await handleWebhook({ method: 'POST', raw, headers: h }, { provider: webhookProviderFor(env, h, cf.fetch, () => 1_800_000_000_000), admin: () => { made++; return db; }, log });
  return { ...r, made, db, log };
}

console.log('=== the provider: environments and credentials ===');
check('sandbox only on a test project; production outside one; the setting and the key\'s own prefix must agree',
  cashfreeEnv({ SUBSCRIPTION_TEST_MODE: 'true' }) === 'sandbox' && cashfreeEnv({}) === 'production'
  && cashfreeEnv({ SUBSCRIPTION_CASHFREE_ENV: 'production', SUBSCRIPTION_TEST_MODE: 'true' }) === null && cashfreeEnv({ SUBSCRIPTION_CASHFREE_ENV: 'sandbox' }) === null
  && cashfreeEnv({ SUBSCRIPTION_CASHFREE_SECRET_KEY: 'cfsk_ma_test_x' }) === null && cashfreeEnv({ SUBSCRIPTION_TEST_MODE: 'true', SUBSCRIPTION_CASHFREE_SECRET_KEY: 'cfsk_ma_prod_x' }) === null
  && cashfreeEnv({ SUBSCRIPTION_CASHFREE_ENV: 'staging' }) === null);
const live = { ...ENV, SUBSCRIPTION_TEST_MODE: '' };
check('…so sandbox keys on the live project are "not configured", for payments and for the webhook alike',
  providerFor(live) === null && webhookProviderFor(live, { 'x-webhook-signature': 'x' }) === null && providerFor(ENV).name === 'cashfree' && providerFor(ENV).mode === 'test');
const cf = fakeCashfree();
const P = providerFor(ENV, cf.fetch, () => 1_800_000_000_000);
const page = await P.createPayment({ paymentId: PID, amount: 999, currency: 'INR', description: 'Hangtag 1 month', email: 'owner@shop.in', phone: '9876543210',
  callbackUrl: 'https://app.hangtag.in/#plans?payment=' + PID, notifyUrl: 'https://proj.supabase.co/functions/v1/subscription-webhook' });
const post = cf.log.find((x) => x.method === 'POST'), b = post.body;
check('a payment link on the sandbox: the API version, Hangtag\'s keys in headers (never the URL), the payment\'s id as idempotency key',
  post.host === 'sandbox.cashfree.com' && post.headers['x-api-version'] === API_VERSION && API_VERSION === '2026-01-01' && post.headers['x-client-id'] === 'TEST10app'
  && post.headers['x-client-secret'] === SECRET && post.headers['x-idempotency-key'] === PID && !post.path.includes(SECRET), post.headers);
check('…for the amount in rupees, no partial payment, an hour to pay, Cashfree sending nothing itself, the return and notify addresses',
  b.link_id === LINK && b.link_amount === 999 && b.link_currency === 'INR' && b.link_partial_payments === false && b.link_expiry_time === new Date(1_800_000_000_000 + 330 * 60e3 + 3600e3).toISOString().slice(0, 19) + '+05:30'
  && b.link_notify.send_sms === false && b.link_notify.send_email === false && b.link_meta.return_url.endsWith(PID) && b.link_meta.notify_url.endsWith('/functions/v1/subscription-webhook'), b);
check('…noted as this Hangtag payment and as Hangtag\'s (apart from anything else on the same Cashfree account); the payer\'s phone',
  b.link_notes.hangtag_payment === PID && b.link_notes.hangtag_app === 'hangtag-plan' && b.customer_details.customer_phone === '9876543210' && page.orderId === LINK && /^https:/.test(page.payUrl), b);
let phoneErr = null; try { await P.createPayment({ paymentId: PID, amount: 1 }); } catch (e) { phoneErr = e; }
check('no usable phone: refused before Cashfree is asked (the shop\'s number, +91/0/spaces allowed)', phoneErr && phoneErr.message === 'phone_required' && payerPhone('+91 98765-43210') === '9876543210' && payerPhone('12345') === '');
check('production keys talk to production', providerNamed('cashfree', { ...live, SUBSCRIPTION_CASHFREE_SECRET_KEY: 'cfsk_ma_prod_y' }, cf.fetch).mode === 'live');

console.log('=== the provider: how a link reads ===');
check('open (nothing paid) → pending', (await P.getPayment(LINK)).state === 'pending');
cf.attemptFailed(LINK);
check('a failed attempt leaves the link open → still pending, nothing failed', (await P.getPayment(LINK)).state === 'pending');
cf.paid(LINK);
const v = await P.getPayment(LINK);
check('a PAID order with a SUCCESS payment → paid, in paise, with Cashfree\'s payment id and its currency', v.state === 'paid' && v.paid === 99900 && v.paymentId === '5114910' && v.currency === 'INR', v);
check('a PAID order with no SUCCESS payment readable yet → pending (never paid without the payment)', linkView({ link_id: LINK, link_status: 'PAID' }, { paid: 99900, paymentId: null }).state === 'pending');
check('expired, cancelled, or open past its expiry', linkView({ link_id: LINK, link_status: 'EXPIRED' }).state === 'expired' && linkView({ link_id: LINK, link_status: 'CANCELLED' }).state === 'cancelled'
  && linkView({ link_id: LINK, link_status: 'ACTIVE', link_expiry_time: '2020-01-01T00:00:00+05:30' }).state === 'expired' && linkView({ link_id: 'other' }).state === 'failed');

console.log('=== the provider: notifications ===');
const raw = successEvent(), ts = '1792310000000';
check('the signature: Base64 HMAC-SHA256 of the timestamp followed by the raw body, with the secret key', await verifySignature(raw, ts, sign(ts, raw), SECRET)
  && !(await verifySignature(raw, ts, sign(ts, raw, 'other'), SECRET)) && !(await verifySignature(raw.replace('999', '1'), ts, sign(ts, raw), SECRET))
  && !(await verifySignature(raw, '', sign('', raw), SECRET)) && !(await verifySignature(raw, ts, '', SECRET)));
const pay = readCashfreeWebhook(JSON.parse(raw), raw), linkEv = readCashfreeWebhook({ type: 'PAYMENT_LINK_EVENT', data: { link_id: LINK, link_status: 'PAID', link_notes: { hangtag_payment: PID } } }, '');
const form = readCashfreeWebhook({}, `link_id=${LINK}&link_status=PAID`);
const refund = readCashfreeWebhook({ type: 'REFUND_STATUS_WEBHOOK', data: { refund: { order_id: 'CF_x', cf_payment_id: '5114910', cf_refund_id: 'rf_1', refund_amount: 999, refund_currency: 'INR', refund_status: 'SUCCESS' } } }, '');
check('a payment of a Hangtag link (its tags), a payment-link event (JSON or form data) → that link, decided only from Cashfree\'s API (no state taken from the message)',
  pay.kind === 'payment' && pay.orderId === LINK && pay.view === null && linkEv.orderId === LINK && linkEv.paymentRef === PID && form.orderId === LINK, { pay, linkEv, form });
check('a refund → its order and payment, the amount and status', refund.kind === 'refund' && refund.cfOrderId === 'CF_x' && refund.refundId === 'rf_1' && refund.amount === 999 && refund.status === 'SUCCESS', refund);
check('an order of another product (no Hangtag link) → nothing', readCashfreeWebhook(JSON.parse(event('PAYMENT_SUCCESS_WEBHOOK', { order: { order_id: 'florix-shop-77', order_tags: { product: 'other' } } })), '') === null);
check('its own id: Cashfree\'s x-idempotency-key, else a digest of the signed body', (await P.eventIdOf(raw, { 'x-idempotency-key': 'idem-1' })) === 'idem-1'
  && /^sha256:[0-9a-f]{64}$/.test(await P.eventIdOf(raw, {})));

console.log('=== the lifecycle, through the webhook ===');
{
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR' }); c.paid(LINK);
  let act; const db = fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_activate': (a) => { act = a; return { data: { ok: true }, error: null }; } });
  const r = await deliver(c, successEvent(), { db });
  check('1 success: signed, then the link read from Cashfree, activated once with Cashfree\'s payment id and the amount → 200', r.status === 200 && r.body.status === 'paid'
    && act.p_payment === PID && act.p_provider_payment === '5114910' && act.p_amount === 999 && c.log.some((x) => x.path.startsWith('/links/' + LINK + '/orders')), { r, act });
  check('…and the notification noted once settled', db.log.includes('rpc:hangtag_billing_event_record') && db.log.indexOf('rpc:hangtag_billing_event_record') > db.log.indexOf('rpc:hangtag_subscription_activate'));
}
{
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR' }); c.attemptFailed(LINK);
  const db = fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } });
  const r = await deliver(c, event('PAYMENT_FAILED_WEBHOOK', { order: { order_id: 'CF_' + LINK + '_f', order_tags: { link_id: LINK } }, payment: { payment_status: 'FAILED' } }), { db });
  check('2 a rejected attempt: the link stays open → pending; nothing activated, nothing marked failed (the owner may try again)', r.status === 200 && r.body.status === 'pending'
    && !db.log.includes('rpc:hangtag_subscription_activate') && !db.log.includes('rpc:hangtag_subscription_fail'), r);
}
{
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR' });
  const db = fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } });
  const forged = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: 'CF_x', order_tags: { link_id: LINK } }, payment: { payment_status: 'SUCCESS', payment_amount: 999 } } });
  const r = await deliver(c, forged, { db });
  check('3 a message claiming success while Cashfree has no paid order: nothing activated (state is only ever read from the API); not settled — 503, sent again, not noted',
    r.status === 503 && !db.log.includes('rpc:hangtag_subscription_activate') && !db.log.includes('rpc:hangtag_billing_event_record'), r);
  // Cashfree lists the PAID order but its SUCCESS payment isn't readable yet (its API lags): sent again, then activated once readable
  const c3 = fakeCashfree(); c3.links.set(LINK, { link_id: LINK, link_status: 'PAID', link_amount: 999, link_currency: 'INR' });
  const oid3 = c3.paid(LINK); const pays = c3.orders.get(oid3).payments; c3.orders.get(oid3).payments = [];
  const lag = await deliver(c3, successEvent(), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  c3.orders.get(oid3).payments = pays;
  const later = await deliver(c3, successEvent(), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  check('…money listed but its payment not readable yet: 503 (sent again), nothing activated or noted; sent again once readable: activated',
    lag.status === 503 && !lag.db.log.includes('rpc:hangtag_subscription_activate') && !lag.db.log.includes('rpc:hangtag_billing_event_record')
    && later.status === 200 && later.db.log.includes('rpc:hangtag_subscription_activate'), { lag: lag.body, later: later.body });
  const r2 = await handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => ({ action: 'verify', payment_id: PID, status: 'paid', paid: true }) },
    { env: ENV, provider: providerFor(ENV, c.fetch), named: (n) => providerNamed(n, ENV, c.fetch), userDb: () => fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }), admin: () => db, log: spy() });
  check('…the app saying "paid" itself changes nothing either: verify asks Cashfree → pending', r2.status === 200 && r2.body.status === 'pending', r2);
}
{
  const c = fakeCashfree(); const raw = successEvent();
  let made = 0;
  const r = await handleWebhook({ method: 'POST', raw, headers: { 'x-webhook-timestamp': ts, 'x-webhook-signature': sign(ts, raw, 'cfsk_ma_test_wrong') } },
    { provider: webhookProviderFor(ENV, { 'x-webhook-signature': 'x' }, c.fetch), admin: () => { made++; return fakeDb(); }, log: spy() });
  check('4 an invalid signature → 400; the database never reached, Cashfree never asked', r.status === 400 && made === 0 && c.log.length === 0, r);
  const unsigned = await handleWebhook({ method: 'POST', raw, headers: {} }, { provider: webhookProviderFor(ENV, {}, c.fetch), admin: () => { made++; return fakeDb(); }, log: spy() });
  check('…no signature at all (no provider\'s header) → 400 for good, not 503 "send again"; nothing reached', unsigned.status === 400 && made === 0 && c.log.length === 0, unsigned);
}
{
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR' }); c.paid(LINK);
  let asked = null;
  const db = fakeDb({ 'rpc:hangtag_billing_event_seen': (a) => { asked = a; return { data: { duplicate: a.p_event_id === 'idem-7', mode_ok: true, billing_mode: 'test' }, error: null }; },
    'from:hangtag_subscription_payments': { data: ROW, error: null } });
  const r = await deliver(c, successEvent(), { db, headers: { 'x-idempotency-key': 'idem-7' } });
  check('5 a duplicate (the same notification, already settled — the ledger asked by its key, in this mode): 200, nothing done again',
    r.status === 200 && r.body.duplicate === true && asked && asked.p_event_id === 'idem-7' && asked.p_mode === 'test'
    && !db.log.includes('rpc:hangtag_subscription_activate') && c.log.length === 0, r);
}
{
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR' }); c.paid(LINK); c.failNext(500);
  const r = await deliver(c, successEvent(), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } }) });
  c.ok();
  const r2 = await deliver(c, successEvent(), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: null, error: { code: '57014' } } }) });
  const r3 = await deliver(c, successEvent(), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null }, 'rpc:hangtag_subscription_activate': { data: null, error: { code: '08006' } } }) });
  check('6 retries: Cashfree down → 503, the database unreadable → 503, activation lost on the way → 500 (Cashfree sends it again); nothing noted as settled',
    r.status === 503 && r2.status === 503 && r3.status === 500 && !r.db.log.includes('rpc:hangtag_billing_event_record') && !r3.db.log.includes('rpc:hangtag_billing_event_record'), [r.status, r2.status, r3.status]);
}
{
  const c = fakeCashfree();
  const db = fakeDb({ 'from:hangtag_subscription_payments': { data: { ...ROW, status: 'paid' }, error: null } });
  const r = await deliver(c, successEvent(), { db });
  const late = await deliver(c, event('PAYMENT_FAILED_WEBHOOK', { order: { order_id: 'CF_' + LINK + '_f', order_tags: { link_id: LINK } } }), { db: fakeDb({ 'from:hangtag_subscription_payments': { data: { ...ROW, status: 'paid' }, error: null } }) });
  check('7 a late notification (the app\'s own check activated it first) and 8 one out of order (a failure after the success): nothing changes, Cashfree not even asked',
    r.status === 200 && r.body.status === 'paid' && late.status === 200 && late.body.status === 'paid' && c.log.length === 0 && !db.log.includes('rpc:hangtag_subscription_activate'), [r, late]);
}
for (const [n, what, opts, kind] of [['9', 'an amount that isn\'t due', { amount: 499 }, 'amount_mismatch'], ['10', 'another currency', { currency: 'USD' }, 'currency_mismatch']]) {
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR' }); c.paid(LINK, opts);
  const db = fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } });
  const r = await deliver(c, successEvent(), { db });
  const x = db.calls.find((k) => k.name === 'hangtag_billing_exception_open');
  check(`${n} ${what}: never activated; kept for review (${kind}), with the payment and the shop`, r.status === 200 && !db.log.includes('rpc:hangtag_subscription_activate')
    && x && x.args.p_kind === kind && x.args.p_payment === PID && x.args.p_owner === 'u1', { r, x });
}
{
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'PAID', link_amount: 999, link_currency: 'INR' }); c.paid(LINK);
  const db = fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } });
  const other = '11111111-2222-4333-8444-555555555555';
  const r = await deliver(c, event('PAYMENT_LINK_EVENT', { link_id: LINK, link_status: 'PAID', link_notes: { hangtag_payment: other } }), { db });
  const x = db.calls.find((k) => k.name === 'hangtag_billing_exception_open');
  check('11 a link whose note names another payment (a wrong shop or a tampered link): never activated, kept for review', r.status === 200 && r.body.status === 'wrong_payment'
    && !db.log.includes('rpc:hangtag_subscription_activate') && x && x.args.p_kind === 'wrong_shop' && x.args.p_detail.named_payment === other, { r, x });
}
{
  const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'PAID', link_amount: 999, link_currency: 'INR' }); const oid = c.paid(LINK);
  const db = fakeDb({ 'from:hangtag_subscription_payments': { data: { ...ROW, status: 'paid' }, error: null } });
  const r = await deliver(c, event('REFUND_STATUS_WEBHOOK', { refund: { order_id: oid, cf_payment_id: '5114910', cf_refund_id: 'rf_1', refund_amount: 999, refund_currency: 'INR', refund_status: 'SUCCESS' } }), { db });
  const x = db.calls.find((k) => k.name === 'hangtag_billing_exception_open');
  check('12 a refund: traced through Cashfree to its Hangtag payment, kept for review; no time taken away, nothing activated', r.status === 200 && r.body.refund === 'noted'
    && x && x.args.p_kind === 'refund' && x.args.p_payment === PID && x.args.p_amount === 999 && !db.log.includes('rpc:hangtag_subscription_activate') && !db.log.includes('rpc:hangtag_subscription_fail'), { r, x });
}
{
  const c = fakeCashfree();
  const r = await deliver(c, event('PAYMENT_SUCCESS_WEBHOOK', { order: { order_id: 'florix-shop-77', order_tags: { product: 'other' } }, payment: { payment_status: 'SUCCESS' } }));
  check('13 an order of another Florix product on the same Cashfree account: 200, ignored; the database not even opened', r.status === 200 && r.body.ignored === true && r.made === 0, r);
}
{
  // a link of Hangtag's form that no Hangtag payment recorded (its recording failed, or it was made by hand on the account)
  const U = 'ht_' + 'ab'.repeat(16), NAMED = '99999999-8888-4777-8666-555555555555';
  const unknown = (notes) => { const c = fakeCashfree(); c.links.set(U, { link_id: U, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR', link_notes: notes }); return c; };
  const opened = (r) => r.db.calls.find((k) => k.name === 'hangtag_billing_exception_open');
  const activated = (r) => r.db.log.some((l) => /rpc:hangtag_subscription_(activate|fail)/.test(l));
  let c = unknown({ hangtag_payment: NAMED, hangtag_app: 'hangtag-plan' }); c.paid(U);
  const a = await deliver(c, successEvent(U)), xa = opened(a);
  c = unknown({ hangtag_payment: NAMED, hangtag_app: 'hangtag-plan' }); c.paid(U);
  const b = await deliver(c, event('PAYMENT_LINK_EVENT', { link_id: U, link_status: 'PAID', link_notes: { hangtag_payment: NAMED } }));
  check('13b money on a Hangtag link no payment recorded (the payment event, or the link event): kept for review (unknown_order) with what Cashfree says was paid; nothing activated',
    a.status === 200 && a.body.status === 'unmatched' && xa && xa.args.p_kind === 'unknown_order' && xa.args.p_ref === U && xa.args.p_amount === 999 && xa.args.p_owner === null
    && xa.args.p_detail.named_payment === NAMED && xa.args.p_detail.provider_payment === '5114910' && !activated(a)
    && b.status === 200 && b.body.status === 'unmatched' && opened(b) && !activated(b), { a: a.body, xa, b: b.body });
  c = unknown({ hangtag_payment: NAMED, hangtag_app: 'hangtag-plan' });
  const d = await deliver(c, event('PAYMENT_LINK_EVENT', { link_id: U, link_status: 'ACTIVE', link_notes: { hangtag_payment: NAMED } }));
  const d2 = await deliver(c, successEvent(U));
  check('…a payment reported on it that Cashfree doesn\'t show yet: 503, sent again; nothing opened or noted', d2.status === 503 && !opened(d2)
    && !d2.db.log.includes('rpc:hangtag_billing_event_record'), d2.body);
  c = unknown({ order_ref: 'x' }); c.paid(U);
  const e = await deliver(c, successEvent(U));
  c = unknown({ hangtag_payment: NAMED, hangtag_app: 'hangtag-plan' }); c.paid(U); c.failNext(500);
  const f = await deliver(c, successEvent(U));
  const g = await deliver(fakeCashfree(), successEvent('ht_' + '01'.repeat(16)));
  check('…unpaid: ignored; a link Cashfree says isn\'t Hangtag\'s (no note of ours): ignored; one Cashfree has never made (404): ignored for good; Cashfree down: 503, sent again — none of them opens anything',
    d.status === 200 && d.body.ignored === true && !opened(d) && e.status === 200 && e.body.ignored === true && !opened(e) && !activated(e)
    && g.status === 200 && g.body.ignored === true && !opened(g)
    && f.status === 503 && !opened(f) && !f.db.log.includes('rpc:hangtag_billing_event_record'), { d: d.body, e: e.body, f: f.body, g: g.body });
}
{
  const c = fakeCashfree();
  const r = await deliver(c, successEvent(), { env: live });
  check('14 sandbox keys on the live project: the webhook isn\'t configured (503), nothing read', r.status === 503 && r.made === 0, r);
}

console.log('=== the lifecycle, through the subscription function ===');
{
  const c = fakeCashfree(), at = () => 1_800_000_000_000;
  const run = (script) => { const db = fakeDb(script); return handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => ({ action: 'checkout', plan: 'm1' }) },
    { env: ENV, provider: providerFor(ENV, c.fetch, at), named: (n) => providerNamed(n, ENV, c.fetch, at), userDb: () => db, admin: () => db, now: at, log: spy() }).then((r) => ({ ...r, db })); };
  const base = { 'rpc:hangtag_subscription_quote': { data: { amount: 999 }, error: null }, 'rpc:hangtag_subscription_checkout': { data: { payment_id: PID, amount: 999, currency: 'INR', plan_label: '1 month' }, error: null },
    'rpc:hangtag_subscription_attach': { data: { ok: true }, error: null } };
  const noPhone = await run({ ...base, 'from:hangtag_profiles': { data: { phone: '' }, error: null } });
  check('15 checkout with Cashfree and no usable shop phone: asked for it (400), no payment created, Cashfree not asked', noPhone.status === 400 && noPhone.body.error === 'phone_required'
    && !noPhone.db.log.includes('rpc:hangtag_subscription_checkout') && c.log.length === 0, noPhone);
  const ok = await run({ ...base, 'from:hangtag_profiles': { data: { phone: '+91 98765 43210' }, error: null } });
  const attach = ok.db.calls.find((k) => k.name === 'hangtag_subscription_attach');
  check('…with it: the price from the database, a Cashfree link for that payment (return and notify addresses), recorded against it', ok.status === 200 && ok.body.provider === 'cashfree'
    && /^https:/.test(ok.body.pay_url) && attach.args.p_order === LINK && attach.args.p_provider === 'cashfree' && c.log[0].body.link_meta.notify_url === 'https://proj.supabase.co/functions/v1/subscription-webhook', { ok, attach });
}

console.log('=== what the logs hold ===');
const leaky = (l) => l.includes(SECRET) || /[6-9][0-9]{9}/.test(l) || /@/.test(l);
check(`the handlers' log lines (${ALL.length}) carry ids and codes only: never the secret key, a phone number or an email`, ALL.length > 5 && !ALL.some(leaky), ALL.filter(leaky));
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
