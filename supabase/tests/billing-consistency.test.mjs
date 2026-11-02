// The billing remediation in the post-repair migration (supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql
// sections 6–12; REMEDIATION steps 4, 5, 7, 8, 9 and the console's part of 6), on schema.sql plus the migration (run
// twice), as the owners, the console's staff, the service role (the subscription functions) and the signed-out would call
// it: the billing mode; the ledger; AutoPay's readiness and what it gates; the registry of every AutoPay set-up, charges
// recorded once at the price agreed, and reports in order; payments refused in another mode or for refunded money; the
// reconciler's run log and targets; the offer holds; the console's billing review; and nobody else reaching any of it.
// Run: node supabase/tests/billing-consistency.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
const SCHEMA = read('../schema.sql'), MIG = read('../migrations/20261019120000_hangtag_post_repair_integrity.sql');
const id = (n) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), C = id(3), D = id(4), E = id(5), F = id(6), G = id(7), H = id(8);
const SUPER = id(11), BILL = id(13), SUP = id(14), RO = id(15), NOSTAFF = id(16);
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };

const db = new PGlite();
await db.exec(STUB);
await db.exec(SCHEMA);
await db.exec(MIG); await db.exec(MIG);   // run twice: safe to run again
const sql = async (q, p) => (await db.query(q, p)).rows;
async function as(who, q, p) {
  await db.exec(`SET ROLE ${who === 'service' ? 'service_role' : who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who && who !== 'service' ? who : '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return { r: (await db.query(q, p)).rows }; } catch (e) { return { err: e.message, code: e.code }; } finally { await db.exec('RESET ROLE'); }
}
const val = async (who, q, p) => { const r = await as(who, q, p); return r.err ? r : Object.values(r.r[0])[0]; };
const svc = (q, p) => val('service', q, p);
const denied = (r) => !!r && (r.code === '42501' || /permission denied/.test(r.err || ''));
const onboard = (o) => as(o, `UPDATE public.hangtag_profiles SET shop_name = 'S', business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [o]);
const sub = async (o) => (await sql(`SELECT * FROM public.hangtag_subscriptions WHERE owner_id = $1`, [o]))[0];
const mandates = async (o) => sql(`SELECT * FROM public.hangtag_autopay_mandates WHERE shop_owner_id IS NOT DISTINCT FROM $1 ORDER BY created_at, subscription_id`, [o]);
const payments = async (o) => sql(`SELECT * FROM public.hangtag_subscription_payments WHERE owner_id = $1 ORDER BY created_at`, [o]);
const exceptions = async (kind) => sql(`SELECT * FROM public.hangtag_billing_exceptions WHERE kind = $1 ORDER BY id`, [kind]);
const report = (sub_, ev, o = {}) => svc(`SELECT public.hangtag_autopay_report('razorpay', $1, $2, $3, $4, $5, $6, $7, $8)`,
  [sub_, ev, o.payment || null, o.amount == null ? null : o.amount, o.currency || null, o.next || null, o.at || null, o.mode || 'live']);
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.now();

for (const [u, e] of [[A, 'a@shop.test'], [B, 'b@shop.test'], [C, 'c@shop.test'], [D, 'd@shop.test'], [E, 'e@shop.test'], [F, 'f@shop.test'], [G, 'g@shop.test'], [H, 'h@shop.test'],
  [SUPER, 'boss@hangtag.test'], [BILL, 'billing@hangtag.test'], [SUP, 'support@hangtag.test'], [RO, 'viewer@hangtag.test'], [NOSTAFF, 'someone@hangtag.test']]) {
  await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [u, e]);
}
await sql(`INSERT INTO public.hangtag_platform_staff (user_id, role) VALUES ($1, 'super_admin'), ($2, 'billing_admin'), ($3, 'support_admin'), ($4, 'read_only')`, [SUPER, BILL, SUP, RO]);

console.log('=== the billing mode and the ledger (step 4) ===');
{
  check('the database counts live money unless set otherwise (one row)', (await svc(`SELECT public.hangtag_billing_mode()`)) === 'live'
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_settings`))[0].n === 1);
  for (const who of [A, null]) {
    const rd = await as(who, `SELECT * FROM public.hangtag_billing_settings`), up = await as(who, `UPDATE public.hangtag_billing_settings SET billing_mode = 'test'`);
    const ins = await as(who, `INSERT INTO public.hangtag_billing_reconcile_runs (mode, ok, complete, finished_at) VALUES ('live', true, true, NOW())`);
    check(`${who ? 'an app account' : 'the signed-out'}: can't read or change the billing mode, nor write a reconciliation run`, denied(rd) && denied(up) && denied(ins), { rd, up, ins });
  }
  const e1 = await svc(`SELECT public.hangtag_billing_event_record('razorpay', 'evt_1', 'payment_link.paid', 'plink_x', 'live', 'plink_x', NOW() - interval '1 hour', 'settled', false)`);
  const e2 = await svc(`SELECT public.hangtag_billing_event_record('razorpay', 'evt_1', 'payment_link.paid', 'plink_x', 'live')`);
  check('an event: new the first time, known the second (one row)', e1.duplicate === false && e2.duplicate === true
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_events WHERE event_id = 'evt_1'`))[0].n === 1, [e1, e2]);
  const tmode = await svc(`SELECT public.hangtag_billing_event_record('razorpay', 'evt_t', 'payment_link.paid', 'plink_x', 'test')`);
  check('a test-mode event on the live database: refused, nothing written', /test mode on a live database/.test(tmode.err || '')
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_events WHERE event_id = 'evt_t'`))[0].n === 0, tmode);
  const seen = await svc(`SELECT public.hangtag_billing_event_seen('razorpay', 'evt_1', 'test')`);
  check('…and the webhook\'s question before acting says so (mode not ok), and that evt_1 was settled', seen.mode_ok === false && seen.duplicate === true && seen.billing_mode === 'live', seen);
  const fut = await svc(`SELECT public.hangtag_billing_event_record('razorpay', 'evt_f', 'payment_link.paid', 'plink_x', 'live', 'plink_x', NOW() + interval '3 days')`);
  check('an event\'s provider time is never later than now (a clock ahead can\'t keep readiness on)', fut.duplicate === false
    && (await sql(`SELECT provider_created_at <= NOW() AS ok FROM public.hangtag_billing_events WHERE event_id = 'evt_f'`))[0].ok === true);
  for (const q of [`SELECT public.hangtag_billing_event_record('razorpay', 'x', 't', null, 'live')`, `SELECT public.hangtag_billing_event_seen('razorpay', 'x', 'live')`,
    `SELECT public.hangtag_billing_readiness()`, `SELECT public.hangtag_billing_mode()`, `SELECT * FROM public.hangtag_billing_events`]) {
    const a = await as(A, q), n = await as(null, q);
    if (!(denied(a) && denied(n))) check('app accounts and the signed-out reach none of the ledger', false, { q, a, n });
  }
  check('app accounts and the signed-out reach none of the ledger (record, seen, readiness, mode, the table)', true);
}

