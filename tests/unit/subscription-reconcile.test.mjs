// The billing reconciliation (supabase/functions/subscription/reconcile.js, REMEDIATION step 7) by its behaviour, with the
// real Razorpay and Cashfree providers over scripted APIs and a scripted database: what the provider holds is read back and
// repaired through the same functions as the notifications — once; what can't be matched is kept for review; one link
// that can't be read is kept against itself and the run goes on; a provider that is down stops the run (ok false, the
// window stays); the call cap ends a run ok but not complete; the entry needs its secret, and is one run at a time.
// Run: node tests/unit/subscription-reconcile.test.mjs
import { handleReconcile, reconcile, reconcileAuthorized } from '../../supabase/functions/subscription/reconcile.js';
import { providerNamed } from '../../supabase/functions/subscription/providers/index.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const NOW = Date.parse('2026-11-20T10:00:00Z'), now = () => NOW;
const ENV = { SUBSCRIPTION_RAZORPAY_KEY_ID: 'rzp_live_1', SUBSCRIPTION_RAZORPAY_KEY_SECRET: 's', SUBSCRIPTION_WEBHOOK_SECRET: 'w',
  SUBSCRIPTION_CASHFREE_APP_ID: 'APP1', SUBSCRIPTION_CASHFREE_SECRET_KEY: 'cfsk_ma_prod_k', SUBSCRIPTION_RECONCILE_SECRET: 'r'.repeat(40) };
const quiet = { error: () => {}, warn: () => {}, info: () => {} };

/* Razorpay's API, scripted by "METHOD /path" (the query kept) → body, or [status, body]; every call logged */
function fakeRazorpay(routes, log = []) {
  return async (url, init = {}) => {
    const key = (init.method || 'GET') + ' ' + url.replace('https://api.razorpay.com/v1', '');
    log.push(key);
    let r = routes[key];
    if (r === undefined) { const m = Object.keys(routes).find((k) => k.endsWith('*') && key.startsWith(k.slice(0, -1))); r = m ? routes[m] : undefined; }
    if (typeof r === 'function') r = r(key);
    const [status, body] = Array.isArray(r) ? r : r === undefined ? [404, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } }] : [200, r];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}
const emptyList = { items: [] };
/* The database, scripted: the run's targets, and every call recorded */
function fakeDb(begin, script = {}) {
  const calls = [];
  return {
    calls,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'hangtag_billing_reconcile_begin') return typeof begin === 'function' ? begin(args) : { data: begin, error: null };
      const s = script[name];
      if (typeof s === 'function') return s(args);
      if (s) return s;
      if (name === 'hangtag_billing_exception_open') return { data: { opened: true }, error: null };
      if (name === 'hangtag_billing_known_payments') return { data: [], error: null };
      if (name === 'hangtag_autopay_known') return { data: { known: [], probes: [] }, error: null };
      return { data: { ok: true }, error: null };
    },
  };
}
const begun = (o = {}) => ({ run_id: 7, mode: 'live', started_at: new Date(NOW).toISOString(), payments: [], mandates: [],
  c_since: new Date(NOW - 3600e3).toISOString(), d_since: new Date(NOW - 3600e3).toISOString(), ...o });
const run = async (db, routes, { budget = 300, cashfree = null } = {}) => {
  const api = [], fx = fakeRazorpay(routes, api);
  const rz = providerNamed('razorpay', ENV, fx, now);
  const cf = cashfree ? providerNamed('cashfree', ENV, cashfree.fetch, now) : null;
  const named = (n) => (n === 'razorpay' ? rz : n === 'cashfree' ? cf : null);
  const r = await reconcile({ sr: db, mode: 'live', named, autopay: rz, now, log: quiet, budget, limit: 50 });
  const done = db.calls.find((c) => c.name === 'hangtag_billing_reconcile_done');
  return { ...r, api, done: done && done.args.p_result, calls: db.calls };
};
const windows = { 'GET /subscriptions?*': emptyList, 'GET /payments?*': emptyList, 'GET /refunds?*': emptyList };
const called = (r, name) => r.calls.filter((c) => c.name === name);
const PID = '0b6f3a2e-8c1d-4f6a-9b2e-1c3d4e5f6a7b';

