// AutoPay with Cashfree end to end on the real database: schema.sql, the post-repair migration and
// 20261027120000_hangtag_cashfree_readiness.sql, with the subscription and subscription-webhook handlers and the
// reconciler's read of a mandate as the Edge Functions run them, a Supabase-style client over PGlite (as a shop owner, or
// as the service role) and a fake Cashfree that answers as its sandbox did on 2026-10-27. No network, no keys.
// The free month and the mandate approved (the ₹1 authorisation never a payment); the renewal asked for 4 days ahead and
// taken once — confirmed from Cashfree's API, a replayed notification never counted twice; a renewal that fails (shown
// past due, never shown as fine again by a read or a notification, never asked for twice); a pause and resume in the UPI
// app (the next charge back); turning AutoPay off (nothing asked for after it, a replay never turns it back on); and
// another shop that can neither see nor change any of it.
// Run: node supabase/tests/cashfree-autopay.test.mjs
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { handleWebhook } from '../functions/subscription-webhook/handler.js';
import { handleSubscription } from '../functions/subscription/handler.js';
import { checkMandate } from '../functions/subscription/reconcile.js';
import { autopayProviderFor, providerFor, providerNamed, webhookProviderFor } from '../functions/subscription/providers/index.js';
import { chargeIdFor } from '../functions/subscription/providers/cashfree.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(read('../schema.sql'));
await db.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
await db.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql'));
const sql = async (q, p) => (await db.query(q, p)).rows;
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
await sql(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.test'), ($2, 'b@shop.test')`, [A, B]);
for (const o of [A, B]) await sql(`UPDATE public.hangtag_profiles SET shop_name = 'S', full_name = 'X', business_type = 'retail', phone = '+91 98765 43210', onboarded_at = NOW() WHERE id = $1`, [o]);
for (const o of [A, B]) await sql(`SELECT public.hangtag_subscription_ensure($1)`, [o]);

/* A Supabase-style client over PGlite, as `role` with `uid` signed in (row security applies) */
function client(role, uid) {
  const run = async (q, p) => {
    await db.exec(`SET ROLE ${role}`);
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [uid || '', JSON.stringify({ authorization: 'Bearer x' })]);
    try { return await db.query(q, p); } finally { await db.exec('RESET ROLE'); }
  };
  return {
    auth: { getUser: async () => ({ data: { user: uid ? { id: uid, email: uid === A ? 'a@shop.test' : 'b@shop.test' } : null } }) },
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
    raw: run,
  };
}

