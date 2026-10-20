// Cashfree plan payments end to end on the real database (schema.sql and the post-repair migration): the subscription and
// subscription-webhook handlers as the Edge Functions run them, a Supabase-style client over PGlite (as the shop owner, or
// as the service role), and a fake Cashfree. No network, no keys, no live project.
// What happens to the shop's time and money: a paid link adds the plan's months once (after the trial, nothing lost); the
// same notification again changes nothing (noted); the app's own check and a late notification don't add it twice; an
// amount that isn't due is never activated and is kept for review; a refund is kept for review and takes nothing away;
// money taken after a link expired is still honoured; a plan that has ended starts again from now; one Cashfree payment
// can't pay two Hangtag payments; a link naming another shop's payment activates nothing; the shop's own books stay as
// they were.
// Run: node supabase/tests/subscription-cashfree.test.mjs
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handleWebhook } from '../functions/subscription-webhook/handler.js';
import { handleSubscription } from '../functions/subscription/handler.js';
import { providerFor, providerNamed, webhookProviderFor } from '../functions/subscription/providers/index.js';
import { linkIdFor } from '../functions/subscription/providers/cashfree.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(read('../schema.sql'));
await db.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
const sql = async (q, p) => (await db.query(q, p)).rows;
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
await sql(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.test'), ($2, 'b@shop.test')`, [A, B]);
for (const o of [A, B]) await sql(`UPDATE public.hangtag_profiles SET shop_name = 'S', full_name = 'X', business_type = 'retail', phone = '+91 98765 43210', onboarded_at = NOW() WHERE id = $1`, [o]);
for (const o of [A, B]) await sql(`SELECT public.hangtag_subscription_ensure($1)`, [o]);

/* A Supabase-style client over PGlite: rpc (named arguments, cast to the function's own types) and
   from().select().eq()…maybeSingle(), as `role` with `uid` signed in (row security applies) */
function client(role, uid) {
  const run = async (q, p) => {
    await db.exec(`SET ROLE ${role}`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [uid || '', JSON.stringify({ authorization: 'Bearer x' })]);
    try { return await db.query(q, p); } finally { await db.exec('RESET ROLE'); }
  };
  return {
    auth: { getUser: async () => ({ data: { user: uid ? { id: uid, email: 'a@shop.test' } : null } }) },
    rpc: async (name, args = {}) => {
      try {
        const sig = (await db.query(`SELECT p.proargnames AS n, oidvectortypes(p.proargtypes) AS t FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [name])).rows[0];
        if (!sig) return { data: null, error: { code: 'PGRST202', message: 'no such function' } };
        const names = sig.n || [], types = sig.t ? sig.t.split(', ') : [], keys = Object.keys(args).filter((k) => names.includes(k));
        const q = `SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${types[names.indexOf(k)]}`).join(', ')}) AS r`;
        const r = await run(q, keys.map((k) => (args[k] != null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
        return { data: r.rows[0].r, error: null };
      } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
    },
    from: (t) => {
      const f = []; let cols = '*';
      const q = { select: (c) => { cols = c; return q; }, eq: (k, v) => { f.push([k, v]); return q; }, limit: () => q,
        maybeSingle: async () => {
          try { const r = await run(`SELECT ${cols} FROM public.${t} WHERE ${f.map(([k], i) => `${k} = $${i + 1}`).join(' AND ') || 'TRUE'} LIMIT 2`, f.map(([, v]) => v)); return { data: r.rows[0] || null, error: null }; }
          catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
        } };
      return q;
    },
  };
}

/* A fake Cashfree, as its documentation says it answers */
const links = new Map(), orders = new Map();
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function fakeFetch(url, init = {}) {
  const u = new URL(url), p = u.pathname.replace(/^\/pg/, ''), method = init.method || 'GET';
  let m;
  if (method === 'POST' && p === '/links') {
    const b = JSON.parse(init.body);
    links.set(b.link_id, { link_id: b.link_id, link_status: 'ACTIVE', link_amount: b.link_amount, link_currency: b.link_currency, link_notes: b.link_notes, link_url: 'https://payments-test.cashfree.com/links/' + b.link_id.slice(3, 11) });
    return res(200, links.get(b.link_id));
  }
  if ((m = /^\/links\/([^/]+)$/.exec(p))) return links.has(m[1]) ? res(200, links.get(m[1])) : res(404, {});
  if ((m = /^\/links\/([^/]+)\/orders$/.exec(p))) return res(200, [...orders.values()].filter((o) => o.link_id === m[1] && o.order_status === 'PAID'));
  if ((m = /^\/orders\/([^/]+)\/payments$/.exec(p))) return res(200, (orders.get(m[1]) || {}).payments || []);
  if ((m = /^\/orders\/([^/]+)$/.exec(p))) return orders.has(m[1]) ? res(200, { order_id: m[1], order_tags: { link_id: orders.get(m[1]).link_id } }) : res(404, {});
  return res(404, {});
}
function cashfreePaid(linkId, { amount, cf, currency = 'INR' } = {}) {
  const l = links.get(linkId), oid = 'CF_' + linkId + '_' + orders.size;
  l.link_status = 'PAID';
  orders.set(oid, { order_id: oid, link_id: linkId, order_status: 'PAID', order_amount: amount == null ? l.link_amount : amount, order_currency: currency,
    payments: [{ cf_payment_id: cf || String(5000000 + orders.size), payment_status: 'SUCCESS' }] });
  return oid;
}
const ENV = { SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: 'TEST10app', SUBSCRIPTION_CASHFREE_SECRET_KEY: 'cfsk_ma_test_k', SUBSCRIPTION_TEST_MODE: 'true',
  APP_URL: 'https://app.hangtag.in', SUPABASE_URL: 'https://proj.supabase.co' };
const quiet = { error: () => {}, warn: () => {}, info: () => {} };
const fn = (owner, body) => handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => body },
  { env: ENV, provider: providerFor(ENV, fakeFetch), named: (n) => providerNamed(n, ENV, fakeFetch), userDb: () => client('authenticated', owner), admin: () => client('service_role'), log: quiet });
async function notify(raw, idem) {
  const ts = String(Date.now()), headers = { 'x-webhook-timestamp': ts, 'x-webhook-signature': crypto.createHmac('sha256', ENV.SUBSCRIPTION_CASHFREE_SECRET_KEY).update(ts + raw).digest('base64'), ...(idem ? { 'x-idempotency-key': idem } : {}) };
  return handleWebhook({ method: 'POST', raw, headers }, { provider: webhookProviderFor(ENV, headers, fakeFetch), admin: () => client('service_role'), log: quiet });
}
const success = (linkId, oid) => JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: oid, order_tags: { link_id: linkId } }, payment: { payment_status: 'SUCCESS' } } });
const subOf = async (o) => (await sql(`SELECT trial_ends_at, period_start, period_end, plan_code, public.hangtag_subscription_state(owner_id, NOW()) AS state FROM public.hangtag_subscriptions WHERE owner_id = $1`, [o]))[0];
const payOf = async (id) => (await sql(`SELECT status, provider, provider_order_id, provider_payment_id, captured_at, amount FROM public.hangtag_subscription_payments WHERE id = $1`, [id]))[0];
const exceptions = async (kind) => sql(`SELECT kind, ref, shop_owner_id AS owner_id, payment_id, amount FROM public.hangtag_billing_exceptions WHERE kind = $1`, [kind]);
const books = async () => JSON.stringify(await sql(`SELECT (SELECT count(*) FROM public.hangtag_sales)::int s, (SELECT count(*) FROM public.hangtag_payments)::int p, (SELECT count(*) FROM public.hangtag_cash_moves)::int c`));
const BOOKS0 = await books();
// a calendar month later, as the database counts it (31 Oct + 1 month = 30 Nov; JavaScript's Date would say 1 Dec)
const MONTH = async (from) => +(await sql(`SELECT ($1::timestamptz + interval '1 month') AS t`, [new Date(from).toISOString()]))[0].t;