console.log('=== the entry ===');
{
  check('the secret: exactly "Bearer <secret>", 32 characters or more, compared in full', reconcileAuthorized('Bearer ' + 'r'.repeat(40), 'r'.repeat(40))
    && !reconcileAuthorized('Bearer ' + 'r'.repeat(39), 'r'.repeat(40)) && !reconcileAuthorized('Bearer short', 'short') && !reconcileAuthorized(undefined, 'r'.repeat(40)));
  let made = 0;
  const deps = (env) => ({ env, admin: () => { made++; return fakeDb(begun()); }, provider: providerNamed('razorpay', ENV, fakeRazorpay({}), now), named: () => null, now, log: quiet });
  const wrong = await handleReconcile({ method: 'POST', headers: { authorization: 'Bearer nope' } }, deps(ENV));
  const missing = await handleReconcile({ method: 'POST', headers: {} }, deps(ENV));
  const unset = await handleReconcile({ method: 'POST', headers: { authorization: 'Bearer short' } }, deps({ ...ENV, SUBSCRIPTION_RECONCILE_SECRET: 'short' }));
  const get = await handleReconcile({ method: 'GET', headers: {} }, deps(ENV));
  check('a wrong or missing secret → 401; a secret unset or under 32 characters → 503; not POST → 405 — and the database never reached',
    wrong.status === 401 && missing.status === 401 && unset.status === 503 && get.status === 405 && made === 0, { wrong, missing, unset, get });
  const ok = await handleReconcile({ method: 'POST', headers: { authorization: 'Bearer ' + 'r'.repeat(40) } }, deps(ENV));
  check('…the right one: a run, its answer counts only (no shop, payment or provider id)', ok.status === 200 && ok.body.ok === true && made === 1
    && JSON.stringify(Object.keys(ok.body).sort()) === JSON.stringify(['checked', 'complete', 'error_code', 'exceptions_opened', 'ok', 'repaired', 'run_id']), ok.body);
  const busy = await run(fakeDb({ busy: true }), {});
  const refused = await run(fakeDb({ refused: true, reason: 'mode_mismatch' }), {});
  check('another run going (or one just ended): busy, nothing read; another billing mode: refused, nothing read', busy.body.busy === true && busy.api.length === 0
    && refused.body.ok === false && refused.body.error === 'mode_mismatch' && refused.api.length === 0, { busy: busy.body, refused: refused.body });
}

