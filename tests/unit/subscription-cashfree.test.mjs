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
import { autopayProviderFor, cashfreeEnv, providerFor, providerNamed, webhookProviderFor } from '../../supabase/functions/subscription/providers/index.js';
import { API_VERSION, EXPIRY_GRACE_MS, autopayIdFor, chargeIdFor, istTime, linkIdFor, linkView, mandateView, readCashfreeWebhook, verifySignature } from '../../supabase/functions/subscription/providers/cashfree.js';
import { appBackUrl, autopayReturnUrl, cancelOrConfirm, payerPhone } from '../../supabase/functions/subscription/core.js';
import { checkMandate, reconcile } from '../../supabase/functions/subscription/reconcile.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const PID = '0b6f3a2e-8c1d-4f6a-9b2e-1c3d4e5f6a7b', LINK = linkIdFor(PID), SECRET = 'cfsk_ma_test_secret_x';
const ENV = { SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: 'TEST10app', SUBSCRIPTION_CASHFREE_SECRET_KEY: SECRET, SUBSCRIPTION_TEST_MODE: 'true',
  APP_URL: 'https://app.hangtag.in', SUPABASE_URL: 'https://proj.supabase.co' };

/* A fake Cashfree: links, the orders on them, the payments on those orders; every request logged with its headers */
function fakeCashfree() {
  const links = new Map(), orders = new Map(), log = [], subs = new Map(), charges = new Map(), keys = new Map();
  let fail = null, refuseCancel = false;
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname.replace(/^\/pg/, ''), method = init.method || 'GET';
    log.push({ method, path: p + u.search, host: u.host, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (fail) return res(fail, { code: 'server_error' });
    // as Cashfree's sandbox answers (2026-10-27): an idempotency key it has seen on another request → 422 request_invalid
    const key = (init.headers || {})['x-idempotency-key'];
    if (key) { if (keys.has(key) && keys.get(key) !== method + ' ' + p) return res(422, { code: 'request_invalid' }); keys.set(key, method + ' ' + p); }
    let m;
    // Subscriptions (AutoPay): mandates, their payments (the AUTH and each CHARGE); a payment_id is taken once
    if (method === 'POST' && p === '/subscriptions') {
      const b = JSON.parse(init.body);
      subs.set(b.subscription_id, { subscription_id: b.subscription_id, cf_subscription_id: String(880 + subs.size), subscription_session_id: 'sub_session_' + b.subscription_id.slice(5, 21),
        subscription_status: 'INITIALIZED', plan_details: b.plan_details, customer_details: b.customer_details });
      charges.set(b.subscription_id, []);
      return res(200, subs.get(b.subscription_id));
    }
    if (method === 'POST' && p === '/subscriptions/pay') {
      const b = JSON.parse(init.body), list = charges.get(b.subscription_id);
      if (!list) return res(404, { code: 'subscription_not_found' });
      if (list.some((c) => c.payment_id === b.payment_id)) return res(400, { code: 'payment_id_already_exists' });
      const c = { payment_id: b.payment_id, cf_payment_id: String(7000 + list.length), payment_type: 'CHARGE', payment_amount: b.payment_amount, payment_status: 'INITIALIZED',
        payment_schedule_date: b.payment_schedule_date };
      list.push(c);
      return res(200, c);
    }
    if ((m = /^\/subscriptions\/([^/]+)\/payments\/([^/]+)\/manage$/.exec(p))) {
      const c = (charges.get(m[1]) || []).find((x) => x.payment_id === m[2]);
      if (!c) return res(404, {});
      c.payment_status = 'CANCELLED';
      return res(200, c);
    }
    if ((m = /^\/subscriptions\/([^/]+)\/payments$/.exec(p))) return subs.has(m[1]) ? res(200, charges.get(m[1])) : res(404, {});
    if ((m = /^\/subscriptions\/([^/]+)\/manage$/.exec(p))) {
      const s = subs.get(m[1]);
      if (!s) return res(404, {});
      if (refuseCancel) return res(400, { code: 'action_not_allowed' });   // refused for now: the mandate stays as it is
      if (/CANCELLED$/.test(s.subscription_status)) return res(400, { code: 'subscription_already_cancelled' });
      s.subscription_status = 'CANCELLED';
      return res(200, s);
    }
    if ((m = /^\/subscriptions\/([^/]+)$/.exec(p))) return subs.has(m[1]) ? res(200, subs.get(m[1])) : res(404, {});
    if (method === 'POST' && p === '/links') {
      const b = JSON.parse(init.body);
      links.set(b.link_id, { link_id: b.link_id, link_status: 'ACTIVE', link_amount: b.link_amount, link_currency: b.link_currency, link_expiry_time: b.link_expiry_time,
        link_notes: b.link_notes, link_url: 'https://payments-test.cashfree.com/links/x' + b.link_id.slice(3, 9) });
      return res(200, links.get(b.link_id));
    }
    if (method === 'POST' && (m = /^\/links\/([^/]+)\/cancel$/.exec(p))) {
      const l = links.get(m[1]);
      if (!l) return res(404, { code: 'link_not_found' });
      l.link_status = 'CANCELLED';
      return res(200, l);
    }
    if ((m = /^\/links\/([^/]+)$/.exec(p))) return links.has(m[1]) ? res(200, links.get(m[1])) : res(404, { code: 'link_not_found' });
    // as Cashfree's sandbox answers (2026-10-27): status must be ALL ("status : should be ALL. Value received: PAID")
    if ((m = /^\/links\/([^/]+)\/orders$/.exec(p))) return u.searchParams.get('status') !== 'ALL' ? res(400, { code: 'status_invalid' })
      : res(200, [...orders.values()].filter((o) => o.link_id === m[1]));
    if ((m = /^\/orders\/([^/]+)\/payments$/.exec(p))) return res(200, (orders.get(m[1]) || {}).payments || []);
    if ((m = /^\/orders\/([^/]+)$/.exec(p))) return orders.has(m[1]) ? res(200, { order_id: m[1], order_tags: { link_id: orders.get(m[1]).link_id } }) : res(404, {});
    return res(404, {});
  };
  return {
    fetch, log, links, orders, subs, charges,
    // the owner approves a mandate: ACTIVE, with its ₹1 authorisation taken (refunded by Cashfree)
    approve: (id) => { subs.get(id).subscription_status = 'ACTIVE'; charges.get(id).push({ payment_id: 'auth_' + id.slice(5, 13), cf_payment_id: '6999', payment_type: 'AUTH',
      payment_amount: 1, payment_status: 'SUCCESS' }); },
    mandate: (id, status) => { subs.set(id, { subscription_id: id, subscription_status: status }); charges.set(id, []); },
    failNext: (status) => { fail = status; },
    refuseCancels: (v) => { refuseCancel = v; },
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
  const r = await handleWebhook({ method: 'POST', raw, headers: h }, { provider: webhookProviderFor(env, h, cf.fetch, () => 1_800_000_000_000), admin: () => { made++; return db; }, log, now: () => 1_800_000_000_000 });
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
check('…for the amount in rupees, no partial payment, 20 minutes to pay (10 short of the 30 a capped offer holds a place), Cashfree sending nothing itself, the return and notify addresses',
  b.link_id === LINK && b.link_amount === 999 && b.link_currency === 'INR' && b.link_partial_payments === false && b.link_expiry_time === new Date(1_800_000_000_000 + 330 * 60e3 + 20 * 60e3).toISOString().slice(0, 19) + '+05:30'
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
const ENDS = '2026-10-26T12:00:00+05:30', T = Date.parse(ENDS);
check('just past its expiry (15 minutes\' grace) an unpaid link still reads as pending — a payment begun before the expiry may be landing; after that, expired',
  EXPIRY_GRACE_MS === 15 * 60e3 && linkView({ link_id: LINK, link_status: 'ACTIVE', link_expiry_time: ENDS }, null, T + 60e3).state === 'pending'
  && linkView({ link_id: LINK, link_status: 'EXPIRED', link_expiry_time: ENDS }, null, T + 14 * 60e3).state === 'pending'
  && linkView({ link_id: LINK, link_status: 'ACTIVE', link_expiry_time: ENDS }, null, T + EXPIRY_GRACE_MS + 1).state === 'expired'
  && linkView({ link_id: LINK, link_status: 'EXPIRED', link_expiry_time: ENDS }, null, T + EXPIRY_GRACE_MS + 1).state === 'expired'
  && linkView({ link_id: LINK, link_status: 'ACTIVE', link_expiry_time: ENDS }, null, T - 60e3).state === 'pending');

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

{
  // a payment begun before the link's expiry and finished just after it: Cashfree reports the success before it lists the
  // PAID order. Neither the notification nor the owner's app gives up on it as "expired" while the money is landing.
  const NOW = 1_800_000_000_000, mine = () => fakeDb({ 'from:hangtag_subscription_payments': { data: ROW, error: null } });
  const late = (minutesPast) => { const c = fakeCashfree(); c.links.set(LINK, { link_id: LINK, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR', link_expiry_time: istTime(NOW - minutesPast * 60e3) }); return c; };
  const c1 = late(1);
  const r1 = await deliver(c1, successEvent(), { db: mine() });
  check('16 success reported a minute after the link expired, its PAID order not listed yet: not settled (503, sent again) — never marked expired, never noted, nothing for review yet',
    r1.status === 503 && !r1.db.log.includes('rpc:hangtag_subscription_fail') && !r1.db.log.includes('rpc:hangtag_billing_event_record')
    && !r1.db.log.includes('rpc:hangtag_billing_exception_open'), { status: r1.status, log: r1.db.log });
  const r2 = await deliver(late(40), successEvent(), { db: mine() }), r2b = await deliver(late(41), successEvent(), { db: mine() });
  const kept = (r) => r.db.calls.find((k) => k.name === 'hangtag_billing_exception_open');
  check('…even long after the expiry (the link reads expired): a notification saying money was taken is sent again until Cashfree shows the money',
    r2.status === 503 && !r2.db.log.includes('rpc:hangtag_subscription_fail') && !r2.db.log.includes('rpc:hangtag_billing_event_record'), { status: r2.status, log: r2.db.log });
  check('…and the claim is kept for review (a payment nothing holds, with the payment and the shop), the same one each time it comes — never lost when Cashfree stops sending it',
    !!kept(r2) && kept(r2).args.p_kind === 'unmatched_payment' && kept(r2).args.p_payment === PID && kept(r2).args.p_owner === 'u1'
    && kept(r2).args.p_detail.link_state === 'expired' && !!kept(r2b) && kept(r2b).args.p_ref === kept(r2).args.p_ref, { r2: kept(r2), r2b: kept(r2b) });
  c1.paid(LINK);
  const r3 = await deliver(c1, successEvent(), { db: mine() });
  check('…once Cashfree lists it: activated once, and noted', r3.status === 200 && r3.db.log.filter((x) => x === 'rpc:hangtag_subscription_activate').length === 1
    && r3.db.log.includes('rpc:hangtag_billing_event_record'), r3.body);
  const verify = (c) => handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => ({ action: 'verify', payment_id: PID }) },
    { env: ENV, provider: providerFor(ENV, c.fetch, () => NOW), named: (n) => providerNamed(n, ENV, c.fetch, () => NOW), userDb: mine, admin: () => fakeDb(), log: spy() });
  const v1 = await verify(late(2));
  check('…the owner\'s app checking in those minutes hears "pending" (keep waiting), not "expired, pay again"', v1.status === 200 && v1.body.status === 'pending', v1);
  const v2 = await verify(late(20));
  check('…after the grace with nothing paid: expired (the payment marked so; the owner may pay again)', v2.status === 200 && v2.body.status === 'expired', v2);
}

console.log('=== the lifecycle, through the subscription function ===');
{
  const c = fakeCashfree(), at = () => 1_800_000_000_000;
  const run = (script, extra = {}) => { const db = fakeDb(script); return handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => ({ action: 'checkout', plan: 'm1', ...extra }) },
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
  // a shop whose plan ended is locked to Plans & Billing (Settings out of reach): the owner types the number beside Pay
  const lastPost = () => c.log.filter((x) => x.method === 'POST' && x.path === '/links').pop();
  const typed = await run({ ...base, 'from:hangtag_profiles': { data: { phone: '' }, error: null } }, { phone: '+91 98450-11111' });
  check('17 no usable saved number, one typed for this payment: the link is made with it (the shop\'s profile isn\'t changed)', typed.status === 200
    && lastPost().body.customer_details.customer_phone === '9845011111' && !typed.db.log.some((x) => /hangtag_profiles/.test(x) && x.startsWith('rpc:')), typed);
  const saved = await run({ ...base, 'from:hangtag_profiles': { data: { phone: '98765 43210' }, error: null } }, { phone: '9845011111' });
  check('…a saved number that works is used before a typed one', saved.status === 200 && lastPost().body.customer_details.customer_phone === '9876543210', saved);
  const before = c.log.length;
  const bad = await run({ ...base, 'from:hangtag_profiles': { data: { phone: '' }, error: null } }, { phone: '12345' });
  check('…a typed number that isn\'t a mobile: refused (400 bad_phone) before anything is made — no payment, Cashfree not asked', bad.status === 400 && bad.body.error === 'bad_phone'
    && !bad.db.log.includes('rpc:hangtag_subscription_checkout') && c.log.length === before, bad);
}

console.log('=== AutoPay with Cashfree: the 30-day trial on an on-demand mandate, charged only when Hangtag asks ===');
{
  const AENV = { ...ENV, SUBSCRIPTION_AUTOPAY_PROVIDER: 'cashfree' }, NOW = 1_800_000_000_000;
  const MANDATE = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', SUB = autopayIdFor(MANDATE), FIRST = new Date(NOW + 30 * 86400e3).toISOString();
  const terms = { price: 599, today: 0, currency: 'INR', plan: { code: 'm1', label: 'Monthly', months: 1 }, first_charge_at: FIRST, mandate_id: MANDATE };
  check('A1 AutoPay is Cashfree\'s when SUBSCRIPTION_AUTOPAY_PROVIDER=cashfree (and its keys are allowed); otherwise Razorpay\'s rules (no plan → none)',
    (autopayProviderFor(AENV) || {}).name === 'cashfree' && autopayProviderFor(ENV) === null && autopayProviderFor({ ...AENV, SUBSCRIPTION_AUTOPAY_PROVIDER: 'other' }) === null
    && autopayProviderFor({ ...AENV, SUBSCRIPTION_CASHFREE_SECRET_KEY: '' }) === null);

  const cf = fakeCashfree(), ap = autopayProviderFor(AENV, cf.fetch, () => NOW);
  const made = await ap.createAutopay({ ref: MANDATE, terms, phone: '9876543210', email: 'owner@shop.in', appUrl: 'https://app.hangtag.in/', returnUrl: autopayReturnUrl(AENV),
    notes: { hangtag_owner: 'u1', hangtag_mandate: MANDATE } });
  const post = cf.log.find((l) => l.method === 'POST' && l.path === '/subscriptions'), b = (post && post.body) || {};
  check('A2 the mandate: named after the set-up (htap_…), on demand (it charges nothing by itself), for up to the AutoPay price in INR, ₹1 to confirm (refunded), the payer\'s mobile and email, the set-up\'s tags; the set-up\'s id as the idempotency key',
    made.subscriptionId === SUB && b.subscription_id === SUB && b.plan_details.plan_type === 'ON_DEMAND' && b.plan_details.plan_max_amount === 599 && b.plan_details.plan_currency === 'INR'
    && b.authorization_details.authorization_amount === 1 && b.authorization_details.authorization_amount_refund === true && b.customer_details.customer_phone === '9876543210'
    && b.customer_details.customer_email === 'owner@shop.in' && b.subscription_tags.hangtag_mandate === MANDATE && post.headers['x-idempotency-key'] === MANDATE
    && post.headers['x-api-version'] === API_VERSION && !('subscription_first_charge_time' in b), b);
  check('…approved on Cashfree\'s page through the app\'s own autopay.html (the session in the #part, the environment named); back to the app through the webhook function',
    made.authUrl === `https://app.hangtag.in/autopay.html#cf=${encodeURIComponent(cf.subs.get(SUB).subscription_session_id)}&env=sandbox`
    && b.subscription_meta.return_url === 'https://proj.supabase.co/functions/v1/subscription-webhook?back=autopay'
    && appBackUrl(AENV, 'autopay') === 'https://app.hangtag.in/#plans?autopay=back' && appBackUrl(AENV, 'elsewhere') === null && appBackUrl({ APP_URL: 'http://x' }, 'autopay') === null, made);
  let noPhone = null;
  try { await ap.createAutopay({ ref: MANDATE.replace(/a/g, 'b'), terms, phone: '', email: 'o@s.in', appUrl: 'https://app.hangtag.in' }); } catch (e) { noPhone = e.message; }
  check('…no mobile number: refused before Cashfree is asked', noPhone === 'phone_required' && cf.log.filter((l) => l.path === '/subscriptions').length === 1);
  const view = (s, id = SUB) => mandateView({ subscription_id: id, subscription_status: s });
  check('A3 Cashfree\'s states as AutoPay reads them: waiting for the owner or the bank → created, nothing reported; ACTIVE → authenticated; on hold or paused → halted; cancelled by Hangtag or at the bank → cancelled; expired (link, card) → expired; not Hangtag\'s → unknown',
    ['INITIALIZED', 'BANK_APPROVAL_PENDING'].every((s) => view(s).status === 'created' && view(s).event === null) && view('ACTIVE').event === 'authenticated'
    && ['ON_HOLD', 'PAUSED', 'CUSTOMER_PAUSED'].every((s) => view(s).event === 'halted') && ['CANCELLED', 'CUSTOMER_CANCELLED'].every((s) => view(s).status === 'cancelled')
    && ['EXPIRED', 'LINK_EXPIRED', 'CARD_EXPIRED'].every((s) => view(s).status === 'expired') && view('ACTIVE', 'sub_other').status === 'unknown');

  cf.approve(SUB);
  const due = NOW + 3 * 86400e3, ref = chargeIdFor(SUB, due);
  await ap.raiseCharge({ subscriptionId: SUB, ref, amount: 599, scheduleAt: due });
  const pay = cf.log.filter((l) => l.path === '/subscriptions/pay').pop().body;
  const twice = await ap.raiseCharge({ subscriptionId: SUB, ref, amount: 599, scheduleAt: due });
  check('A4 a charge: on the mandate, CHARGE, the price, taken on the due date (India), named after that date; asked again → the same charge, never a second',
    pay.subscription_id === SUB && pay.payment_type === 'CHARGE' && pay.payment_amount === 599 && pay.payment_schedule_date === istTime(due) && pay.payment_id === ref
    && /^htc_[0-9a-z]+_\d{8}$/.test(ref) && twice.already === true && cf.charges.get(SUB).filter((c) => c.payment_type === 'CHARGE').length === 1, { pay, twice });
  const listed = await ap.listCharges(SUB);
  check('…its charges read back without the ₹1 authorisation', listed.length === 1 && listed[0].ref === ref && listed[0].status === 'initialized' && listed[0].amount === 59900, listed);
  const off = await ap.cancelAutopay(SUB);
  check('A5 turned off: Cashfree cancels the mandate (no charge can be made on it), and a charge asked for that hasn\'t begun is withdrawn',
    off.status === 'cancelled' && cf.subs.get(SUB).subscription_status === 'CANCELLED' && cf.charges.get(SUB).find((c) => c.payment_id === ref).payment_status === 'CANCELLED', off);
  const again = await cancelOrConfirm(ap, SUB);
  check('…turned off twice: Cashfree refuses, the mandate read back confirms it is off', again.confirmed === true && again.status === 'cancelled', again);

  const evt = (type, data) => readCashfreeWebhook({ type, event_time: '2026-11-20T10:00:00+05:30', data }, '');
  const charged = evt('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_amount: 599, payment_status: 'SUCCESS' });
  const parsed = {
    approved: evt('SUBSCRIPTION_AUTH_STATUS', { subscription_id: SUB, authorization_details: { authorization_status: 'ACTIVE' } }),
    atBank: evt('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: SUB, subscription_status: 'CUSTOMER_CANCELLED' } }),
    authPay: evt('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: '6999', payment_type: 'AUTH', payment_amount: 1, payment_status: 'SUCCESS' }),
    failed: evt('SUBSCRIPTION_PAYMENT_FAILED', { subscription_id: SUB, cf_payment_id: '7002', payment_type: 'CHARGE', payment_status: 'FAILED' }),
    authRefund: evt('SUBSCRIPTION_REFUND_STATUS', { subscription_id: SUB, refund_amount: 1, refund_status: 'SUCCESS' }),
    chargeRefund: evt('SUBSCRIPTION_REFUND_STATUS', { subscription_id: SUB, cf_payment_id: '7001', cf_refund_id: 'rf1', refund_amount: 599, refund_status: 'SUCCESS' }),
    notOurs: evt('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: 'sub_elsewhere', cf_payment_id: '1', payment_type: 'CHARGE', payment_amount: 5, payment_status: 'SUCCESS' }),
    // Cashfree's own example of this notification names the instrument instead (payment_type DEBIT_CARD): still only named
    instrument: evt('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: '7003', payment_type: 'DEBIT_CARD', payment_amount: 599, payment_status: 'SUCCESS' }),
    noIds: evt('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, payment_type: 'CHARGE', payment_amount: 599, payment_status: 'SUCCESS' }),
  };
  check('A6 notifications: approved → authenticated; cancelled at the bank → cancelled; a payment reported paid → charged and a failed one → pending, each only NAMED (Cashfree\'s payment id and Hangtag\'s, to be confirmed from the API: no amount taken from the notification), whatever its payment_type says; the ₹1 authorisation (AUTH) is no charge; the ₹1 refunded is nothing to review, a charge refunded is; another account\'s mandate or no payment named → ignored',
    parsed.approved.event === 'authenticated' && parsed.atBank.event === 'cancelled' && charged.event === 'charged' && charged.paymentId === '7001' && charged.chargeRef === ref
    && charged.confirm === true && charged.claimsCharge === true && charged.amount === null && parsed.instrument.confirm === true && parsed.instrument.claimsCharge === false
    && parsed.authPay === null && parsed.failed.event === 'pending' && parsed.failed.confirm === true && parsed.authRefund === null && parsed.chargeRefund.kind === 'mandate_refund'
    && parsed.chargeRefund.amount === 599 && parsed.notOurs === null && parsed.noIds === null, { charged, ...parsed });

  const quote = { data: { available: true, price: 599, today: 0, currency: 'INR', plan: terms.plan, consent_version: 'autopay-2026-10', first_charge_at: FIRST }, error: null };
  const callH = (body, script, c = fakeCashfree()) => {
    const db = fakeDb(script);
    return handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => body }, { env: AENV, provider: providerFor(AENV, c.fetch, () => NOW),
      autopay: autopayProviderFor(AENV, c.fetch, () => NOW), named: (n) => providerNamed(n, AENV, c.fetch, () => NOW), planId: '', userDb: () => db, admin: () => db, now: () => NOW,
      log: spy() }).then((r) => ({ ...r, db, cf: c }));
  };
  const cfg = await callH({ action: 'config' }, { 'rpc:hangtag_autopay_quote': quote });
  check('A7 config: AutoPay offered with Cashfree (no provider plan needed), and what UPI or a card takes to confirm it said up front (₹1, refunded)',
    cfg.status === 200 && cfg.body.autopay === true && cfg.body.autopay_verify === 1, cfg.body);
  const started = (phone) => ({ 'rpc:hangtag_autopay_quote': quote, 'rpc:hangtag_billing_call_claim': { data: { ok: true }, error: null }, 'from:hangtag_profiles': { data: { phone }, error: null },
    'rpc:hangtag_autopay_begin': { data: { ...terms, to_cancel: [] }, error: null }, 'rpc:hangtag_autopay_attach_mandate': { data: { current: true }, error: null } });
  const s0 = await callH({ action: 'autopay_start', consent: true, consent_version: 'autopay-2026-10' }, started(''));
  check('A8 AutoPay with no usable mobile number: asked for (phone_required) before any consent is recorded or mandate made',
    s0.status === 400 && s0.body.error === 'phone_required' && !s0.db.log.includes('rpc:hangtag_autopay_begin') && !s0.cf.log.some((l) => l.path === '/subscriptions'), s0.body);
  const s1 = await callH({ action: 'autopay_start', consent: true, consent_version: 'autopay-2026-10', phone: '98450 22222' }, started(''));
  const mk = s1.cf.log.find((l) => l.path === '/subscriptions');
  check('…the number typed for it: the consent recorded, then the mandate made with that number (never stored), recorded against the set-up; the page to approve it returned',
    s1.status === 200 && /\/autopay\.html#cf=/.test(s1.body.auth_url) && mk && mk.body.customer_details.customer_phone === '9845022222' && mk.body.subscription_id === SUB
    && s1.db.log.indexOf('rpc:hangtag_autopay_begin') < s1.db.log.indexOf('rpc:hangtag_autopay_attach_mandate')
    && s1.db.calls.some((c) => c.name === 'hangtag_autopay_attach_mandate' && c.args.p_provider === 'cashfree' && c.args.p_subscription === SUB && c.args.p_mandate === MANDATE)
    && !s1.db.calls.some((c) => JSON.stringify(c.args || {}).includes('9845022222')), { body: s1.body, log: s1.db.log });
  const cfC = fakeCashfree();
  cfC.mandate(SUB, 'ACTIVE');
  const cx = await callH({ action: 'autopay_cancel' }, { 'rpc:hangtag_autopay_cancel_request': { data: { provider: 'cashfree', subscription_id: SUB }, error: null },
    'rpc:hangtag_autopay_report': { data: { ok: true, known: true }, error: null } }, cfC);
  check('A9 turned off during the free month: off at Cashfree first (the mandate cancelled), only then recorded as cancelled',
    cx.status === 200 && cfC.subs.get(SUB).subscription_status === 'CANCELLED'
    && cx.db.calls.some((c) => c.name === 'hangtag_autopay_report' && c.args.p_event === 'cancelled' && c.args.p_provider === 'cashfree' && c.args.p_subscription === SUB), cx.body);

  const rawCharged = JSON.stringify({ type: 'SUBSCRIPTION_PAYMENT_SUCCESS', event_time: '2026-11-20T10:00:00+05:30',
    data: { subscription_id: SUB, cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_amount: 599.0, payment_status: 'SUCCESS' } });
  // Cashfree holding the mandate and its charges as its API lists them (the ₹1 authorisation, then the charge named)
  const cfWith = (status = 'SUCCESS', amount = 599, extra = []) => {
    const c = fakeCashfree();
    c.mandate(SUB, 'ACTIVE');
    c.charges.get(SUB).push({ payment_id: 'auth_x', cf_payment_id: '6999', payment_type: 'AUTH', payment_amount: 1, payment_status: 'SUCCESS' }, ...extra);
    if (status) c.charges.get(SUB).push({ payment_id: ref, cf_payment_id: '7001', payment_type: 'CHARGE', payment_amount: amount, payment_status: status });
    return c;
  };
  const regDb = () => fakeDb({ 'rpc:hangtag_autopay_report': { data: { ok: true, known: true, recorded: true }, error: null } });
  const reported = (w) => w.db.calls.filter((c) => c.name === 'hangtag_autopay_report').map((c) => c.args);
  const w1 = await deliver(cfWith(), rawCharged, { db: regDb() });
  const rep = w1.db.calls.find((c) => c.name === 'hangtag_autopay_report');
  check('A10 a signed charge notification, the charge read back from Cashfree\'s API (SUCCESS) → the registry told once: Cashfree, the mandate, charged, Cashfree\'s payment id, ₹599 INR as the API lists it, as of its confirmation (now, never "older" than an earlier read); noted as settled',
    w1.status === 200 && rep && rep.args.p_provider === 'cashfree' && rep.args.p_subscription === SUB && rep.args.p_event === 'charged' && rep.args.p_payment === '7001'
    && rep.args.p_amount === 599 && rep.args.p_currency === 'INR' && rep.args.p_event_at === new Date(1_800_000_000_000).toISOString() && w1.db.log.includes('rpc:hangtag_billing_event_record')
    && w1.db.calls.filter((c) => c.name === 'hangtag_autopay_report').length === 1, { status: w1.status, rep });
  const rawWith = (type, data) => JSON.stringify({ type, event_time: '2026-11-20T10:00:00+05:30', data: { subscription_id: SUB, ...data } });
  const c1 = await deliver(cfWith('SUCCESS', 999), rawCharged, { db: regDb() });
  const c2 = await deliver(cfWith('PENDING'), rawCharged, { db: regDb() });
  const c3 = await deliver(cfWith(null), rawCharged, { db: regDb() });
  const c4 = await deliver(cfWith(null), rawWith('SUBSCRIPTION_PAYMENT_SUCCESS', { cf_payment_id: '6999', payment_id: 'auth_x', payment_type: 'DEBIT_CARD', payment_amount: 1, payment_status: 'SUCCESS' }), { db: regDb() });
  const c5 = await deliver(cfWith('FAILED'), rawWith('SUBSCRIPTION_PAYMENT_FAILED', { cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_status: 'FAILED' }), { db: regDb() });
  const c6 = await deliver(cfWith('SUCCESS'), rawWith('SUBSCRIPTION_PAYMENT_FAILED', { cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_status: 'FAILED' }), { db: regDb() });
  const c7 = await deliver(cfWith('CANCELLED'), rawWith('SUBSCRIPTION_PAYMENT_FAILED', { cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_status: 'FAILED' }), { db: regDb() });
  const cfWdrawn = cfWith('CANCELLED'); cfWdrawn.subs.get(SUB).subscription_status = 'CANCELLED';
  const c7b = await deliver(cfWdrawn, rawWith('SUBSCRIPTION_PAYMENT_FAILED', { cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_status: 'FAILED' }), { db: regDb() });
  const cfDown = cfWith(); cfDown.failNext(500);
  const c8 = await deliver(cfDown, rawCharged, { db: regDb() });
  // Cashfree's own retries of a failed UPI charge, each attempt listed under the same payment_id
  const attempt0 = { payment_id: ref, cf_payment_id: '7000', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'FAILED' };
  const c9 = await deliver(cfWith('SUCCESS', 599, [attempt0]), rawCharged, { db: regDb() });
  const c10 = await deliver(cfWith('PENDING', 599, [attempt0]), rawWith('SUBSCRIPTION_PAYMENT_FAILED', { cf_payment_id: '7000', payment_id: ref, payment_type: 'CHARGE', payment_status: 'FAILED' }), { db: regDb() });
  check('A10c a charge Cashfree retried (each attempt listed under the same payment_id): the attempt taken counts (its own id), never an earlier failed one; a failed attempt while a retry is still in progress shows nothing yet',
    reported(c9).length === 1 && reported(c9)[0].p_event === 'charged' && reported(c9)[0].p_payment === '7001' && c10.status === 200 && reported(c10).length === 0,
    { c9: reported(c9), c10: c10.body });
  const attempt7200 = { payment_id: ref, cf_payment_id: '7200', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'FAILED' };
  const d1 = await deliver(cfWith(null, 599, [attempt7200]), rawWith('SUBSCRIPTION_PAYMENT_SUCCESS', { cf_payment_id: '7201', payment_id: ref, payment_type: 'CHARGE', payment_amount: 599, payment_status: 'SUCCESS' }), { db: regDb() });
  const d2 = await deliver(cfWith('FAILED'), rawCharged, { db: regDb() });
  check('A10d a success reported for an attempt the API doesn\'t list yet, while only an EARLIER attempt shows failed: 503 (sent again) and not noted — never settled as a failure (which would lose it); a reported success whose OWN attempt the API lists as failed: pending (the API\'s word wins)',
    d1.status === 503 && reported(d1).length === 0 && !d1.db.log.includes('rpc:hangtag_billing_event_record') && reported(d2).length === 1 && reported(d2)[0].p_event === 'pending',
    { d1: d1.status, d2: reported(d2) });
  check('A10b nothing a charge notification says is trusted: the amount is Cashfree\'s API\'s (₹999 listed → ₹999 reported, for the registry to hold against the price); reported paid but the API shows it still in progress, or doesn\'t list it yet → 503 (sent again), nothing reported or noted; the ₹1 authorisation under another payment_type → ignored (the API lists it as AUTH, never a charge); a failure the API shows → pending, and a "failure" the API shows paid → charged; a charge the API shows cancelled while the mandate is still ACTIVE (the payer declined it) → pending, one withdrawn with a mandate turned off → ignored; Cashfree not answering → 503',
    reported(c1).length === 1 && reported(c1)[0].p_amount === 999 && c2.status === 503 && reported(c2).length === 0 && !c2.db.log.includes('rpc:hangtag_billing_event_record')
    && c3.status === 503 && reported(c3).length === 0 && c4.status === 200 && c4.body.ignored === true && reported(c4).length === 0
    && reported(c5).length === 1 && reported(c5)[0].p_event === 'pending' && reported(c6).length === 1 && reported(c6)[0].p_event === 'charged' && reported(c6)[0].p_amount === 599
    && c7.status === 200 && reported(c7).length === 1 && reported(c7)[0].p_event === 'pending' && c7b.status === 200 && c7b.body.ignored === true && reported(c7b).length === 0
    && c8.status === 503 && reported(c8).length === 0,
    { c1: reported(c1), c2: c2.status, c3: c3.status, c4: c4.body, c5: reported(c5), c6: reported(c6), c7: reported(c7), c7b: c7b.body, c8: c8.status });
  // SUBSCRIPTION_PAYMENT_CANCELLED: read back like a failure — the payer declined the charge (the mandate still ACTIVE) → past
  // due; withdrawn with a mandate turned off → nothing; the mandate unreadable → 503 (sent again); the ₹1 authorisation → ignored
  const rawDeclined = rawWith('SUBSCRIPTION_PAYMENT_CANCELLED', { cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_status: 'CANCELLED' });
  const y1 = await deliver(cfWith('CANCELLED'), rawDeclined, { db: regDb() });
  const cfOff2 = cfWith('CANCELLED'); cfOff2.subs.get(SUB).subscription_status = 'CANCELLED';
  const y2 = await deliver(cfOff2, rawDeclined, { db: regDb() });
  const cfNoMandate = cfWith('CANCELLED'), f0 = cfNoMandate.fetch;
  cfNoMandate.fetch = async (url, init) => (/\/subscriptions\/[^/]+$/.test(new URL(url).pathname) ? { ok: false, status: 500, json: async () => ({ code: 'server_error' }) } : f0(url, init));
  const y3 = await deliver(cfNoMandate, rawDeclined, { db: regDb() });
  const y4 = await deliver(cfWith(null), rawWith('SUBSCRIPTION_PAYMENT_CANCELLED', { cf_payment_id: '6999', payment_id: 'auth_x', payment_type: 'AUTH', payment_status: 'CANCELLED' }), { db: regDb() });
  check('A19 a charge cancelled at Cashfree (SUBSCRIPTION_PAYMENT_CANCELLED): the payer declined it on a mandate still ACTIVE → past due (pending, as of its confirmation), noted once; withdrawn with a mandate turned off → ignored, nothing reported; the mandate unreadable → 503, nothing noted; the ₹1 authorisation → ignored, never looked up',
    y1.status === 200 && reported(y1).length === 1 && reported(y1)[0].p_event === 'pending' && reported(y1)[0].p_payment === '7001' && y1.db.log.includes('rpc:hangtag_billing_event_record')
    && y2.status === 200 && y2.body.ignored === true && reported(y2).length === 0
    && y3.status === 503 && reported(y3).length === 0 && !y3.db.log.includes('rpc:hangtag_billing_event_record')
    && y4.status === 200 && y4.body.ignored === true && reported(y4).length === 0,
    { y1: reported(y1), y2: y2.body, y3: y3.status, y4: y4.body });
  // SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED: the pre-debit notice — nothing reported (no money moved); noted once; held
  // against the set-up it names: a charge Hangtag never asked for is kept for review while it can still be withdrawn
  const rawNotice = (data) => rawWith('SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED', { cf_payment_id: '7001', payment_id: ref, payment_type: 'CHARGE', payment_amount: 599,
    payment_currency: 'INR', payment_schedule_date: '2027-01-18T12:00:00+05:30', payment_status: 'INITIALIZED', ...data });
  const setUp = (extra = {}) => ({ data: { shop_owner_id: 'u1', price: 599, is_current: true, cancel_requested_at: null, provider_status: 'authenticated', ...extra }, error: null });
  const noticeDb = (row = setUp()) => fakeDb({ 'from:hangtag_autopay_mandates': row });
  const opened = (w) => w.db.calls.filter((c) => c.name === 'hangtag_billing_exception_open').map((c) => ({ kind: c.args.p_kind, ref: c.args.p_ref, why: c.args.p_detail.reason }));
  const noted = (w) => (w.db.calls.find((c) => c.name === 'hangtag_billing_event_record') || {}).args || null;
  const n1 = await deliver(fakeCashfree(), rawNotice({}), { db: noticeDb() });
  const n2 = await deliver(fakeCashfree(), rawNotice({ payment_id: 'dashboard_charge_1' }), { db: noticeDb() });
  const n3 = await deliver(fakeCashfree(), rawNotice({ payment_amount: 999 }), { db: noticeDb() });
  const n4 = await deliver(fakeCashfree(), rawNotice({}), { db: noticeDb(setUp({ cancel_requested_at: '2027-01-17T10:00:00Z' })) });
  const n5 = await deliver(fakeCashfree(), rawNotice({}), { db: noticeDb({ data: null, error: null }) });
  const n6 = await deliver(fakeCashfree(), rawNotice({ cf_payment_id: '6999', payment_id: 'auth_x', payment_type: 'AUTH', payment_amount: 1 }), { db: noticeDb() });
  const n7 = await deliver(fakeCashfree(), rawNotice({}), { db: noticeDb({ data: null, error: { code: '57014', message: 'timeout' } }) });
  check('A20 the pre-debit notice for Hangtag\'s own charge at the price agreed: 200 "notice", noted once (the mandate, the charge it names), no report, nothing for review; for a charge not Hangtag\'s, over the price, or on a set-up being turned off: kept for review (unexpected_charge, by the charge) while it can still be withdrawn; a mandate no shop holds or the ₹1 authorisation: ignored; the set-up unreadable: 500 (sent again), nothing noted',
    n1.status === 200 && n1.body.status === 'notice' && !n1.db.log.includes('rpc:hangtag_autopay_report') && opened(n1).length === 0
    && noted(n1) && noted(n1).p_type === 'SUBSCRIPTION_PAYMENT_NOTIFICATION_INITIATED' && noted(n1).p_ref === SUB && noted(n1).p_entity === ref && noted(n1).p_outcome === 'notice'
    && n2.body.status === 'review' && JSON.stringify(opened(n2)) === JSON.stringify([{ kind: 'unexpected_charge', ref: 'dashboard_charge_1', why: 'not_hangtag_charge' }])
    && n3.body.status === 'review' && opened(n3)[0].why === 'over_price' && n4.body.status === 'review' && opened(n4)[0].why === 'autopay_off'
    && n5.status === 200 && n5.body.ignored === true && opened(n5).length === 0
    && n6.status === 200 && n6.body.ignored === true && !n6.db.log.includes('from:hangtag_autopay_mandates')
    && n7.status === 500 && !n7.db.log.includes('rpc:hangtag_billing_event_record') && ![n1, n2, n3, n4].some((w) => w.db.log.includes('rpc:hangtag_autopay_report')),
    { n1: [n1.status, n1.body, noted(n1)], n2: opened(n2), n3: opened(n3), n4: opened(n4), n5: n5.body, n6: n6.body, n7: n7.status });
  const w2 = await deliver(fakeCashfree(), rawCharged, { headers: { 'x-webhook-signature': 'forged' } });
  const w3 = await deliver(fakeCashfree(), rawCharged, { db: fakeDb({ 'rpc:hangtag_billing_event_seen': { data: { duplicate: true, mode_ok: true, billing_mode: 'test' }, error: null } }) });
  check('…a forged signature: 400, the database never opened; the same notification again: 200, nothing reported twice',
    w2.status === 400 && w2.made === 0 && w3.status === 200 && w3.body.duplicate === true && !w3.db.log.includes('rpc:hangtag_autopay_report'), { w2: w2.status, w3: w3.body });
  const rawRefund = JSON.stringify({ type: 'SUBSCRIPTION_REFUND_STATUS', event_time: '2026-11-21T10:00:00+05:30',
    data: { subscription_id: SUB, cf_payment_id: '7001', cf_refund_id: 'rf_1', refund_amount: 599, refund_status: 'SUCCESS' } });
  const w4 = await deliver(fakeCashfree(), rawRefund, { db: fakeDb() });
  const x4 = w4.db.calls.find((c) => c.name === 'hangtag_billing_exception_open');
  check('…a charge refunded: kept for review (refund), no time taken away', w4.status === 200 && x4 && x4.args.p_kind === 'refund' && x4.args.p_provider_payment === '7001'
    && !w4.db.log.includes('rpc:hangtag_autopay_report'), { w4: w4.body, x4 });

  // the console's webhook self-check: what proves Cashfree's notifications reach the database before any shop uses AutoPay
  const cfS = fakeCashfree();
  const sc = await callH({ action: 'billing_selfcheck' }, { 'rpc:hangtag_billing_selfcheck_allowed': { data: true, error: null } }, cfS);
  const probes = sc.db.calls.filter((c) => c.name === 'hangtag_billing_probe_record'), probeLink = cfS.log.find((l) => l.method === 'POST' && l.path === '/links');
  check('A14 the console\'s webhook self-check with Cashfree: a ₹1 link carrying this function\'s webhook and a ₹1 on-demand mandate, each withdrawn at once and recorded as probes of their kind',
    sc.status === 200 && sc.body.ok === true && probes.length === 2 && probes[0].args.p_provider === 'cashfree' && probes[0].args.p_kind === 'payment_link'
    && probes[1].args.p_kind === 'subscription' && /^htap_/.test(probes[1].args.p_entity) && probeLink && probeLink.body.link_amount === 1
    && probeLink.body.link_meta.notify_url === 'https://proj.supabase.co/functions/v1/subscription-webhook'
    && cfS.links.get(probes[0].args.p_entity).link_status === 'CANCELLED' && cfS.subs.get(probes[1].args.p_entity).subscription_status === 'CANCELLED',
    { body: sc.body, probes: probes.map((p) => p.args) });

  // the reconciler's daily read of each mandate asks for the charge due next
  const recDb = () => fakeDb({ 'rpc:hangtag_autopay_report': { data: { ok: true, known: true, recorded: true }, error: null } });
  const DUE = NOW + 30 * 86400e3, asked = (c) => c.log.filter((l) => l.path === '/subscriptions/pay');
  const mandateOf = (c) => autopayProviderFor(AENV, c.fetch, () => NOW);
  const read = (c, at, m) => { const ctx = { sr: recDb(), mode: 'test', autopay: mandateOf(c), named: () => null, now: () => at, log: spy(),
    run: { checked: 0, repaired: 0, exceptions_opened: 0 }, spend: () => {} }; return checkMandate(ctx, m).then(() => ctx); };
  const m = (extra = {}) => ({ id: 'm1', provider: 'cashfree', subscription_id: SUB, current: true, next_charge_at: new Date(DUE).toISOString(), price: 599, currency: 'INR',
    reason: 'check', recorded: [], ...extra });
  const cfR = fakeCashfree();
  cfR.mandate(SUB, 'INITIALIZED'); cfR.approve(SUB);
  await read(cfR, NOW, m());
  const r2 = await read(cfR, DUE - 3.5 * 86400e3, m());
  await read(cfR, DUE - 3 * 86400e3, m());
  check('A11 the trial\'s end weeks away: nothing asked for; within 4 days of it: the first charge asked for once, the price agreed, taken on the day the trial ends; read again: not asked twice',
    asked(cfR).length === 1 && asked(cfR)[0].body.payment_amount === 599 && asked(cfR)[0].body.payment_schedule_date === istTime(DUE)
    && asked(cfR)[0].body.payment_id === chargeIdFor(SUB, DUE) && r2.run.charges_asked === 1, asked(cfR).map((l) => l.body));
  const cfLate = fakeCashfree();
  cfLate.mandate(SUB, 'ACTIVE');
  await read(cfLate, DUE - 86400e3, m());
  check('…read only a day before it is due: asked for the earliest day Cashfree takes it (2 days on), not the day already too close',
    asked(cfLate).length === 1 && asked(cfLate)[0].body.payment_schedule_date === istTime(DUE + 86400e3), asked(cfLate).map((l) => l.body));
  const cfOff = fakeCashfree();
  cfOff.mandate(SUB, 'CANCELLED');
  await read(cfOff, DUE - 3.5 * 86400e3, m());
  const cfOld = fakeCashfree();
  cfOld.mandate(SUB, 'ACTIVE');
  await read(cfOld, DUE - 3.5 * 86400e3, m({ current: false }));
  await read(cfOld, DUE - 3.5 * 86400e3, m({ next_charge_at: null }));
  check('A12 a mandate turned off (cancelled at Cashfree), one no longer the shop\'s current set-up, or one with no charge due (turned off in Hangtag): never charged',
    asked(cfOff).length === 0 && asked(cfOld).length === 0);
  cfR.charges.get(SUB).find((c) => c.payment_type === 'CHARGE').payment_status = 'SUCCESS';
  const r6 = await read(cfR, DUE + 86400e3, m({ reason: 'charge_overdue', overdue_days: 1 }));
  const rec6 = r6.sr.calls.filter((c) => c.name === 'hangtag_autopay_report' && c.args.p_event === 'charged');
  check('A13 a charge Cashfree took that no notification recorded: recorded from the read (its id, the amount), once; the ₹1 authorisation never',
    rec6.length === 1 && rec6[0].args.p_payment === '7001' && rec6[0].args.p_amount === 599 && r6.run.repaired === 1, rec6.map((c) => c.args));
  // a renewal that failed: Cashfree keeps the mandate ACTIVE, so its daily read must not report it as fine
  const cfF = fakeCashfree();
  cfF.mandate(SUB, 'ACTIVE');
  cfF.charges.get(SUB).push({ payment_id: chargeIdFor(SUB, DUE), cf_payment_id: '7005', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'FAILED' });
  const events = (r) => r.sr.calls.filter((c) => c.name === 'hangtag_autopay_report').map((c) => c.args.p_event);
  const f1 = await read(cfF, DUE + 86400e3, m({ reason: 'charge_overdue', overdue_days: 1 }));
  const f2 = await read(cfF, DUE + 2 * 86400e3, m({ reason: 'charge_overdue', overdue_days: 2, provider_status: 'pending' }));
  const cfOk = fakeCashfree();
  cfOk.mandate(SUB, 'ACTIVE');
  cfOk.charges.get(SUB).push({ payment_id: chargeIdFor(SUB, DUE - 31 * 86400e3), cf_payment_id: '7004', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'FAILED' });
  const f3 = await read(cfOk, DUE - 3.5 * 86400e3, m({ recorded: [] }));
  const cfRetried = fakeCashfree();
  cfRetried.mandate(SUB, 'ACTIVE');
  cfRetried.charges.get(SUB).push({ payment_id: chargeIdFor(SUB, DUE), cf_payment_id: '7005', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'FAILED' },
    { payment_id: chargeIdFor(SUB, DUE), cf_payment_id: '7006', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'SUCCESS' });
  const f4 = await read(cfRetried, DUE + 86400e3, m({ reason: 'charge_overdue', overdue_days: 1 }));
  check('…a renewal that failed once and was then taken on Cashfree\'s retry (same payment_id): not past due; the attempt taken recorded',
    JSON.stringify(events(f4)) === '["authenticated","charged"]' && f4.sr.calls.some((c) => c.name === 'hangtag_autopay_report' && c.args.p_payment === '7006'), events(f4));
  const charged4 = f4.sr.calls.find((c) => c.name === 'hangtag_autopay_report' && c.args.p_event === 'charged');
  const state4 = f4.sr.calls.find((c) => c.name === 'hangtag_autopay_report' && c.args.p_event === 'authenticated');
  check('A15b a charge found by the read is reported as of that read (never with Cashfree\'s days-old "asked for" time, which made the registry treat it as older than the read and leave the next charge where it was)',
    charged4 && state4 && charged4.args.p_event_at === state4.args.p_event_at && charged4.args.p_event_at === new Date(DUE + 86400e3).toISOString(), { charged: charged4 && charged4.args.p_event_at });

  // turned off again after a cancel whose answer was lost: Cashfree refuses the second cancel, and the charge raised for
  // the next date is withdrawn all the same; a mandate that has ended keeps no charge raised (its read withdraws it)
  const pending = (id) => ({ payment_id: chargeIdFor(SUB, DUE), cf_payment_id: id, payment_type: 'CHARGE', payment_amount: 599, payment_status: 'INITIALIZED' });
  const cfC2 = fakeCashfree();
  cfC2.mandate(SUB, 'CANCELLED'); cfC2.charges.get(SUB).push(pending('7010'));
  const again2 = await cancelOrConfirm(mandateOf(cfC2), SUB);
  const cfC3 = fakeCashfree();
  cfC3.mandate(SUB, 'CANCELLED'); cfC3.charges.get(SUB).push(pending('7011'));
  await read(cfC3, DUE - 2 * 86400e3, m({ reason: 'final' }));
  check('A16 no charge outlives a cancel: a retried cancel Cashfree refuses as already done still withdraws the charge raised for the next date; the read of an ended mandate withdraws one left behind; nothing new asked for',
    again2.confirmed === true && cfC2.charges.get(SUB)[0].payment_status === 'CANCELLED' && cfC3.charges.get(SUB)[0].payment_status === 'CANCELLED' && asked(cfC3).length === 0,
    { again2, c2: cfC2.charges.get(SUB)[0].payment_status, c3: cfC3.charges.get(SUB)[0].payment_status });

  // the hourly run: one set-up Cashfree answers with a 4xx for (gone from the account) doesn't stop the others being read
  const SUB2 = autopayIdFor('7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4c'), cfGone = fakeCashfree();
  cfGone.mandate(SUB2, 'ACTIVE');
  const begun = { run_id: 7, started_at: new Date(NOW).toISOString(), payments: [], mandates: [m({ id: 'gone', subscription_id: SUB }), m({ id: 'ok', subscription_id: SUB2 })] };
  const sr7 = fakeDb({ 'rpc:hangtag_billing_reconcile_begin': { data: begun, error: null }, 'rpc:hangtag_autopay_report': { data: { ok: true, known: true }, error: null },
    'rpc:hangtag_billing_exception_open': { data: { opened: true }, error: null }, 'rpc:hangtag_billing_reconcile_done': { data: { ok: true }, error: null } });
  const r7 = await reconcile({ sr: sr7, mode: 'test', named: () => null, autopay: mandateOf(cfGone), now: () => NOW, log: spy() });
  const done7 = sr7.calls.find((c) => c.name === 'hangtag_billing_reconcile_done'), kept7 = sr7.calls.find((c) => c.name === 'hangtag_billing_exception_open');
  check('A17 a set-up Cashfree answers 4xx for: kept for review against it (reconcile_error), and the run goes on — the next set-up read, the run ok and complete, both stamped checked',
    r7.body.ok === true && r7.body.complete === true && kept7 && kept7.args.p_kind === 'reconcile_error' && kept7.args.p_ref === SUB
    && done7 && JSON.stringify(done7.args.p_result.checked_mandates) === '["gone","ok"]' && cfGone.log.some((l) => l.path === '/subscriptions/' + SUB2),
    { body: r7.body, kept: kept7 && kept7.args });

  // the owner turns AutoPay off while Cashfree can't confirm it: the cancel is kept owed, and until it is done the
  // reconciler retries it and asks for no charge — even with the mandate still ACTIVE and its renewal inside the lead time
  const cfDown2 = fakeCashfree();
  cfDown2.mandate(SUB, 'ACTIVE'); cfDown2.failNext(500);
  const cx2 = await callH({ action: 'autopay_cancel' }, { 'rpc:hangtag_autopay_cancel_request': { data: { provider: 'cashfree', subscription_id: SUB }, error: null },
    'rpc:hangtag_autopay_cancel_owed': { data: { requested: true }, error: null } }, cfDown2);
  const owed = cx2.db.calls.find((c) => c.name === 'hangtag_autopay_cancel_owed');
  const cfOwed = fakeCashfree();
  cfOwed.mandate(SUB, 'ACTIVE'); cfOwed.refuseCancels(true);
  const r8 = await read(cfOwed, DUE - 3.5 * 86400e3, m({ reason: 'cancel' }));
  check('A18 AutoPay turned off while Cashfree can\'t confirm it: 502, the cancel kept owed (Cashfree, the mandate, this mode), never recorded as cancelled; while it is owed, the read retries the cancel and asks for no charge though the mandate reads ACTIVE inside the lead time',
    cx2.status === 502 && owed && owed.args.p_provider === 'cashfree' && owed.args.p_subscription === SUB && owed.args.p_mode === 'test'
    && !cx2.db.calls.some((c) => c.name === 'hangtag_autopay_report' && c.args.p_event === 'cancelled')
    && cfOwed.log.some((l) => /\/manage$/.test(l.path)) && asked(cfOwed).length === 0 && r8.run.checked === 1,
    { status: cx2.status, owed: owed && owed.args, asked: asked(cfOwed).length });
  check('A15 the charge for the date now due failed (its notification missed, or come before the read): the daily read reports AutoPay past due (pending), never "authenticated" (which showed it as on and fine); once the registry holds it, not again (the failure\'s time isn\'t moved each day); never charged again for that date; a failure on an EARLIER date doesn\'t make a mandate past due',
    JSON.stringify(events(f1)) === '["pending"]' && events(f2).length === 0 && asked(cfF).length === 0 && JSON.stringify(events(f3)) === '["authenticated"]' && asked(cfOk).length === 1,
    { f1: events(f1), f2: events(f2), f3: events(f3), asked: asked(cfF).length });
  // the due charge cancelled, none failed: declined by the payer on a mandate still ACTIVE → past due by the daily read too;
  // withdrawn with a mandate turned off → read as cancelled, never past due
  const cfDecl = fakeCashfree();
  cfDecl.mandate(SUB, 'ACTIVE');
  cfDecl.charges.get(SUB).push({ payment_id: chargeIdFor(SUB, DUE), cf_payment_id: '7006', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'CANCELLED' });
  const g1 = await read(cfDecl, DUE + 86400e3, m({ reason: 'charge_overdue', overdue_days: 1 }));
  const cfWd = fakeCashfree();
  cfWd.mandate(SUB, 'CANCELLED');
  cfWd.charges.get(SUB).push({ payment_id: chargeIdFor(SUB, DUE), cf_payment_id: '7007', payment_type: 'CHARGE', payment_amount: 599, payment_status: 'CANCELLED' });
  const g2 = await read(cfWd, DUE + 86400e3, m({ reason: 'charge_overdue', overdue_days: 1 }));
  check('A15c the charge due declined by the payer (cancelled, none failed) while the mandate is ACTIVE: the daily read reports AutoPay past due, and asks for no other charge for that date; withdrawn with a mandate turned off: read as cancelled, never past due',
    JSON.stringify(events(g1)) === '["pending"]' && asked(cfDecl).length === 0 && JSON.stringify(events(g2)) === '["cancelled"]', { g1: events(g1), g2: events(g2) });
}

console.log('=== what the logs hold ===');
const leaky = (l) => l.includes(SECRET) || /[6-9][0-9]{9}/.test(l) || /@/.test(l);
check(`the handlers' log lines (${ALL.length}) carry ids and codes only: never the secret key, a phone number or an email`, ALL.length > 5 && !ALL.some(leaky), ALL.filter(leaky));
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