check('the expected month, as the database counts it: 31 Oct + 1 month = 30 Nov (not 1 Dec)', new Date(await MONTH(Date.UTC(2026, 9, 31, 12))).toISOString().startsWith('2026-11-30'));

console.log('=== the test project\'s billing mode ===');
const live = await fn(A, { action: 'checkout', plan: 'm1' });
const liveWebhook = await notify(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: 'ht_' + 'ab'.repeat(16), link_status: 'PAID', link_notes: { hangtag_payment: A } } }), 'evt-mode');
check('sandbox keys on a database still counting live money (as every database starts): no checkout (503, nothing made), and a sandbox notification is never acted on but kept for review',
  live.status === 503 && links.size === 0 && (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments`))[0].n === 0
  && liveWebhook.status === 200 && liveWebhook.body.mode_mismatch === true && (await exceptions('mode_mismatch')).length === 1, { live, liveWebhook });
// a test project, as RELEASE.md §6d sets it up: the billing mode changed in the SQL Editor
await sql(`UPDATE public.hangtag_billing_settings SET billing_mode = 'test'`);

console.log('=== a payment through Cashfree ===');
const t0 = await subOf(A);
const c1 = await fn(A, { action: 'checkout', plan: 'm1' });
const P1 = c1.body.payment_id, L1 = linkIdFor(P1);
check('checkout as the owner: the database prices it, a Cashfree link is made and recorded against the payment', c1.status === 200 && c1.body.provider === 'cashfree' && links.has(L1)
  && (await payOf(P1)).provider_order_id === L1 && (await payOf(P1)).status === 'created', c1);
const o1 = cashfreePaid(L1, { cf: '7000001' });
const w1 = await notify(success(L1, o1), 'evt-1');
const p1 = await payOf(P1), s1 = await subOf(A);
check('the signed notification: paid, with Cashfree\'s payment id, the money counted as received', w1.status === 200 && w1.body.status === 'paid' && p1.status === 'paid'
  && p1.provider_payment_id === '7000001' && !!p1.captured_at, { w1, p1 });
check('…the plan runs from the end of the trial (no trial day lost) for one month; the shop\'s state: paid', s1.plan_code === 'm1' && Math.abs(+s1.period_start - +t0.trial_ends_at) < 2000
  && Math.abs(+s1.period_end - (await MONTH(+t0.trial_ends_at))) < 2000 && s1.state === 'paid_active', { t0, s1 });
const w1b = await notify(success(L1, o1), 'evt-1');
check('the same notification again: known, nothing changes (one note, the same period)', w1b.status === 200 && w1b.body.duplicate === true
  && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_events`))[0].n === 1 && +(await subOf(A)).period_end === +s1.period_end, w1b);