/* A fake Cashfree Subscriptions API: mandates, their payments (the ₹1 AUTH and each CHARGE); a payment_id taken once */
const subs = new Map(), pays = new Map(), calls = [];
let down = false;   // Cashfree unable to take a cancel (5xx) while set
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
async function fakeFetch(url, init = {}) {
  const p = new URL(url).pathname.replace(/^\/pg/, ''), method = init.method || 'GET', b = init.body ? JSON.parse(init.body) : null;
  calls.push({ method, p, b });
  if (down && method === 'POST' && /\/manage$/.test(p)) return res(500, { code: 'unavailable' });
  let m;
  if (method === 'POST' && p === '/subscriptions') {
    subs.set(b.subscription_id, { subscription_id: b.subscription_id, subscription_status: 'INITIALIZED', subscription_session_id: 'session_' + b.subscription_id.slice(5, 25), plan_details: b.plan_details, subscription_tags: b.subscription_tags });
    pays.set(b.subscription_id, []);
    return res(200, subs.get(b.subscription_id));
  }
  if (method === 'POST' && p === '/subscriptions/pay') {
    const list = pays.get(b.subscription_id);
    if (!list || subs.get(b.subscription_id).subscription_status !== 'ACTIVE') return res(400, { code: 'subscription_not_active' });
    if (list.some((c) => c.payment_id === b.payment_id)) return res(400, { code: 'payment_id_already_exists' });
    const c = { payment_id: b.payment_id, cf_payment_id: String(7000 + list.length), payment_type: 'CHARGE', payment_amount: b.payment_amount, payment_status: 'INITIALIZED', payment_schedule_date: b.payment_schedule_date,
      payment_initiated_date: new Date(clock).toISOString() };   // as Cashfree stamps it: when it was asked for (days before it is taken)
    list.push(c);
    return res(200, c);
  }
  if ((m = /^\/subscriptions\/([^/]+)\/payments\/([^/]+)\/manage$/.exec(p))) { const c = (pays.get(m[1]) || []).find((x) => x.payment_id === m[2]); if (!c) return res(404, {}); c.payment_status = 'CANCELLED'; return res(200, c); }
  if ((m = /^\/subscriptions\/([^/]+)\/payments$/.exec(p))) return subs.has(m[1]) ? res(200, pays.get(m[1])) : res(404, {});
  if ((m = /^\/subscriptions\/([^/]+)\/manage$/.exec(p))) {
    const s = subs.get(m[1]);
    if (!s) return res(404, {});
    if (s.subscription_status === 'CANCELLED') return res(400, { code: 'subscription_already_cancelled' });
    s.subscription_status = 'CANCELLED';
    return res(200, s);
  }
  if ((m = /^\/subscriptions\/([^/]+)$/.exec(p))) return subs.has(m[1]) ? res(200, subs.get(m[1])) : res(404, {});
  return res(404, {});
}
const ENV = { SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_AUTOPAY_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: 'TEST10app', SUBSCRIPTION_CASHFREE_SECRET_KEY: 'cfsk_ma_test_k',
  SUBSCRIPTION_TEST_MODE: 'true', APP_URL: 'https://app.hangtag.in', SUPABASE_URL: 'https://proj.supabase.co' };
const quiet = { error: () => {}, warn: () => {}, info: () => {} };
const fn = (owner, body) => handleSubscription({ method: 'POST', auth: 'Bearer t', device: null, json: async () => body },
  { env: ENV, provider: providerFor(ENV, fakeFetch), autopay: autopayProviderFor(ENV, fakeFetch), named: (n) => providerNamed(n, ENV, fakeFetch), planId: '',
    userDb: () => client('authenticated', owner), admin: () => client('service_role'), log: quiet });
// one clock for the notifications' own times and the reconciler's reads, in the past and moving forward (as they arrive)
let clock = Date.now() - 3 * 3600e3;
const tick = () => (clock += 60e3);
let idem = 0;
async function notify(type, data, key = 'evt-' + (++idem)) {
  const raw = JSON.stringify({ type, event_time: new Date(tick()).toISOString(), data }), ts = String(Date.now());
  const headers = { 'x-webhook-timestamp': ts, 'x-webhook-signature': crypto.createHmac('sha256', ENV.SUBSCRIPTION_CASHFREE_SECRET_KEY).update(ts + raw).digest('base64'), 'x-idempotency-key': key };
  return handleWebhook({ method: 'POST', raw, headers }, { provider: webhookProviderFor(ENV, headers, fakeFetch), admin: () => client('service_role'), log: quiet, now: () => tick() });
}
/* The reconciler's read of A's mandate (sweep B), its row as hangtag_billing_reconcile_begin lists it */
async function readMandate(sub, reason = 'check') {
  const [m] = await sql(`SELECT m.id, m.shop_owner_id, m.provider, m.subscription_id, m.is_current AS current, m.provider_status, s.autopay_next_charge_at AS next_charge_at,
      $2::text AS reason, m.price, m.currency, COALESCE((SELECT jsonb_agg(y.provider_payment_id) FROM public.hangtag_subscription_payments y
        WHERE y.kind = 'autopay' AND y.provider = m.provider AND y.provider_order_id = m.subscription_id), '[]'::jsonb) AS recorded
     FROM public.hangtag_autopay_mandates m LEFT JOIN public.hangtag_subscriptions s ON s.owner_id = m.shop_owner_id AND s.autopay_subscription_id = m.subscription_id AND m.is_current
    WHERE m.subscription_id = $1`, [sub, reason]);
  const ctx = { sr: client('service_role'), mode: 'test', autopay: autopayProviderFor(ENV, fakeFetch), named: () => null, now: () => tick(), log: quiet,
    run: { checked: 0, repaired: 0, exceptions_opened: 0 }, spend: () => {} };
  await checkMandate(ctx, { ...m, next_charge_at: m.next_charge_at && new Date(m.next_charge_at).toISOString() });
  return ctx.run;
}
const shop = async (o) => (await sql(`SELECT autopay_status, autopay_next_charge_at, trial_ends_at, period_end, autopay_failed_at FROM public.hangtag_subscriptions WHERE owner_id = $1`, [o]))[0];
const paysOf = async (o) => sql(`SELECT amount, currency, kind, status, provider_payment_id, period_end FROM public.hangtag_subscription_payments WHERE owner_id = $1 ORDER BY created_at`, [o]);
const asked = () => calls.filter((c) => c.method === 'POST' && c.p === '/subscriptions/pay');
const same = (a, b) => a != null && b != null && Math.abs(+new Date(a) - +new Date(b)) < 1000;