console.log('=== AutoPay readiness and what it gates (step 4) ===');
{
  const rd0 = await svc(`SELECT public.hangtag_billing_readiness()`);
  check('nothing proven: not ready, with each reason', rd0.ready === false && rd0.reasons.length === 3, rd0);
  const save = await as(SUPER, `SELECT public.hangtag_platform_settings_save('{"autopay_enabled": true}')`);
  check('a super admin switching AutoPay on while it isn\'t ready → refused, naming the webhook; the setting unchanged',
    /webhook isn't proven/.test(save.err || '') && (await sql(`SELECT autopay_enabled FROM public.hangtag_platform_config`))[0].autopay_enabled === false, save);
  // the self-check's objects and their notifications, and one complete reconciliation
  await svc(`SELECT public.hangtag_billing_probe_record('razorpay', 'payment_link', 'plink_Probe1', 'live')`);
  await svc(`SELECT public.hangtag_billing_probe_record('razorpay', 'subscription', 'sub_Probe12', 'live')`);
  const noise = await svc(`SELECT public.hangtag_billing_event_record('razorpay', 'evt_n', 'payment_link.cancelled', 'plink_Else', 'live', 'plink_Else', NOW())`);
  check('a notification about an object that is neither a probe nor Hangtag\'s proves nothing', noise.duplicate === false
    && (await svc(`SELECT public.hangtag_billing_readiness()`)).link_event_at === null);
  await svc(`SELECT public.hangtag_billing_event_record('razorpay', 'evt_p1', 'payment_link.cancelled', 'plink_Probe1', 'live', 'plink_Probe1', NOW() - interval '2 minutes', 'probe', true)`);
  await svc(`SELECT public.hangtag_billing_event_record('razorpay', 'evt_p2', 'subscription.cancelled', 'sub_Probe12', 'live', 'sub_Probe12', NOW() - interval '1 minute', 'probe', true)`);
  const half = await svc(`SELECT public.hangtag_billing_readiness()`);
  check('both probes\' notifications in: still not ready without a complete reconciliation', half.ready === false && half.link_event_at && half.autopay_event_at
    && JSON.stringify(half.reasons) === JSON.stringify(['no complete reconciliation in 26 hours']), half);
  const b1 = await svc(`SELECT public.hangtag_billing_reconcile_begin(10, 'live')`);
  const d1 = await svc(`SELECT public.hangtag_billing_reconcile_done($1, '{"ok": true, "complete": true}')`, [b1.run_id]);
  const rd1 = await svc(`SELECT public.hangtag_billing_readiness()`);
  check('…a complete, ok run: ready', b1.run_id && d1.ok === true && rd1.ready === true, { b1, d1, rd1 });
  const save2 = await as(SUPER, `SELECT public.hangtag_platform_settings_save('{"autopay_enabled": true}')`);
  const audit = (await sql(`SELECT detail FROM public.hangtag_platform_audit WHERE action = 'settings.update' ORDER BY id DESC LIMIT 1`))[0];
  check('…then switching AutoPay on works, and its audit row holds the readiness it was given', !save2.err && (await sql(`SELECT autopay_enabled FROM public.hangtag_platform_config`))[0].autopay_enabled === true
    && audit && audit.detail.readiness && audit.detail.readiness.ready === true, { save2, audit });
  await onboard(A);
  check('ready, AutoPay on and required of new trials: a new shop waits for AutoPay (trial_setup)', (await sub(A)).autopay_required === true);
  // the proof lapses: the notifications 8 days old (the provider's time)
  await sql(`UPDATE public.hangtag_billing_events SET provider_created_at = NOW() - interval '8 days'`);
  const rd2 = await svc(`SELECT public.hangtag_billing_readiness()`), q2 = await val(A, `SELECT public.hangtag_autopay_quote()`);
  const beg = await as(A, `SELECT public.hangtag_autopay_begin(true, 'autopay-2026-10')`);
  check('the proof lapsed (8-day-old notifications): not ready → AutoPay not offered and its set-up refused', rd2.ready === false && q2.available === false
    && /isn't available yet/.test(beg.err || ''), { rd2, q2, beg });
  await onboard(B);
  check('…and a shop set up now is never made to wait for it (trial_active, not trial_setup)', (await sub(B)).autopay_required === false
    && (await svc(`SELECT public.hangtag_subscription_state($1, NOW())`, [B])) === 'trial_active');
  const keepOn = await as(SUPER, `SELECT public.hangtag_platform_settings_save('{"autopay_enabled": true, "trial_requires_autopay": true, "renewal_grace_hours": 96}')`);
  check('…a console save that keeps AutoPay on and changes the grace hours still works while the proof has lapsed', !keepOn.err
    && (await sql(`SELECT renewal_grace_hours FROM public.hangtag_platform_config`))[0].renewal_grace_hours === 96, keepOn);
  await as(SUPER, `SELECT public.hangtag_platform_settings_save('{"autopay_enabled": false}')`);
  const backOn = await as(SUPER, `SELECT public.hangtag_platform_settings_save('{"autopay_enabled": true}')`);
  check('…but switching it on again is refused until the proof is fresh', /webhook isn't proven/.test(backOn.err || ''), backOn);
  await sql(`UPDATE public.hangtag_billing_events SET provider_created_at = NOW() - interval '1 minute'`);
  const reOn = await as(SUPER, `SELECT public.hangtag_platform_settings_save('{"autopay_enabled": true}')`);
  check('…fresh again: switching it on works', !reOn.err && (await sql(`SELECT autopay_enabled FROM public.hangtag_platform_config`))[0].autopay_enabled === true, reOn);
}

console.log('=== the registry: every AutoPay set-up; a charge once, at the price agreed (steps 5 and 8) ===');
{
  // C: AutoPay set up, attached, then halted (R1/R4's starting point)
  await onboard(C);
  check('AutoPay is offered again (the proof fresh)', (await val(C, `SELECT public.hangtag_autopay_quote()`)).available === true);
  const b1 = await val(C, `SELECT public.hangtag_autopay_begin(true, 'autopay-2026-10')`);
  const at1 = await svc(`SELECT public.hangtag_autopay_attach_mandate($1, 'razorpay', 'sub_OLD1234567', 'cust_C', 'live')`, [b1.mandate_id]);
  const m1 = (await mandates(C))[0];
  check('a set-up registered at begin with the price and currency agreed (999 INR, m1), then attached by its id: the shop\'s current one',
    b1.mandate_id && at1.current === true && m1.subscription_id === 'sub_OLD1234567' && m1.is_current && +m1.price === 999 && m1.currency === 'INR' && m1.plan_code === 'm1'
    && (await sub(C)).autopay_subscription_id === 'sub_OLD1234567', { b1, at1, m1 });
  const wrongMode = await svc(`SELECT public.hangtag_autopay_attach_mandate($1, 'razorpay', 'sub_T', NULL, 'test')`, [b1.mandate_id]);
  check('…an attach in test mode on the live database: refused', /test mode on a live database/.test(wrongMode.err || ''), wrongMode);
  const t1 = Date.now() - 60 * 864e5;   // provider times in the past (the database never takes one later than now)
  await report('sub_OLD1234567', 'activated', { at: iso(t1) });
  await report('sub_OLD1234567', 'halted', { at: iso(t1 + 3 * 864e5) });
  check('activated then halted (in order): the shop\'s AutoPay halted', (await sub(C)).autopay_status === 'halted');
  // R1: set up again while halted → the old one handed back to be cancelled
  const b2 = await val(C, `SELECT public.hangtag_autopay_begin(true, 'autopay-2026-10')`);
  const ms = await mandates(C);
  check('set up again while halted: the halted set-up is handed back to be cancelled (to_cancel), no longer current, its cancel requested',
    JSON.stringify(b2.to_cancel) === JSON.stringify([{ provider: 'razorpay', subscription_id: 'sub_OLD1234567' }]) && ms.filter((m) => m.is_current).length === 1
    && ms.find((m) => m.subscription_id === 'sub_OLD1234567').cancel_requested_at !== null, { b2, ms });
  await svc(`SELECT public.hangtag_autopay_attach_mandate($1, 'razorpay', 'sub_NEW1234567', 'cust_C', 'live')`, [b2.mandate_id]);
  const before = await sub(C);
  const c1 = await report('sub_OLD1234567', 'charged', { payment: 'pay_OLD1', amount: 999, currency: 'INR', at: iso(t1 + 4 * 864e5) });
  const c2 = await report('sub_OLD1234567', 'charged', { payment: 'pay_OLD1', amount: 999, currency: 'INR', at: iso(t1 + 4 * 864e5) });
  const after = await sub(C), pays = (await payments(C)).filter((p) => p.provider_payment_id === 'pay_OLD1');
  check('R1: a charge on the replaced set-up → recorded once (known, not current, to be cancelled), filed under that set-up, a month added once; sent again → nothing more',
    c1.known === true && c1.current === false && c1.recorded === true && c1.cancel === true && c2.already === true && pays.length === 1 && pays[0].provider_order_id === 'sub_OLD1234567'
    && pays[0].note === 'Review: charge on a replaced AutoPay' && after.period_end && (!before.period_end || after.period_end > before.period_end), { c1, c2, pays });
  check('…and the shop\'s AutoPay stays with its new set-up (pending, sub_NEW)', after.autopay_status === 'pending' && after.autopay_subscription_id === 'sub_NEW1234567', after);
  const act = await report('sub_OLD1234567', 'activated', { at: iso(t1 + 5 * 864e5) });
  check('…a state report on the replaced set-up moves only that set-up (the shop\'s AutoPay unchanged), and asks again for its cancel',
    act.current === false && act.cancel === true && (await sub(C)).autopay_status === 'pending', act);
  const conf = await report('sub_OLD1234567', 'cancelled', { at: iso(t1 + 6 * 864e5) });
  const old = (await mandates(C)).find((m) => m.subscription_id === 'sub_OLD1234567');
  check('…its cancellation confirmed (a terminal report always applies): the set-up off, nothing more owed', conf.cancel === false && old.cancel_confirmed_at !== null && old.provider_status === 'cancelled', old);
  // the price agreed: another amount (or currency) adds no time
  await report('sub_NEW1234567', 'activated', { at: iso(t1 + 7 * 864e5) });
  const pe0 = (await sub(C)).period_end;
  const odd = await report('sub_NEW1234567', 'charged', { payment: 'pay_Auth5', amount: 5, currency: 'INR', at: iso(t1 + 8 * 864e5) });
  const usd = await report('sub_NEW1234567', 'charged', { payment: 'pay_Usd999', amount: 999, currency: 'USD', at: iso(t1 + 8 * 864e5) });
  check('a charge of another amount (₹5) or currency (USD) on the current set-up → no time, no payment; kept for review (amount_mismatch / currency_mismatch)',
    odd.recorded === false && odd.mismatch === true && usd.recorded === false && +(await sub(C)).period_end === +pe0
    && (await exceptions('amount_mismatch')).some((x) => x.provider_payment_id === 'pay_Auth5') && (await exceptions('currency_mismatch')).some((x) => x.provider_payment_id === 'pay_Usd999')
    && !(await payments(C)).some((p) => ['pay_Auth5', 'pay_Usd999'].includes(p.provider_payment_id)), { odd, usd });
  const unknown = await report('sub_NEVER12345', 'charged', { payment: 'pay_X1', amount: 999, currency: 'INR' });
  check('an id Hangtag never made → not known, nothing written', unknown.known === false && (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE provider_payment_id = 'pay_X1'`))[0].n === 0);
  const wm = await report('sub_NEW1234567', 'charged', { payment: 'pay_T1', amount: 999, currency: 'INR', mode: 'test' });
  check('a report in test mode on the live database: refused', /test mode on a live database/.test(wm.err || ''), wm);
  // an orphan: a set-up with Hangtag's note no shop recorded, kept to be cancelled — its charge never becomes time
  const orph = await svc(`SELECT public.hangtag_autopay_orphan('razorpay', 'sub_ORPH123456', 'live')`);
  const oc = await report('sub_ORPH123456', 'charged', { payment: 'pay_Orph1', amount: 999, currency: 'INR' });
  const oc2 = await report('sub_ORPH123456', 'charged', { payment: 'pay_Orph1', amount: 999, currency: 'INR' });
  check('an orphan (no shop): its charge → no payment, kept for review once (unknown_mandate_charge), still to be cancelled; no error, sent again or not',
    orph.registered === true && oc.recorded === false && oc.orphan === true && oc.cancel === true && !oc2.err
    && (await exceptions('unknown_mandate_charge')).filter((x) => x.ref === 'pay_Orph1').length === 1
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE provider_payment_id = 'pay_Orph1'`))[0].n === 0, { orph, oc, oc2 });
  check('…a probe of the self-check is never registered as an orphan', (await svc(`SELECT public.hangtag_autopay_orphan('razorpay', 'sub_Probe12', 'live')`)).probe === true);
  // event order: newer state wins; a charge always recorded; a cancellation always applies
  const t2 = t1 + 20 * 864e5;
  await report('sub_NEW1234567', 'charged', { payment: 'pay_N2', amount: 999, currency: 'INR', at: iso(t2) });
  const late = await report('sub_NEW1234567', 'halted', { at: iso(t2 - 864e5) });
  check('step 8: charged at t2, then a halt from t1 (older) → stale, not applied: AutoPay stays active', late.stale === true && (await sub(C)).autopay_status === 'active', late);
  await report('sub_NEW1234567', 'halted', { at: iso(t2 + 864e5) });
  check('…a halt from t3 (newer) → halted', (await sub(C)).autopay_status === 'halted');
  const pe1 = (await sub(C)).period_end;
  const oldCharge = await report('sub_NEW1234567', 'charged', { payment: 'pay_N0', amount: 999, currency: 'INR', at: iso(t2 - 2 * 864e5) });
  check('…a charge from before (old time) is still recorded once, its month added — and the state stays halted',
    oldCharge.recorded === true && oldCharge.stale === true && (await sub(C)).autopay_status === 'halted' && (await sub(C)).period_end > pe1, oldCharge);
  // R4: halted, the owner pays by hand → checkout hands the halted set-up back to be cancelled first
  const ck = await val(C, `SELECT public.hangtag_subscription_checkout('m1', NULL, 'razorpay')`);
  check('R4: checkout while AutoPay is halted → the halted set-up handed back to cancel first (cancel_mandate)', ck.cancel_mandate && ck.cancel_mandate.subscription_id === 'sub_NEW1234567', ck);
  await report('sub_NEW1234567', 'cancelled', {});
  const ck2 = await val(C, `SELECT public.hangtag_subscription_checkout('m1', NULL, 'razorpay')`);
  const lateCharge = await report('sub_NEW1234567', 'charged', { payment: 'pay_N9', amount: 999, currency: 'INR', at: iso(t2 + 2 * 864e5) });
  check('…once confirmed cancelled: AutoPay cancelled, no hand-back; a charge still arriving from it is recorded once and AutoPay stays cancelled',
    (await sub(C)).autopay_status === 'cancelled' && !ck2.cancel_mandate && lateCharge.recorded === true && (await sub(C)).autopay_status === 'cancelled', { ck2, lateCharge });
  // a refund kept for review stops the time of its payment
  await svc(`SELECT public.hangtag_billing_exception_open('razorpay', 'refund', 'rfnd_R1', $1, NULL, 999, '{}', 'pay_Ref1')`, [C]);
  const pe2 = (await sub(C)).period_end;
  const refunded = await report('sub_NEW1234567', 'charged', { payment: 'pay_Ref1', amount: 999, currency: 'INR' });
  check('a charge whose refund is already kept for review → no time (refunded)', refunded.recorded === false && refunded.refunded === true && +(await sub(C)).period_end === +pe2, refunded);
  // a price or plan that can no longer be found: kept for review, never an error the provider would send again and again
  await sql(`UPDATE public.hangtag_autopay_mandates SET price = NULL, plan_code = 'gone' WHERE subscription_id = 'sub_NEW1234567'`);
  const pe3 = (await sub(C)).period_end;
  const gone = await report('sub_NEW1234567', 'charged', { payment: 'pay_Gone1', amount: 999, currency: 'INR' });
  check('a charge whose agreed price or plan can\'t be found (a plan since removed) → no time and no error; kept for review (amount_mismatch, naming the plan)',
    !gone.err && gone.recorded === false && gone.mismatch === true && +(await sub(C)).period_end === +pe3
    && (await exceptions('amount_mismatch')).some((x) => x.provider_payment_id === 'pay_Gone1' && x.detail && x.detail.plan === 'gone'), gone);
  for (const q of [`SELECT public.hangtag_autopay_report('razorpay', 'sub_NEW1234567', 'charged', 'pay_Z', 999, 'INR', NULL, NULL, 'live')`,
    `SELECT public.hangtag_autopay_attach_mandate($1, 'razorpay', 'sub_Z', NULL, 'live')`, `SELECT public.hangtag_autopay_orphan('razorpay', 'sub_Z', 'live')`,
    `SELECT public.hangtag_autopay_check_claim($1)`, `SELECT * FROM public.hangtag_autopay_mandates`]) {
    const a = await as(C, q, q.includes('$1') ? [q.includes('attach') ? b2.mandate_id : C] : undefined), n = await as(null, q, q.includes('$1') ? [q.includes('attach') ? b2.mandate_id : C] : undefined);
    if (!(denied(a) && denied(n))) check('no app account reaches the registry', false, { q, a, n });
  }
  check('no app account, not even the shop\'s owner, reaches the registry or reports to it (report, attach, orphan, claim, the table)', true);
}

console.log('=== the backfill: set-ups made before the registry ===');
{
  await onboard(D);
  await sql(`UPDATE public.hangtag_subscriptions SET autopay_status = 'active', autopay_provider = 'razorpay', autopay_subscription_id = 'sub_PRE1234567',
    autopay_plan_code = 'm1', autopay_consent_at = NOW() WHERE owner_id = $1`, [D]);
  await db.exec(MIG);
  const md = await mandates(D);
  await db.exec(MIG);
  check('a set-up from before the migration → registered as the shop\'s current one, with its plan\'s price; run again → still one',
    md.length === 1 && md[0].subscription_id === 'sub_PRE1234567' && md[0].is_current && +md[0].price === 999 && (await mandates(D)).length === 1, md);
  const ch = await report('sub_PRE1234567', 'charged', { payment: 'pay_Pre1', amount: 999, currency: 'INR' });
  check('…its charges recorded as the current set-up\'s', ch.recorded === true && ch.current === true, ch);
}

console.log('=== activation in the billing mode, never for refunded money (steps 4 and 6) ===');
{
  await onboard(E);
  const ck = await val(E, `SELECT public.hangtag_subscription_checkout('m1', NULL, 'razorpay')`);
  await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_E1')`, [ck.payment_id]);
  const tm = await svc(`SELECT public.hangtag_subscription_activate_checked($1, 'pay_E1', 999, 'test')`, [ck.payment_id]);
  check('a test-mode activation on the live database: refused (nothing paid)', /test mode on a live database/.test(tm.err || '') && (await payments(E))[0].status === 'created', tm);
  await svc(`SELECT public.hangtag_billing_exception_open('razorpay', 'refund', 'rfnd_E1', $1, $2, 999, '{}', 'pay_E1')`, [E, ck.payment_id]);
  const rf = await svc(`SELECT public.hangtag_subscription_activate_checked($1, 'pay_E1', 999, 'live')`, [ck.payment_id]);
  check('…money already refunded (its refund open for review): refused, the payment stays unpaid', rf.ok === false && rf.reason === 'refunded' && (await payments(E))[0].status === 'created', rf);
  await sql(`UPDATE public.hangtag_billing_exceptions SET status = 'resolved' WHERE ref = 'rfnd_E1'`);
  const ok = await svc(`SELECT public.hangtag_subscription_activate_checked($1, 'pay_E1', 999, 'live')`, [ck.payment_id]);
  check('…once settled: activated, once', ok.ok === true && (await payments(E))[0].status === 'paid', ok);
  const again = await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_E2')`, [ck.payment_id]);
  check('a page attached to a payment no longer open (paid): refused, so the caller withdraws it', /can't take a payment page any more/.test(again.err || ''), again);
  const ck2 = await val(E, `SELECT public.hangtag_subscription_checkout('m1', NULL, 'razorpay')`);
  await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_E3')`, [ck2.payment_id]);
  const same = await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_E3')`, [ck2.payment_id]);
  const other = await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_E4')`, [ck2.payment_id]);
  check('…the same page again: fine; another page on a payment that has one: refused', !same.err && /can't take a payment page any more/.test(other.err || ''), { same, other });
  const appAct = await as(E, `SELECT public.hangtag_subscription_activate_checked($1, 'pay_E9', 999, 'live')`, [ck2.payment_id]);
  check('…no app account activates anything', denied(appAct), appAct);
}

console.log('=== offers held only by real checkouts (step 9) ===');
{
  await sql(`INSERT INTO public.hangtag_promo_codes (code, kind, value, title, active, auto_apply, max_uses, per_account_limit, plans, new_customers_only)
    VALUES ('CAP2', 'fixed', 100, 'Two places', true, false, 2, 1, ARRAY['m1'], false)`);
  for (const o of [F, G, H]) await onboard(o);
  const xF = await val(F, `SELECT public.hangtag_subscription_checkout('m1', 'CAP2', 'razorpay')`), xG = await val(G, `SELECT public.hangtag_subscription_checkout('m1', 'CAP2', 'razorpay')`);
  const qH = await val(H, `SELECT public.hangtag_subscription_quote('m1', 'CAP2')`);
  check('R3: two owners calling the checkout directly (no payment page) hold no place: a third still gets the offer', xF.payment_id && xG.payment_id && qH.promo.valid === true && qH.promo.remaining === 2, qH.promo);
  await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_F1')`, [xF.payment_id]);
  const xF2 = await val(F, `SELECT public.hangtag_subscription_checkout('m1', 'CAP2', 'razorpay')`);
  await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_F2')`, [xF2.payment_id]);
  const qH2 = await val(H, `SELECT public.hangtag_subscription_quote('m1', 'CAP2')`);
  check('…a real checkout (its page made) holds one place; the same owner checking out twice still one', qH2.promo.valid === true && qH2.promo.remaining === 1, qH2.promo);
  // F's attached checkouts lapse unpaid: older than 30 minutes, two in the last day → F holds no place even with a fresh one
  await sql(`UPDATE public.hangtag_subscription_payments SET created_at = NOW() - interval '2 hours' WHERE provider_order_id IN ('plink_F1', 'plink_F2')`);
  const xF3 = await val(F, `SELECT public.hangtag_subscription_checkout('m1', 'CAP2', 'razorpay')`);
  await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_F3')`, [xF3.payment_id]);
  const qH3 = await val(H, `SELECT public.hangtag_subscription_quote('m1', 'CAP2')`);
  check('…a shop that let two such checkouts lapse in a day holds no place with its next one', qH3.promo.remaining === 2, qH3.promo);
}

console.log('=== the reconciler\'s run log and targets (step 7) ===');
{
  await onboard(id(20).replace(/.$/, '0'));
  const busy = await svc(`SELECT public.hangtag_billing_reconcile_begin(10, 'live')`);
  check('a run just ended (under 5 minutes): the next is told busy', busy.busy === true, busy);
  await sql(`UPDATE public.hangtag_billing_reconcile_runs SET finished_at = NOW() - interval '10 minutes', started_at = NOW() - interval '11 minutes'`);
  const refused = await svc(`SELECT public.hangtag_billing_reconcile_begin(10, 'test')`);
  check('a run in test mode on the live database: refused, and recorded as a failed run (the window stays)', refused.refused === true
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_reconcile_runs WHERE error_code = 'mode_mismatch' AND ok = false`))[0].n === 1, refused);
  // payments: one an hour old with a page (a target), one 5 minutes old (too new), one without a page, one 8 days old
  const pay = async (o, ageSql, order) => {
    const c = await val(o, `SELECT public.hangtag_subscription_checkout('m1', NULL, 'razorpay')`);
    if (order) await svc(`SELECT public.hangtag_subscription_attach($1, 'razorpay', $2)`, [c.payment_id, order]);
    await sql(`UPDATE public.hangtag_subscription_payments SET created_at = NOW() - interval '${ageSql}' WHERE id = $1`, [c.payment_id]);
    return c.payment_id;
  };
  const due = await pay(G, '1 hour', 'plink_G1'), fresh = await pay(G, '5 minutes', 'plink_G2'), nopage = await pay(G, '2 hours', null), old = await pay(G, '8 days', 'plink_G3');
  await sql(`UPDATE public.hangtag_billing_reconcile_runs SET finished_at = NOW() - interval '10 minutes'`);
  const b = await svc(`SELECT public.hangtag_billing_reconcile_begin(50, 'live')`);
  const ids = b.payments.map((p) => p.id);
  check('a run\'s payments: those with a page, 15 minutes to 7 days old, not paid — not too new, not without a page, not older (after a complete run within the week)',
    ids.includes(due) && !ids.includes(fresh) && !ids.includes(nopage) && !ids.includes(old), { ids });
  const subs = b.mandates.map((m) => m.subscription_id + ':' + m.reason);
  check('…its AutoPay set-ups: the one owed a cancel; never a probe', b.mandates.length >= 1 && !subs.some((s) => s.startsWith('sub_Probe')), subs);
  const second = await svc(`SELECT public.hangtag_billing_reconcile_begin(50, 'live')`);
  check('…while it runs, another is told busy (one run at a time)', second.busy === true, second);
  const done = await svc(`SELECT public.hangtag_billing_reconcile_done($1, $2)`, [b.run_id, JSON.stringify({ ok: true, complete: true, checked: 3, repaired: 1,
    checked_payments: [{ id: due, final: false }], checked_mandates: b.mandates.map((m) => m.id), c_until: iso(Date.now() + 864e5), d_until: iso(Date.now() - 3600e3) })]);
  const runRow = (await sql(`SELECT * FROM public.hangtag_billing_reconcile_runs WHERE id = $1`, [b.run_id]))[0];
  check('the run\'s end: stamped by the database; a resume point never past the run\'s start; what was read marked read',
    done.ok === true && runRow.finished_at && runRow.complete === true && +runRow.c_until <= +runRow.started_at && runRow.d_until !== null
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_payment_checks WHERE payment_id = $1`, [due]))[0].n === 1, runRow);
  const twice = await svc(`SELECT public.hangtag_billing_reconcile_done($1, '{"ok": true}')`, [b.run_id]);
  check('…ended once only', /No such run waiting to finish/.test(twice.err || ''), twice);
  await sql(`UPDATE public.hangtag_billing_reconcile_runs SET finished_at = NOW() - interval '10 minutes'`);
  const b2 = await svc(`SELECT public.hangtag_billing_reconcile_begin(50, 'live')`);
  check('…a payment read under 50 minutes ago isn\'t read again yet', !b2.payments.some((p) => p.id === due), b2.payments.map((p) => p.id));
  await svc(`SELECT public.hangtag_billing_reconcile_done($1, '{"ok": false, "error_code": "500"}')`, [b2.run_id]);
  const known = await svc(`SELECT public.hangtag_billing_known_payments('razorpay', ARRAY['pay_N2', 'pay_Orph1', 'pay_Nobody'])`);
  const kn = await svc(`SELECT public.hangtag_autopay_known('razorpay', ARRAY['sub_NEW1234567', 'sub_Probe12', 'sub_Other'])`);
  check('which provider payments Hangtag holds (a paid one, one kept for review — not a stranger); which subscriptions are its set-ups, which probes',
    JSON.stringify([...known].sort()) === JSON.stringify(['pay_N2', 'pay_Orph1']) && JSON.stringify(kn.known) === JSON.stringify(['sub_NEW1234567'])
    && JSON.stringify(kn.probes) === JSON.stringify(['sub_Probe12']), { known, kn });
  const ig = await svc(`SELECT public.hangtag_billing_integrity()`);
  check('the money-and-time invariants hold on all of this (no overlap, nothing paid uncaptured, no time short of payments, every AutoPay charge of a set-up)', ig.ok === true, ig.problems);
  await sql(`UPDATE public.hangtag_subscription_payments SET captured_at = NULL WHERE provider_payment_id = 'pay_N2'`);
  const ig2 = await svc(`SELECT public.hangtag_billing_integrity()`);
  check('…a paid payment that no provider captured is reported', ig2.ok === false && ig2.problems.some((p) => p.kind === 'paid_without_capture'), ig2.problems);
  await sql(`UPDATE public.hangtag_subscription_payments SET captured_at = paid_at WHERE provider_payment_id = 'pay_N2'`);
  for (const q of [`SELECT public.hangtag_billing_reconcile_begin(1, 'live')`, `SELECT public.hangtag_billing_reconcile_done(1, '{}')`, `SELECT public.hangtag_billing_integrity()`,
    `SELECT public.hangtag_billing_known_payments('razorpay', ARRAY['x'])`, `SELECT * FROM public.hangtag_billing_reconcile_runs`]) {
    const a = await as(SUPER, q), n = await as(null, q);
    if (!(denied(a) && denied(n))) check('no app account reaches the reconciler', false, { q, a, n });
  }
  check('no app account (not even a super admin\'s session) nor the signed-out reaches the reconciler\'s functions or its log', true);
}

console.log('=== the console\'s billing review (step 6) ===');
{
  const list = await val(SUP, `SELECT public.hangtag_platform_billing_exceptions('open', 50)`);
  const ro = await val(RO, `SELECT public.hangtag_platform_billing_exceptions('all', 50)`);
  const none = await as(NOSTAFF, `SELECT public.hangtag_platform_billing_exceptions('open', 50)`), shop = await as(A, `SELECT public.hangtag_platform_billing_exceptions('open', 50)`);
  check('support and read-only staff list the money kept for review (with the shop); an account without a console role, or a shop, can\'t',
    list.rows.length > 0 && list.counts.open >= list.rows.length && ro.rows.length >= list.rows.length && /HANGTAG_PLATFORM_DENIED/.test(none.err || '') && /HANGTAG_PLATFORM_DENIED/.test(shop.err || ''), { list: list.counts, none, shop });
  const target = list.rows.find((r) => r.kind === 'unknown_mandate_charge');
  const bySupport = await as(SUP, `SELECT public.hangtag_platform_billing_exception_resolve($1, 'refunded in the dashboard')`, [target.id]);
  const short = await as(BILL, `SELECT public.hangtag_platform_billing_exception_resolve($1, 'ok')`, [target.id]);
  const res = await val(BILL, `SELECT public.hangtag_platform_billing_exception_resolve($1, 'refunded in the dashboard')`, [target.id]);
  const again = await as(BILL, `SELECT public.hangtag_platform_billing_exception_resolve($1, 'twice over')`, [target.id]);
  const audit = (await sql(`SELECT * FROM public.hangtag_platform_audit WHERE action = 'billing.exception_resolve' ORDER BY id DESC LIMIT 1`))[0];
  check('settled only by those who manage subscriptions, with a reason; once; audited (who, role, before and after)',
    /HANGTAG_PLATFORM_DENIED/.test(bySupport.err || '') && /3 to 300 characters/.test(short.err || '') && res.status === 'resolved' && res.resolution === 'refunded in the dashboard'
    && /already settled/.test(again.err || '') && audit && audit.actor === BILL && audit.actor_role === 'billing_admin' && audit.detail.before.status === 'open' && audit.detail.after.status === 'resolved', { res, audit });
  const health = await val(RO, `SELECT public.hangtag_platform_billing_health()`);
  check('billing health for those who see payments: the mode, the readiness, the last runs, the open count, the invariants', health.mode === 'live' && 'ready' in health.readiness
    && Array.isArray(health.runs) && health.runs.length > 0 && typeof health.open_exceptions === 'number' && health.integrity && typeof health.integrity.ok === 'boolean', health);
  const sc1 = await as(SUP, `SELECT public.hangtag_billing_selfcheck_allowed()`);
  const sc2 = await val(SUPER, `SELECT public.hangtag_billing_selfcheck_allowed()`);
  const sc3 = await as(SUPER, `SELECT public.hangtag_billing_selfcheck_allowed()`);
  check('the self-check: only staff who manage settings, at most once in 10 minutes, logged before anything is made', /HANGTAG_PLATFORM_DENIED/.test(sc1.err || '') && sc2 === true
    && /less than 10 minutes ago/.test(sc3.err || '') && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit WHERE action = 'billing.selfcheck'`))[0].n === 1, { sc1, sc3 });
}

console.log('=== the provider asked a limited number of times per account (step 11) ===');
{
  const claim = (o, k) => svc(`SELECT public.hangtag_billing_call_claim($1, $2)`, [o, k]);
  // the counts go by the minute: start well inside one
  while (new Date().getSeconds() > 50) await new Promise((r) => setTimeout(r, 500));
  const got = [];
  for (let i = 0; i < 61; i++) got.push(await claim(A, 'verify'));
  const okN = got.filter((g) => g && g.ok === true).length, refused = got[60];
  check('the app\'s payment check: 60 a minute for one account, then refused with when to ask again (within the minute)',
    okN === 60 && refused && refused.ok === false && refused.retry_after >= 1 && refused.retry_after <= 60, { okN, refused });
  const other = await claim(B, 'verify'), start = await claim(A, 'autopay_start');
  check('…another account, and another kind of call of the same account, are counted apart', other && other.ok === true && start && start.ok === true, { other, start });
  const starts = [];
  for (let i = 0; i < 6; i++) starts.push(await claim(E, 'autopay_start'));
  const sRefused = await claim(E, 'autopay_start');
  check('starting AutoPay: 6 a minute for one account, then refused', starts.every((s) => s && s.ok === true) && sRefused && sRefused.ok === false, { starts, sRefused });
  // an hour's worth already used (900 in the last 15 minutes): refused until the oldest of them is an hour old
  await sql(`INSERT INTO public.hangtag_billing_call_counts (shop_owner_id, kind, bucket, hits)
    SELECT $1, 'verify', date_trunc('minute', NOW()) - k * interval '1 minute', 60 FROM generate_series(1, 15) k`, [C]);
  const hour = await claim(C, 'verify');
  check('…900 checks in the last hour: refused, to ask again when the oldest of them is an hour old (about 45 minutes)',
    hour && hour.ok === false && hour.retry_after > 44 * 60 && hour.retry_after <= 46 * 60, hour);
  await sql(`INSERT INTO public.hangtag_billing_call_counts (shop_owner_id, kind, bucket, hits) VALUES ($1, 'verify', date_trunc('minute', NOW()) - interval '2 hours', 900)`, [D]);
  const fresh = await claim(D, 'verify');
  const kept = await sql(`SELECT count(*)::int n FROM public.hangtag_billing_call_counts WHERE shop_owner_id = $1 AND bucket <= NOW() - interval '1 hour'`, [D]);
  check('…counts older than an hour no longer count, and are cleared as the account calls again', fresh && fresh.ok === true && kept[0].n === 0, { fresh, kept });
  const odd = await claim(A, 'checkout'), noOne = await claim(null, 'verify');
  check('an unknown kind of call, or no account: refused', /known kind/.test(odd.err || '') && /known kind/.test(noOne.err || ''), { odd, noOne });
  const appCall = await as(A, `SELECT public.hangtag_billing_call_claim($1, 'verify')`, [A]), anonCall = await as(null, `SELECT public.hangtag_billing_call_claim($1, 'verify')`, [A]);
  const appRead = await as(A, `SELECT count(*) FROM public.hangtag_billing_call_counts`), anonRead = await as(null, `SELECT count(*) FROM public.hangtag_billing_call_counts`);
  check('…and app accounts and the signed-out can neither count a call nor read the counts', denied(appCall) && denied(anonCall) && denied(appRead) && denied(anonRead),
    { appCall, anonCall, appRead, anonRead });
}

console.log(`\n(${Math.round((Date.now() - T0) / 1000)} s)`);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