const w1c = await notify(success(L1, o1));
check('…sent once more without its key (a digest of the same body): still nothing twice', w1c.status === 200 && +(await subOf(A)).period_end === +s1.period_end, w1c);

console.log('=== the app\'s own check first, then a late notification ===');
const c2 = await fn(A, { action: 'checkout', plan: 'm1' }), P2 = c2.body.payment_id, L2 = linkIdFor(P2);
const o2 = cashfreePaid(L2);
const v2 = await fn(A, { action: 'verify', payment_id: P2 });
const s2 = await subOf(A);
check('the owner back from the payment page: verified with Cashfree, a second month after the first (time adds up)', v2.status === 200 && v2.body.status === 'paid'
  && Math.abs(+s2.period_end - (await MONTH(+s1.period_end))) < 2000, { v2, s2 });
const w2 = await notify(success(L2, o2), 'evt-2');
check('…the notification arriving later: nothing added again', w2.status === 200 && w2.body.status === 'paid' && +(await subOf(A)).period_end === +s2.period_end, w2);

console.log('=== money that isn\'t right ===');
const c3 = await fn(A, { action: 'checkout', plan: 'm1' }), P3 = c3.body.payment_id, L3 = linkIdFor(P3);
const o3 = cashfreePaid(L3, { amount: 1 });
const w3 = await notify(success(L3, o3), 'evt-3');
check('an amount that isn\'t the amount due: never activated; kept for review with the shop and the payment; no time added', w3.status === 200 && (await payOf(P3)).status === 'created'
  && (await exceptions('amount_mismatch')).some((x) => x.payment_id === P3 && x.owner_id === A && +x.amount === 1) && +(await subOf(A)).period_end === +s2.period_end, w3);
const w4 = await notify(JSON.stringify({ type: 'REFUND_STATUS_WEBHOOK', data: { refund: { order_id: o1, cf_payment_id: '7000001', cf_refund_id: 'rf_1', refund_amount: +p1.amount, refund_currency: 'INR', refund_status: 'SUCCESS' } } }), 'evt-4');
check('a refund of the first payment: kept for review against it; the shop\'s time untouched', w4.status === 200 && w4.body.refund === 'noted'
  && (await exceptions('refund')).some((x) => x.payment_id === P1 && x.owner_id === A) && +(await subOf(A)).period_end === +s2.period_end, w4);
const c5 = await fn(A, { action: 'checkout', plan: 'm1' }), P5 = c5.body.payment_id, L5 = linkIdFor(P5);
const o5 = cashfreePaid(L5, { cf: (await payOf(P2)).provider_payment_id });
const w5 = await notify(success(L5, o5), 'evt-5');
check('the same Cashfree payment (the second one\'s) presented for another Hangtag payment: refused for good (200, not retried), kept for review, nothing added',
  w5.status === 200 && w5.body.status === 'refused' && (await payOf(P5)).status !== 'paid' && (await exceptions('activation_refused')).length === 1 && +(await subOf(A)).period_end === +s2.period_end, w5);
const c5r = await fn(A, { action: 'checkout', plan: 'm1' }), P5r = c5r.body.payment_id, L5r = linkIdFor(P5r);
const w5r = await notify(success(L5r, cashfreePaid(L5r, { cf: '7000001' })), 'evt-5r');
check('…the refunded first payment presented again: refused as refunded (its refund is open for review), nothing added',
  w5r.status === 200 && w5r.body.status === 'refunded' && (await payOf(P5r)).status !== 'paid' && +(await subOf(A)).period_end === +s2.period_end, w5r);