console.log('=== A: plan payments whose notification was missed ===');
{
  const row = { id: PID, owner_id: 'u1', amount: 999, currency: 'INR', status: 'created', provider: 'razorpay', provider_order_id: 'plink_Abc1234567', created_at: new Date(NOW - 3 * 3600e3).toISOString() };
  const paidLink = { id: 'plink_Abc1234567', status: 'paid', amount: 99900, amount_paid: 99900, currency: 'INR', payments: [{ payment_id: 'pay_Nine123456', amount: 99900, status: 'captured' }] };
  const db = fakeDb(begun({ payments: [row] }), { hangtag_subscription_activate_checked: { data: { ok: true }, error: null } });
  const r = await run(db, { 'GET /payment_links/plink_Abc1234567': paidLink, ...windows });
  const act = called(r, 'hangtag_subscription_activate_checked');
  check('1 a created payment whose link was paid (captured) → activated once, in the billing mode; the run ok and complete',
    act.length === 1 && act[0].args.p_payment === PID && act[0].args.p_provider_payment === 'pay_Nine123456' && act[0].args.p_amount === 999 && act[0].args.p_mode === 'live'
    && r.done.ok === true && r.done.complete === true && r.done.repaired === 1 && r.done.checked_payments[0].final === true, { act, done: r.done });
  const again = await run(fakeDb(begun({ payments: [] })), windows);
  check('…the next run (the payment now paid, so not a target): nothing activated', called(again, 'hangtag_subscription_activate_checked').length === 0);
  const mismatch = await run(fakeDb(begun({ payments: [row] })), { 'GET /payment_links/plink_Abc1234567': { ...paidLink, amount_paid: 49900, payments: [{ payment_id: 'pay_Nine123456', amount: 49900, status: 'captured' }] }, ...windows });
  const x = called(mismatch, 'hangtag_billing_exception_open')[0];
  check('…a lost notification of the wrong amount → kept for review (amount_mismatch, the link, the provider payment), never activated',
    !called(mismatch, 'hangtag_subscription_activate_checked').length && x && x.args.p_kind === 'amount_mismatch' && x.args.p_ref === 'plink_Abc1234567'
    && x.args.p_provider_payment === 'pay_Nine123456' && mismatch.done.exceptions_opened === 1, x);
  const gone = await run(fakeDb(begun({ payments: [row, { ...row, id: '11111111-2222-4333-8444-555555555555', provider_order_id: 'plink_Def1234567' }] })),
    { 'GET /payment_links/plink_Abc1234567': [400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } }], 'GET /payment_links/plink_Def1234567': paidLink, ...windows });
  const ge = called(gone, 'hangtag_billing_exception_open')[0];
  check('…a link that can\'t be read (another account\'s): kept against itself once (reconcile_error, never read again), and the run goes on to the next — ok',
    ge && ge.args.p_kind === 'reconcile_error' && ge.args.p_ref === 'plink_Abc1234567' && called(gone, 'hangtag_subscription_activate_checked').length === 1
    && gone.done.ok === true && gone.done.checked_payments.find((p) => p.id === PID).final === true, { ge, done: gone.done });
  // Cashfree: its links read the same way
  const cfRow = { ...row, provider: 'cashfree', provider_order_id: 'ht_' + PID.replace(/-/g, '') };
  const cfFetch = async (url) => {
    const p = new URL(url).pathname.replace(/^\/pg/, '');
    const body = p.endsWith('/orders') ? [{ order_id: 'CF_1', order_status: 'PAID', order_amount: 999, order_currency: 'INR' }]
      : p.startsWith('/orders/CF_1/payments') ? [{ cf_payment_id: '5114910', payment_status: 'SUCCESS' }]
      : { link_id: cfRow.provider_order_id, link_status: 'PAID', link_currency: 'INR', link_notes: { hangtag_payment: PID, hangtag_app: 'hangtag-plan' } };
    return { ok: true, status: 200, json: async () => body };
  };
  const cfDb = fakeDb(begun({ payments: [cfRow] }), { hangtag_subscription_activate_checked: { data: { ok: true }, error: null } });
  const cf = await run(cfDb, windows, { cashfree: { fetch: cfFetch } });
  const ca = called(cf, 'hangtag_subscription_activate_checked')[0];
  check('…a Cashfree payment whose notification was missed: read from Cashfree, activated once with its payment', ca && ca.args.p_provider_payment === '5114910' && ca.args.p_amount === 999, ca);
}