console.log('=== a test project, AutoPay offered (its notifications proven) ===');
await sql(`UPDATE public.hangtag_billing_settings SET billing_mode = 'test'`);
await sql(`UPDATE public.hangtag_platform_config SET autopay_enabled = TRUE WHERE id`);
const LP = 'ht_' + 'a'.repeat(32), SP = 'htap_' + 'b'.repeat(32);
await sql(`SELECT public.hangtag_billing_probe_record('cashfree', 'payment_link', $1, 'test'), public.hangtag_billing_probe_record('cashfree', 'subscription', $2, 'test')`, [LP, SP]);
await sql(`SELECT public.hangtag_billing_event_record('cashfree', 'p1', 'PAYMENT_LINK_EVENT', $1, 'test', $1, NOW() - interval '2 minutes')`, [LP]);
await sql(`SELECT public.hangtag_billing_event_record('cashfree', 'p2', 'SUBSCRIPTION_STATUS_CHANGED', $1, 'test', $1, NOW() - interval '1 minute')`, [SP]);
const run0 = (await sql(`SELECT public.hangtag_billing_reconcile_begin(10, 'test') AS r`))[0].r;
await sql(`SELECT public.hangtag_billing_reconcile_done($1, '{"ok": true, "complete": true}')`, [run0.run_id]);
const ready = (await sql(`SELECT public.hangtag_billing_readiness() AS r`))[0].r;
const cfgRow = (await sql(`SELECT c.autopay_consent_version AS v, p.price FROM public.hangtag_platform_config c JOIN public.hangtag_plans p ON p.code = COALESCE(c.autopay_plan_code, 'm1') WHERE c.id`))[0];
const PRICE = +cfgRow.price;
check('readiness with Cashfree\'s own notifications about its probes and a complete run: ready, so AutoPay can be offered', ready.ready === true, ready);

console.log('=== the free month: the mandate made, approved, nothing charged ===');
const t0 = await shop(A);
const start = await fn(A, { action: 'autopay_start', consent: true, consent_version: cfgRow.v });
const [reg] = await sql(`SELECT subscription_id, price, currency, is_current FROM public.hangtag_autopay_mandates WHERE shop_owner_id = $1`, [A]);
const SUB = reg && reg.subscription_id;
check('AutoPay set up in the trial: the consent recorded, an on-demand mandate for up to the AutoPay price made at Cashfree and registered as the shop\'s current set-up; nothing to pay today; the first charge at the trial\'s end',
  start.status === 200 && start.body.today === 0 && same(start.body.first_charge_at, t0.trial_ends_at) && reg && /^htap_/.test(SUB) && +reg.price === PRICE && reg.is_current === true
  && subs.get(SUB).plan_details.plan_type === 'ON_DEMAND' && subs.get(SUB).plan_details.plan_max_amount === PRICE && (await shop(A)).autopay_status === 'pending', { start: start.body, reg });