const cb = await fn(B, { action: 'checkout', plan: 'm1' }), PB = cb.body.payment_id, LB = linkIdFor(PB);
cashfreePaid(LB);
const wb = await notify(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: LB, link_status: 'PAID', link_notes: { hangtag_payment: P3 } } }), 'evt-6');
check('shop B\'s link with a note naming shop A\'s payment: nothing activated for either, kept for review', wb.status === 200 && (await payOf(PB)).status === 'created' && (await payOf(P3)).status === 'created'
  && (await exceptions('wrong_shop')).length === 1, wb);
// links of Hangtag's form no Hangtag payment recorded: one with Hangtag's notes (made by hand on the account, naming shop A's
// open payment), one without (someone else's) — both paid
const LU = 'ht_' + 'cd'.repeat(16), LX = 'ht_' + 'ef'.repeat(16), subA = await subOf(A), subB = await subOf(B);
links.set(LU, { link_id: LU, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR', link_notes: { hangtag_payment: P3, hangtag_app: 'hangtag-plan' } });
links.set(LX, { link_id: LX, link_status: 'ACTIVE', link_amount: 999, link_currency: 'INR', link_notes: { florix_order: 'shop-77' } });
const ou = cashfreePaid(LU), ox = cashfreePaid(LX);
const wu = await notify(success(LU, ou), 'evt-u1'), wu2 = await notify(success(LU, ou), 'evt-u2'), wx = await notify(success(LX, ox), 'evt-x1');
const unk = await exceptions('unknown_order');
check('money on a Hangtag link no payment recorded: kept for review once (unknown_order, its amount, no shop assumed), sent twice; nothing activated, no shop\'s time changed; one without Hangtag\'s notes: ignored',
  wu.status === 200 && wu.body.status === 'unmatched' && wu2.status === 200 && wx.status === 200 && wx.body.ignored === true
  && unk.length === 1 && unk[0].ref === LU && +unk[0].amount === 999 && unk[0].owner_id === null && unk[0].payment_id === null
  && (await payOf(P3)).status === 'created' && +(await subOf(A)).period_end === +subA.period_end && JSON.stringify(await subOf(B)) === JSON.stringify(subB), { wu, wx, unk });
// money in another currency, the same number: the app's own check and the notification alike refuse it
const cc = await fn(A, { action: 'checkout', plan: 'm1' }), PC = cc.body.payment_id, LC = linkIdFor(PC);
cashfreePaid(LC, { currency: 'USD' });
const vc = await fn(A, { action: 'verify', payment_id: PC });
const wc = await notify(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: LC, link_status: 'PAID', link_notes: { hangtag_payment: PC } } }), 'evt-c1');
check('a payment in another currency (the same number): the app\'s check refuses it (409), the notification keeps it for review; never activated, no time added',
  vc.status === 409 && wc.status === 200 && (await payOf(PC)).status === 'created' && +(await subOf(A)).period_end === +subA.period_end
  && (await exceptions('currency_mismatch')).some((x) => x.payment_id === PC), { vc, wc });

console.log('=== expiry and renewal ===');
const c6 = await fn(A, { action: 'checkout', plan: 'm1' }), P6 = c6.body.payment_id, L6 = linkIdFor(P6);
links.get(L6).link_status = 'EXPIRED';
const w6 = await notify(JSON.stringify({ type: 'PAYMENT_LINK_EVENT', data: { link_id: L6, link_status: 'EXPIRED', link_notes: { hangtag_payment: P6 } } }), 'evt-7');
check('a link that expired unpaid: the payment marked expired', w6.status === 200 && (await payOf(P6)).status === 'expired', w6);
const o6 = cashfreePaid(L6);
const w6b = await notify(success(L6, o6), 'evt-8');
const s6 = await subOf(A);
check('…money Cashfree took on it anyway: still honoured, one more month', w6b.status === 200 && (await payOf(P6)).status === 'paid' && Math.abs(+s6.period_end - (await MONTH(+s2.period_end))) < 2000, { w6b, s6 });
await sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '120 days', trial_ends_at = NOW() - interval '90 days', period_start = NOW() - interval '60 days',
  period_end = NOW() - interval '1 day' WHERE owner_id = $1`, [A]);
check('a plan that ended yesterday: the shop\'s state says so', (await subOf(A)).state === 'paid_expired');
const c7 = await fn(A, { action: 'checkout', plan: 'm1' }), P7 = c7.body.payment_id, L7 = linkIdFor(P7);
const before7 = Date.now(), o7 = cashfreePaid(L7);
await notify(success(L7, o7), 'evt-9');
const s7 = await subOf(A);
check('…paid again: the month starts now (the ended days aren\'t charged), and the shop is open again', s7.state === 'paid_active' && +s7.period_start >= before7 - 2000
  && Math.abs(+s7.period_end - (await MONTH(+s7.period_start))) < 2000, s7);
check('none of it touched the shop\'s own books (bills, payments, cash)', await books() === BOOKS0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