console.log('=== B: AutoPay set-ups ===');
{
  const m = { id: 'm-1', shop_owner_id: 'u1', provider: 'razorpay', subscription_id: 'sub_Fx12345678', current: true, reason: 'check', recorded: ['pay_One1234567'], price: 999, currency: 'INR' };
  const routes = { 'GET /subscriptions/sub_Fx12345678': { id: 'sub_Fx12345678', status: 'active', charge_at: 1800000000, paid_count: 2 },
    'GET /invoices?count=100&skip=0&subscription_id=sub_Fx12345678': { items: [{ id: 'inv_A12345678', status: 'paid', payment_id: 'pay_One1234567' },
      { id: 'inv_B12345678', status: 'paid', payment_id: 'pay_Two1234567' }, { id: 'inv_C12345678', status: 'paid', payment_id: 'pay_Thr1234567' }] },
    'GET /payments/pay_Two1234567': { id: 'pay_Two1234567', status: 'captured', captured: true, amount: 99900, currency: 'INR', created_at: 1799000000 },
    'GET /payments/pay_Thr1234567': { id: 'pay_Thr1234567', status: 'authorized', captured: false, amount: 99900, currency: 'INR' }, ...windows };
  const reps = [];
  const db = fakeDb(begun({ mandates: [m] }), { hangtag_autopay_report: (a) => { reps.push(a); return { data: { known: true, recorded: a.p_event === 'charged' }, error: null }; } });
  const r = await run(db, routes);
  const charged = reps.filter((a) => a.p_event === 'charged');
  check('2 paid_count 2, one recorded → the invoices → pay_Two captured → recorded once (its time, ₹999, INR, the billing mode); the state reported as read',
    charged.length === 1 && charged[0].p_payment === 'pay_Two1234567' && charged[0].p_amount === 999 && charged[0].p_currency === 'INR' && charged[0].p_mode === 'live'
    && charged[0].p_event_at === new Date(1799000000e3).toISOString() && reps.some((a) => a.p_event === 'activated' && a.p_event_at === new Date(NOW).toISOString())
    && r.done.checked_mandates.includes('m-1'), reps);
  check('3 …a paid invoice whose payment is only authorised: not recorded', !reps.some((a) => a.p_payment === 'pay_Thr1234567'));
  const refunded = await run(fakeDb(begun({ mandates: [m] })), { ...routes, 'GET /payments/pay_Two1234567': { id: 'pay_Two1234567', status: 'refunded', captured: true, amount: 99900,
    amount_refunded: 99900, refund_status: 'full', currency: 'INR' } });
  const rx = called(refunded, 'hangtag_billing_exception_open')[0];
  check('4 …a refunded charge no one recorded: kept for review (refund), never recorded as time', rx && rx.args.p_kind === 'refund' && rx.args.p_provider_payment === 'pay_Two1234567'
    && !called(refunded, 'hangtag_autopay_report').some((c) => c.args.p_event === 'charged'), rx);
  const cancelM = { ...m, reason: 'cancel', current: false };
  const cancelled = await run(fakeDb(begun({ mandates: [cancelM] }), { hangtag_autopay_report: { data: { known: true }, error: null } }),
    { 'POST /subscriptions/sub_Fx12345678/cancel': [400, { error: { code: 'BAD_REQUEST_ERROR', description: 'Subscription is not cancellable in cancelled status.' } }],
      'GET /subscriptions/sub_Fx12345678': { id: 'sub_Fx12345678', status: 'cancelled', paid_count: 1 }, ...windows });
  check('6 a cancel owed: retried; Razorpay\'s 400 for one already cancelled is read back as confirmed → reported cancelled; no cancel_failed',
    called(cancelled, 'hangtag_autopay_report').some((c) => c.args.p_event === 'cancelled') && !called(cancelled, 'hangtag_billing_exception_open').some((c) => c.args.p_kind === 'cancel_failed')
    && cancelled.done.repaired >= 1, cancelled.calls.map((c) => c.name));
  const stuck = await run(fakeDb(begun({ mandates: [cancelM] })), { 'POST /subscriptions/sub_Fx12345678/cancel': [400, { error: { code: 'BAD_REQUEST_ERROR', description: 'another operation is in progress' } }],
    'GET /subscriptions/sub_Fx12345678': { id: 'sub_Fx12345678', status: 'active', paid_count: 1 }, ...windows });
  check('…one still active after the attempt → kept for review once (cancel_failed), retried next run', called(stuck, 'hangtag_billing_exception_open').some((c) => c.args.p_kind === 'cancel_failed'
    && c.args.p_ref === 'sub_Fx12345678') && stuck.done.ok === true);
  const overdue = await run(fakeDb(begun({ mandates: [{ ...m, reason: 'charge_overdue', overdue_days: 4.2, next_charge_at: '2026-11-16T00:00:00Z', recorded: ['pay_One1234567'] }] })),
    { 'GET /subscriptions/sub_Fx12345678': { id: 'sub_Fx12345678', status: 'active', paid_count: 1 }, 'GET /invoices?count=100&skip=0&subscription_id=sub_Fx12345678': { items: [] }, ...windows });
  check('…a renewal still unpaid 4 days after it was due, the mandate active: kept for review (charge_overdue)',
    called(overdue, 'hangtag_billing_exception_open').some((c) => c.args.p_kind === 'charge_overdue' && c.args.p_ref === 'sub_Fx12345678:2026-11-16'));
  const down = await run(fakeDb(begun({ mandates: [m, { ...m, id: 'm-2', subscription_id: 'sub_Gy12345678' }] })), { 'GET /subscriptions/sub_Fx12345678': [500, {}], ...windows });
  check('7 Razorpay down mid-run → the run stops: ok false, not complete, its error and the counts so far recorded; nothing after it read',
    down.done.ok === false && down.done.complete === false && down.done.error_code === '500' && !down.api.some((a) => a.includes('sub_Gy12345678')), down.done);
}