subs.get(SUB).subscription_status = 'ACTIVE';
pays.get(SUB).push({ payment_id: 'auth_1', cf_payment_id: '6999', payment_type: 'AUTH', payment_amount: 1, payment_status: 'SUCCESS' });
const n1 = await notify('SUBSCRIPTION_AUTH_STATUS', { subscription_id: SUB, authorization_details: { authorization_status: 'ACTIVE' } });
const n2 = await notify('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: '6999', payment_id: 'auth_1', payment_type: 'AUTH', payment_amount: 1, payment_status: 'SUCCESS' });
const n3 = await notify('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: '6999', payment_id: 'auth_1', payment_type: 'DEBIT_CARD', payment_amount: 1, payment_status: 'SUCCESS' });
const n4 = await notify('SUBSCRIPTION_REFUND_STATUS', { subscription_id: SUB, cf_payment_id: '6999', refund_amount: 1, refund_status: 'SUCCESS' });
const t1 = await shop(A);
check('approved at the bank: AutoPay on, the trial untouched, the first charge still at its end; the ₹1 authorisation (as AUTH, or under another payment_type) and its refund: no payment, nothing to review',
  [n1, n2, n3, n4].every((n) => n.status === 200) && t1.autopay_status === 'active' && same(t1.trial_ends_at, t0.trial_ends_at) && same(t1.autopay_next_charge_at, t0.trial_ends_at)
  && (await paysOf(A)).length === 0 && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_exceptions`))[0].n === 0, { t1, n2: n2.body, n3: n3.body });

console.log('=== the renewal: asked for 4 days ahead, taken once ===');
const r0 = await readMandate(SUB);
check('weeks before the trial ends: the daily read asks for nothing', asked().length === 0 && r0.checked === 1);
await sql(`UPDATE public.hangtag_subscriptions SET trial_ends_at = NOW() + interval '3 days', autopay_next_charge_at = NOW() + interval '3 days' WHERE owner_id = $1`, [A]);
const due = await shop(A);
await readMandate(SUB);
await readMandate(SUB);
const ref = chargeIdFor(SUB, +new Date(due.autopay_next_charge_at));
check('3 days before it: one charge asked for, for the price agreed, named after its date, never twice', asked().length === 1 && asked()[0].b.payment_amount === PRICE
  && asked()[0].b.payment_id === ref && asked()[0].b.payment_type === 'CHARGE', asked().map((c) => c.b));
const ch = pays.get(SUB).find((c) => c.payment_id === ref);
const early = await notify('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: ch.cf_payment_id, payment_id: ref, payment_type: 'CHARGE', payment_amount: PRICE, payment_status: 'SUCCESS' });
check('a notification that it was taken while Cashfree\'s API still shows it pending: 503 (sent again), nothing recorded', early.status === 503 && (await paysOf(A)).length === 0, early);
ch.payment_status = 'SUCCESS';
const paid = await notify('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: ch.cf_payment_id, payment_id: ref, payment_type: 'CHARGE', payment_amount: PRICE, payment_status: 'SUCCESS' });
const replay = await notify('SUBSCRIPTION_PAYMENT_SUCCESS', { subscription_id: SUB, cf_payment_id: ch.cf_payment_id, payment_id: ref, payment_type: 'CHARGE', payment_amount: PRICE, payment_status: 'SUCCESS' }, 'another-key');
await readMandate(SUB);
const t2 = await shop(A), p2 = await paysOf(A);
const monthOn = (await sql(`SELECT $1::timestamptz + interval '1 month' AS t`, [due.trial_ends_at]))[0].t;
check('taken (the API shows it SUCCESS): one AutoPay payment of the price, the plan\'s month added after the trial (nothing lost), the next charge at the new end; the same notification replayed under another key and the reconciler\'s read: nothing twice',
  paid.status === 200 && replay.status === 200 && p2.length === 1 && +p2[0].amount === PRICE && p2[0].kind === 'autopay' && p2[0].status === 'paid' && p2[0].provider_payment_id === ch.cf_payment_id
  && same(t2.period_end, monthOn) && same(t2.autopay_next_charge_at, monthOn) && t2.autopay_status === 'active', { t2, p2 });

console.log('=== a renewal that fails ===');
await sql(`UPDATE public.hangtag_subscriptions SET autopay_next_charge_at = NOW() + interval '2 days 12 hours' WHERE owner_id = $1`, [A]);
await readMandate(SUB);
const due2 = await shop(A), ref2 = chargeIdFor(SUB, +new Date(due2.autopay_next_charge_at)), ch2 = pays.get(SUB).find((c) => c.payment_id === ref2);
ch2.payment_status = 'FAILED';
const failed = await notify('SUBSCRIPTION_PAYMENT_FAILED', { subscription_id: SUB, cf_payment_id: ch2.cf_payment_id, payment_id: ref2, payment_type: 'CHARGE', payment_status: 'FAILED' });
const t3 = await shop(A);
await readMandate(SUB, 'charge_overdue');
const active = await notify('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: SUB, subscription_status: 'ACTIVE' } });
const t4 = await shop(A);
check('the charge failed (the API shows FAILED): AutoPay past due; the daily read of the mandate (still ACTIVE at Cashfree) and a notification that it is ACTIVE leave it past due; that date never asked for again; no payment',
  failed.status === 200 && t3.autopay_status === 'past_due' && !!t3.autopay_failed_at && active.status === 200 && t4.autopay_status === 'past_due'
  && asked().filter((c) => c.b.payment_id === ref2).length === 1 && (await paysOf(A)).length === 1, { t3, t4 });
await sql(`UPDATE public.hangtag_subscriptions SET autopay_status = 'active', autopay_failed_at = NULL WHERE owner_id = $1`, [A]);
await sql(`UPDATE public.hangtag_autopay_mandates SET provider_status = 'authenticated' WHERE subscription_id = $1`, [SUB]);
await readMandate(SUB, 'charge_overdue');
check('…its notification missed: the daily read finds the failed charge for the date due and shows AutoPay past due', (await shop(A)).autopay_status === 'past_due');

console.log('=== paused and resumed in the UPI app ===');
await notify('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: SUB, subscription_status: 'CUSTOMER_PAUSED' } });
const t5 = await shop(A);
await notify('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: SUB, subscription_status: 'ACTIVE' } });
const t6 = await shop(A);
const r6 = await readMandate(SUB);
check('paused: AutoPay halted, no next charge; resumed: on again with the next charge back at the end of the time paid for (none was ever asked for again before this fix)',
  t5.autopay_status === 'halted' && t5.autopay_next_charge_at === null && t6.autopay_status === 'active' && same(t6.autopay_next_charge_at, t6.period_end) && r6.checked === 1, { t5, t6 });

console.log('=== a renewal whose notification never came: the reconciler records it, and the next charge moves on ===');
await sql(`UPDATE public.hangtag_subscriptions SET autopay_next_charge_at = NOW() + interval '3 days 12 hours' WHERE owner_id = $1`, [A]);
await readMandate(SUB);
const due3 = await shop(A), ref3 = chargeIdFor(SUB, +new Date(due3.autopay_next_charge_at)), ch3 = pays.get(SUB).find((c) => c.payment_id === ref3);
if (ch3) ch3.payment_status = 'SUCCESS';   // taken at Cashfree; its notification never arrives
const paysBefore3 = (await paysOf(A)).length;
await readMandate(SUB, 'charge_overdue');
const t9 = await shop(A), monthOn3 = (await sql(`SELECT $1::timestamptz + interval '1 month' AS t`, [due3.period_end]))[0].t;
check('a renewal Cashfree took whose notification never came: the reconciler\'s read records it once, a month added after the time already paid for, and the NEXT CHARGE MOVED to the new end (before, recorded as "older" than the read, it stayed on the paid date and no renewal was ever asked for again); AutoPay active',
  !!ch3 && (await paysOf(A)).length === paysBefore3 + 1 && same(t9.period_end, monthOn3) && same(t9.autopay_next_charge_at, t9.period_end) && t9.autopay_status === 'active',
  { t9: { next: t9.autopay_next_charge_at, end: t9.period_end, status: t9.autopay_status }, due3: due3.autopay_next_charge_at });

console.log('=== a renewal that failed, then was taken on Cashfree\'s own retry with no notification ===');
await sql(`UPDATE public.hangtag_subscriptions SET autopay_next_charge_at = NOW() + interval '1 day 12 hours' WHERE owner_id = $1`, [A]);
await readMandate(SUB);
const due4 = await shop(A), ref4 = chargeIdFor(SUB, +new Date(due4.autopay_next_charge_at)), ch4 = pays.get(SUB).find((c) => c.payment_id === ref4);
if (ch4) ch4.payment_status = 'FAILED';
await notify('SUBSCRIPTION_PAYMENT_FAILED', { subscription_id: SUB, cf_payment_id: ch4 && ch4.cf_payment_id, payment_id: ref4, payment_type: 'CHARGE', payment_status: 'FAILED' });
const t10 = await shop(A);
pays.get(SUB).push({ payment_id: ref4, cf_payment_id: '7999', payment_type: 'CHARGE', payment_amount: PRICE, payment_status: 'SUCCESS',
  payment_initiated_date: new Date(tick()).toISOString() });   // Cashfree's retry, taken
await readMandate(SUB, 'charge_overdue');
const t11 = await shop(A);
check('…failed (past due), then taken on Cashfree\'s own retry under the same payment_id with no notification: the reconciler\'s read records the attempt taken and AutoPay is active again — the failure cleared, the next charge at the new end (before, past due stayed for good)',
  !!ch4 && t10.autopay_status === 'past_due' && t11.autopay_status === 'active' && t11.autopay_failed_at === null && same(t11.autopay_next_charge_at, t11.period_end),
  { t10: t10.autopay_status, t11: { status: t11.autopay_status, failed: t11.autopay_failed_at, next: t11.autopay_next_charge_at, end: t11.period_end } });

console.log('=== turned off while Cashfree can\'t confirm it, then when it can: nothing more is charged ===');
await sql(`UPDATE public.hangtag_subscriptions SET autopay_next_charge_at = NOW() + interval '12 hours' WHERE owner_id = $1`, [A]);
await readMandate(SUB);
const due5 = await shop(A), raised5 = pays.get(SUB).find((c) => c.payment_id === chargeIdFor(SUB, +new Date(due5.autopay_next_charge_at)));
down = true;
const offDown = await fn(A, { action: 'autopay_cancel' });
const [owedRow] = await sql(`SELECT cancel_requested_at IS NOT NULL AS owed FROM public.hangtag_autopay_mandates WHERE subscription_id = $1`, [SUB]);
const tDown = await shop(A);
const askedBefore = asked().length;
const whileDown = await readMandate(SUB, 'cancel').then(() => 'read', (e) => 'stopped:' + ((e && e.status) || (e && e.message)));
down = false;
await readMandate(SUB, 'cancel');
const t7 = await shop(A);
const replayOn = await notify('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: SUB, subscription_status: 'ACTIVE' } }, 'replayed-on');
const replayAuth = await notify('SUBSCRIPTION_AUTH_STATUS', { subscription_id: SUB, authorization_details: { authorization_status: 'ACTIVE' } }, 'replayed-auth');
await readMandate(SUB);
const t8 = await shop(A);
check('turned off while Cashfree can\'t take it: 502, the cancel kept owed, the shop not shown cancelled before Cashfree confirms, and the reconciler asks for no charge meanwhile; once Cashfree answers, the reconciler cancels the mandate, WITHDRAWS the charge already raised for the next date, and records AutoPay cancelled (no next charge)',
  offDown.status === 502 && owedRow.owed === true && tDown.autopay_status === 'active' && /^stopped/.test(whileDown) && !!raised5 && raised5.payment_status === 'CANCELLED'
  && subs.get(SUB).subscription_status === 'CANCELLED' && t7.autopay_status === 'cancelled' && t7.autopay_next_charge_at === null,
  { offDown: offDown.status, owed: owedRow, tDown: tDown.autopay_status, whileDown, raised: raised5 && raised5.payment_status, t7: t7.autopay_status });
check('…then notifications that it is ACTIVE, replayed under new keys and newer times, never turn it back on; the read asks for nothing more; the time paid for is kept',
  replayOn.status === 200 && replayAuth.status === 200 && t8.autopay_status === 'cancelled' && t8.autopay_next_charge_at === null && asked().length === askedBefore
  && same(t8.period_end, t11.period_end), { t8: { status: t8.autopay_status, next: t8.autopay_next_charge_at }, asked: asked().length - askedBefore });
// the charge Hangtag withdrew when AutoPay was turned off: Cashfree tells of it as cancelled (and a late "failed" for it) —
// withdrawn with the mandate, nothing to report; and the registry itself, told "pending" later still, keeps the ended mandate ended
const wdNote = await notify('SUBSCRIPTION_PAYMENT_CANCELLED', { subscription_id: SUB, cf_payment_id: raised5.cf_payment_id, payment_id: raised5.payment_id, payment_type: 'CHARGE', payment_status: 'CANCELLED' });
const wdLate = await notify('SUBSCRIPTION_PAYMENT_FAILED', { subscription_id: SUB, cf_payment_id: raised5.cf_payment_id, payment_id: raised5.payment_id, payment_type: 'CHARGE', payment_status: 'FAILED' });
const wdShop = await shop(A);
const lateReport = await client('service_role').rpc('hangtag_autopay_report', { p_provider: 'cashfree', p_subscription: SUB, p_event: 'pending', p_payment: null, p_amount: null,
  p_currency: null, p_next_charge_at: null, p_event_at: new Date(tick()).toISOString(), p_mode: 'test' });
const [mEnd] = await sql(`SELECT provider_status FROM public.hangtag_autopay_mandates WHERE subscription_id = $1`, [SUB]);
const wdShop2 = await shop(A);
check('…the charge withdrawn with it: Cashfree\'s "cancelled" (and a late "failed") for it → ignored, nothing reported; a later report that isn\'t an end ("pending") keeps the mandate ended (cancelled, never read as live again) and AutoPay off',
  wdNote.status === 200 && wdNote.body.ignored === true && wdLate.status === 200 && wdLate.body.ignored === true && wdShop.autopay_status === 'cancelled'
  && !lateReport.error && mEnd.provider_status === 'cancelled' && wdShop2.autopay_status === 'cancelled' && wdShop2.autopay_next_charge_at === null,
  { wdNote: wdNote.body, wdLate: wdLate.body, shop: wdShop.autopay_status, late: lateReport.error, mandate: mEnd.provider_status, after: wdShop2.autopay_status });

console.log('=== another shop ===');
const b = client('authenticated', B);
const bReport = await b.rpc('hangtag_autopay_report', { p_provider: 'cashfree', p_subscription: SUB, p_event: 'authenticated', p_payment: null, p_amount: null, p_currency: null,
  p_next_charge_at: null, p_event_at: null, p_mode: 'test' });
const bMandates = await b.raw(`SELECT count(*)::int n FROM public.hangtag_autopay_mandates`).then((r) => r.rows[0].n, (e) => 'denied:' + e.code);
const bPays = await b.raw(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [A]).then((r) => r.rows[0].n, (e) => 'denied:' + e.code);
const bSub = await b.raw(`SELECT count(*)::int n FROM public.hangtag_subscriptions WHERE owner_id = $1`, [A]).then((r) => r.rows[0].n, (e) => 'denied:' + e.code);
const bCancel = await fn(B, { action: 'autopay_cancel' });
check('shop B: can\'t run the registry (service role only), can\'t see A\'s mandates, payments or subscription; B\'s own "turn off AutoPay" touches nothing of A\'s',
  bReport.error && bReport.error.code === '42501' && (bMandates === 0 || /^denied/.test(bMandates)) && (bPays === 0 || /^denied/.test(bPays)) && (bSub === 0 || /^denied/.test(bSub))
  && bCancel.status >= 400 && (await shop(A)).autopay_status === 'cancelled', { bReport, bMandates, bPays, bSub, bCancel: bCancel.status });

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