console.log('=== C and D: the account, since the last complete run ===');
{
  const longAgo = Math.floor((NOW - 5 * 3600e3) / 1000);
  const routes = {
    'GET /subscriptions?*': { items: [{ id: 'sub_Orph123456', status: 'active', notes: { hangtag_owner: 'u9' }, created_at: longAgo },
      { id: 'sub_Prob123456', status: 'created', notes: { hangtag_probe: 'r1' }, created_at: longAgo },
      { id: 'sub_Else123456', status: 'active', notes: { product: 'other' }, created_at: longAgo }] },
    'POST /subscriptions/sub_Orph123456/cancel': { id: 'sub_Orph123456', status: 'cancelled' },
    'POST /subscriptions/sub_Prob123456/cancel': { id: 'sub_Prob123456', status: 'cancelled' },
    'GET /payments?*': { items: [
      { id: 'pay_Note123456', status: 'captured', captured: true, amount: 99900, currency: 'INR', notes: { hangtag_payment: PID }, created_at: longAgo },
      { id: 'pay_Invc123456', status: 'captured', captured: true, amount: 99900, currency: 'INR', invoice_id: 'inv_X12345678', notes: [], created_at: longAgo },
      { id: 'pay_Fore123456', status: 'captured', captured: true, amount: 5000, currency: 'INR', notes: { order: 'x' }, created_at: longAgo }] },
    'GET /invoices/inv_X12345678': { id: 'inv_X12345678', subscription_id: 'sub_Fx12345678' },
    'GET /refunds?*': { items: [{ id: 'rfnd_Held123456', payment_id: 'pay_Held123456', amount: 99900, currency: 'INR', status: 'processed' }] },
  };
  const reps = [];
  const db = fakeDb(begun(), {
    hangtag_autopay_known: (a) => ({ data: { known: a.p_subs.filter((s) => s === 'sub_Fx12345678'), probes: a.p_subs.filter((s) => s === 'sub_Prob123456') }, error: null }),
    hangtag_billing_known_payments: (a) => ({ data: a.p_ids.filter((i) => i === 'pay_Held123456'), error: null }),
    hangtag_autopay_report: (a) => { reps.push(a); return { data: { known: true, recorded: true }, error: null }; } });
  const r = await run(db, routes);
  const ex = called(r, 'hangtag_billing_exception_open').map((c) => c.args.p_kind + ':' + c.args.p_ref);
  check('5 C: an active subscription with Hangtag\'s note that no shop has → cancelled at Razorpay and kept for review (stale_mandate); the self-check\'s leftover cancelled quietly; another product\'s left alone',
    r.api.includes('POST /subscriptions/sub_Orph123456/cancel') && ex.includes('stale_mandate:sub_Orph123456') && r.api.includes('POST /subscriptions/sub_Prob123456/cancel')
    && !ex.some((e) => e.includes('sub_Prob')) && !r.api.some((a) => a.includes('sub_Else123456/cancel')), { api: r.api, ex });
  check('D: Hangtag\'s captured money nothing holds → a charge of a registered AutoPay recorded (once), a noted payment kept for review (unmatched_payment); another product\'s ignored',
    reps.some((a) => a.p_event === 'charged' && a.p_payment === 'pay_Invc123456' && a.p_subscription === 'sub_Fx12345678') && ex.includes('unmatched_payment:pay_Note123456')
    && !ex.some((e) => e.includes('pay_Fore')), { reps, ex });
  check('…a refund of a payment Hangtag holds → kept for review (refund, its own id); the window read to the run\'s start: complete, both resume points set',
    ex.includes('refund:rfnd_Held123456') && r.done.complete === true && r.done.c_until === new Date(NOW).toISOString() && r.done.d_until === new Date(NOW).toISOString()
    && r.done.provider_totals.razorpay.payments === 2, r.done);
  const capped = await run(fakeDb(begun({ c_since: new Date(NOW - 5 * 86400e3).toISOString(), d_since: new Date(NOW - 5 * 86400e3).toISOString() })),
    { 'GET /subscriptions?*': emptyList, 'GET /payments?*': emptyList, 'GET /refunds?*': emptyList }, { budget: 12 });
  check('the call cap reached: the run ok but not complete, the windows read up to where it stopped (it resumes there)', capped.done.ok === true && capped.done.complete === false
    && Date.parse(capped.done.c_until || 0) < NOW, capped.done);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
