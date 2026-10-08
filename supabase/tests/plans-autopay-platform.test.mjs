// Commercial plans, the launch offer, the 30-day trial with AutoPay and the Platform Console (schema.sql section 3w,
// migration 20261009120000_hangtag_plans_autopay_platform.sql), tested as an attacker and as the payment provider would:
// the plans and the trial from the database; the launch offer applied by itself to new customers only, counted, its hard
// cap held even when payments race (a late payment is honoured as the plan it pays for, never as a redemption beyond the
// cap); AutoPay moved only by the provider (service role), its consent recorded, the trial waiting for it when it is
// required, its charges captured once each, its failures given a grace and then locking, cancelling keeping the time
// paid for; money counted as received only when the provider captured it; and the console: roles by account id, every
// function checking the role, totals only, privileged actions in the audit log, the shops' data out of reach.
// Run: node supabase/tests/plans-autopay-platform.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIG_W = fs.readFileSync(new URL('../migrations/20261009120000_hangtag_plans_autopay_platform.sql', import.meta.url), 'utf8');
const id = (n) => `aaaaaaaa-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), C = id(3), D = id(4), E = id(5), F = id(6), G = id(7);
const SUPER = id(11), ADM = id(12), BILL = id(13), SUP = id(14), RO = id(15), NOSTAFF = id(16), SUPER2 = id(17);
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider text, email text);
CREATE TABLE auth.sessions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`;
const db = new PGlite();
async function as(who, sql, params) {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (who, sql, params) => { try { return { r: (await as(who, sql, params)).rows }; } catch (e) { return { err: e.message, code: e.code }; } };
async function asService(sql, params) {
  await db.exec('SET ROLE service_role');
  await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('RESET ROLE'); }
}
const tryService = async (sql, params) => { try { return { r: await asService(sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const sql = async (q, p) => (await db.query(q, p)).rows;   // the SQL Editor (trusted)
const val = async (who, q, p) => { const r = await tryAs(who, q, p); return r.err ? r : Object.values(r.r[0])[0]; };
const status = (who) => val(who, `SELECT public.hangtag_subscription_status()`);
const plans = (who) => val(who, `SELECT public.hangtag_subscription_plans()`);
const quote = (who, plan, promo = null) => val(who, `SELECT public.hangtag_subscription_quote($1, $2)`, [plan, promo]);
const checkout = (who, plan, promo = null) => val(who, `SELECT public.hangtag_subscription_checkout($1, $2, 'razorpay')`, [plan, promo]);
const activate = async (pid, ref, amount) => { const r = await tryService(`SELECT public.hangtag_subscription_activate($1, $2, $3) AS a`, [pid, ref, amount]); return r.err ? r : r.r[0].a; };
const event = async (sub, ev, pay = null, amount = null) => { const r = await tryService(`SELECT public.hangtag_autopay_event('razorpay', $1, $2, $3, $4) AS e`, [sub, ev, pay, amount]); return r.err ? r : r.r[0].e; };
const write = (who, pid) => tryAs(who, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ($1, 'P', 10, '{"opts":[]}'::jsonb)`, [pid]);
const HT402 = (r) => r && r.code === 'HT402';
const denied = (r) => r && (r.code === '42501' || /permission denied/.test(r.err || ''));
const payRow = async (pid) => (await sql(`SELECT * FROM public.hangtag_subscription_payments WHERE id = $1`, [pid]))[0];
const sub = async (o) => (await sql(`SELECT * FROM public.hangtag_subscriptions WHERE owner_id = $1`, [o]))[0];
const onboard = (o, name) => as(o, `UPDATE public.hangtag_profiles SET shop_name = $2, business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [o, name]);
const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;

await db.exec(SUPABASE);
await db.exec(NEW);
await db.exec(MIG_W); await db.exec(MIG_W);   // the migration on top of schema.sql, twice: safe to run again
for (const [u, e] of [[A, 'a@shop.test'], [B, 'b@shop.test'], [C, 'c@shop.test'], [D, 'd@shop.test'], [E, 'e@shop.test'], [F, 'f@shop.test'], [G, 'g@shop.test'],
  [SUPER, 'boss@hangtag.test'], [ADM, 'admin@hangtag.test'], [BILL, 'billing@hangtag.test'], [SUP, 'support@hangtag.test'], [RO, 'viewer@hangtag.test'],
  [NOSTAFF, 'someone@hangtag.test'], [SUPER2, 'boss2@hangtag.test']]) await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [u, e]);

console.log('=== Phase 53: the plans and the trial come from the database ===');
{
  await onboard(A, 'Aura');
  const p = await plans(A);
  check('plans on sale, in display order: Monthly 999, 3 Months 2499, 6 Months 4499, 12 Months 7999',
    JSON.stringify(p.map((x) => [x.code, x.label, x.months, +x.price])) === JSON.stringify([['m1', 'Monthly', 1, 999], ['m3', '3 Months', 3, 2499], ['m6', '6 Months', 6, 4499], ['m12', '12 Months', 12, 7999]]), p);
  const s = await status(A);
  check('the free trial starts when setup is finished: 30 days, lifecycle "trial"', s.state === 'trial_active' && s.lifecycle === 'trial' && s.days_left === 30 && days(s.trial_started_at, s.trial_ends_at) === 30, s);
  check('…without AutoPay set up for Hangtag, nothing waits for it (the trial is used at once)', s.autopay && s.autopay.required === false && s.autopay.status === 'none', s.autopay);
  const m3 = p.find((x) => x.code === 'm3'), m1 = p.find((x) => x.code === 'm1');
  check('the launch offer is offered on 3 Months to a new customer: 999, 100 places left', m3.offer && m3.offer.code === 'LAUNCH100' && m3.offer.title === 'Launch offer'
    && +m3.offer.price === 999 && +m3.offer.discount === 1500 && m3.offer.remaining === 100 && m1.offer === null, { m3, m1 });
  const q = await quote(A, 'm3');
  check('the quote applies it by itself (no code typed): 2499 − 1500 = 999', +q.price === 2499 && +q.discount === 1500 && +q.amount === 999 && q.promo.auto === true && q.promo.code === 'LAUNCH100', q);
  check('…and not to another plan', +(await quote(A, 'm1')).amount === 999 && (await quote(A, 'm1')).promo === null);
  await sql(`UPDATE public.hangtag_plans SET days = 45 WHERE code = 'trial'`);
  await db.exec(MIG_W);
  check('a trial length changed in the database is kept when the migration runs again', (await sql(`SELECT days FROM public.hangtag_plans WHERE code = 'trial'`))[0].days === 45);
  await sql(`UPDATE public.hangtag_plans SET days = 30 WHERE code = 'trial'`);
  const r = await tryAs(A, `UPDATE public.hangtag_promo_codes SET max_uses = 100000 WHERE code = 'LAUNCH100'`);
  check('no app user can change a campaign', denied(r), r);
}

console.log('=== Phase 53: the launch offer is counted and its hard cap holds ===');
{
  await sql(`UPDATE public.hangtag_promo_codes SET max_uses = 3 WHERE code = 'LAUNCH100'`);   // the cap is data (100 at launch)
  const ca = await checkout(A, 'm3');
  check('checkout with the offer: the database records 999 and the offer', +ca.amount === 999 && ca.promo_code === 'LAUNCH100', ca);
  const aa = await activate(ca.payment_id, 'pay_A', 999);
  const c0 = (await sql(`SELECT redeemed FROM public.hangtag_promo_codes WHERE code = 'LAUNCH100'`))[0].redeemed;
  const ra = await payRow(ca.payment_id);
  check('paid: 3 months from the end of the trial, the counter goes to 1, the money is captured', aa.ok && aa.plan_code === 'm3' && c0 === 1 && !!ra.captured_at && ra.kind === 'one_time', { aa, c0, ra });
  check('a customer who paid is not new any more: no offer for them (typed or not)', (await plans(A)).find((x) => x.code === 'm3').offer === null
    && (await quote(A, 'm3', 'LAUNCH100')).promo.reason === 'not_new', await quote(A, 'm3', 'LAUNCH100'));
  for (const [o, n] of [[B, 'Bee'], [C, 'Cee'], [D, 'Dee']]) await onboard(o, n);
  const cb = await checkout(B, 'm3'), cc = await checkout(C, 'm3');
  check('two more shops check out with it (3 places: 1 paid, 2 held now)', cb.promo_code === 'LAUNCH100' && cc.promo_code === 'LAUNCH100', { cb, cc });
  const qd = await quote(D, 'm3'), pd = (await plans(D)).find((x) => x.code === 'm3');
  check('a fourth shop, while those pages are open: no offer (fully claimed) — the full price, no error', qd.promo === null && +qd.amount === 2499 && pd.offer === null, { qd, pd });
  const typed = await quote(D, 'm3', 'launch100');
  check('…and typed, it says so', typed.promo.valid === false && typed.promo.reason === 'used_up' && /fully claimed/.test(typed.promo.message), typed.promo);
  // C's page is left open past the hold; D takes the place; then both pay
  await sql(`UPDATE public.hangtag_subscription_payments SET created_at = NOW() - interval '31 minutes' WHERE id = $1`, [cc.payment_id]);
  const cd = await checkout(D, 'm3');
  check('an abandoned checkout stops holding its place: D gets the offer', cd.promo_code === 'LAUNCH100' && +cd.amount === 999, cd);
  const ab = await activate(cb.payment_id, 'pay_B', 999), ad = await activate(cd.payment_id, 'pay_D', 999);
  const full = (await sql(`SELECT redeemed, max_uses FROM public.hangtag_promo_codes WHERE code = 'LAUNCH100'`))[0];
  check('B and D paid: 3 redeemed of 3', ab.ok && ad.ok && full.redeemed === 3 && full.max_uses === 3, { ab, ad, full });
  const ac = await activate(cc.payment_id, 'pay_C', 999);
  const rc = await payRow(cc.payment_id), after = (await sql(`SELECT redeemed FROM public.hangtag_promo_codes WHERE code = 'LAUNCH100'`))[0].redeemed;
  const reds = (await sql(`SELECT count(*)::int n FROM public.hangtag_promo_redemptions WHERE code = 'LAUNCH100'`))[0].n;
  check('C pays after it filled up: the money is honoured as the plan it pays for (Monthly), never as a 4th redemption', ac.ok && ac.offer_full === true
    && rc.plan_code === 'm1' && rc.promo_code === null && +rc.price === 999 && +rc.discount === 0 && /Offer full when paid/.test(rc.note || '') && after === 3 && reds === 3, { ac, rc, after, reds });
  const sc = await status(C);
  check('…C gets one paid month after its trial, no lost days', sc.state === 'paid_active' && sc.plan_code === 'm1' && Math.round(days(sc.period_start, sc.period_end)) >= 28, sc);
  const over = await tryService(`UPDATE public.hangtag_promo_codes SET redeemed = 4 WHERE code = 'LAUNCH100'`);
  check('the table itself refuses a counter above the cap (even for a trusted caller)', !!over.err && /hangtag_promo_codes_redeemed_check/.test(over.err), over);
  const low = await tryService(`UPDATE public.hangtag_promo_codes SET max_uses = 2 WHERE code = 'LAUNCH100'`);
  check('…and a cap below what was redeemed', !!low.err, low);
}

console.log('=== Phase 54: AutoPay — required for new trials once Hangtag has set it up ===');
let subF;
{
  await onboard(E, 'Eee');
  check('a trial that began before AutoPay was switched on keeps working without it', (await status(E)).state === 'trial_active' && (await sub(E)).autopay_required === false);
  await sql(`UPDATE public.hangtag_platform_config SET autopay_enabled = TRUE`);
  await onboard(F, 'Fff');
  const s = await status(F);
  check('a new trial waits for AutoPay: state trial_setup, lifecycle autopay_required', s.state === 'trial_setup' && s.lifecycle === 'autopay_required' && s.autopay.required === true && s.days_left === 0, s);
  check('…and the shop\'s writes are refused (HT402) until AutoPay is set up', HT402(await write(F, 'f1')));
  const t = await val(F, `SELECT public.hangtag_autopay_quote()`);
  check('the AutoPay terms: nothing today, Monthly at 999 after the trial, from the trial\'s end', t.available === true && +t.today === 0 && +t.price === 999 && t.plan.code === 'm1'
    && new Date(t.first_charge_at).getTime() === new Date(s.trial_ends_at).getTime() && t.consent_version === 'autopay-2026-10', t);
  const noC = await tryAs(F, `SELECT public.hangtag_autopay_begin(false, 'autopay-2026-10')`), oldV = await tryAs(F, `SELECT public.hangtag_autopay_begin(true, 'autopay-2020')`);
  check('AutoPay needs the owner\'s consent to the current terms', /Agree to the AutoPay terms/.test(noC.err || '') && /Agree to the AutoPay terms/.test(oldV.err || ''), { noC, oldV });
  const anon = await tryAs(null, `SELECT public.hangtag_autopay_begin(true, 'autopay-2026-10')`), other = await tryAs(NOSTAFF, `SELECT public.hangtag_autopay_quote()`);
  check('…a signed-out visitor can\'t start it; another account only ever sees terms for its own shop', denied(anon) && !other.err && other.r[0].hangtag_autopay_quote.status === 'none', { anon, other });
  const b = await val(F, `SELECT public.hangtag_autopay_begin(true, 'autopay-2026-10')`);
  const row = await sub(F);
  check('consent recorded (when, which terms); AutoPay waits for the provider (pending)', b.owner === F && row.autopay_status === 'pending' && !!row.autopay_consent_at
    && row.autopay_consent_version === 'autopay-2026-10' && row.autopay_plan_code === 'm1', row);
  for (const q of [`SELECT public.hangtag_autopay_attach($1, 'razorpay', 'sub_fake')`, `SELECT public.hangtag_autopay_event('razorpay', 'sub_fake', 'authenticated')`,
    `SELECT public.hangtag_autopay_event('razorpay', 'sub_fake', 'charged', 'pay_x', 999)`]) {
    const r = await tryAs(F, q, q.includes('$1') ? [F] : undefined);
    check(`the app can't call ${q.match(/hangtag_\w+/)[0]} (only the provider's report, through the service role)`, denied(r), r);
  }
  const upd = await tryAs(F, `UPDATE public.hangtag_subscriptions SET autopay_status = 'active', autopay_authorized_at = NOW()`);
  check('…nor mark its own AutoPay on', denied(upd), upd);
  subF = 'sub_F' + Date.now();
  const at = await tryService(`SELECT public.hangtag_autopay_attach($1, 'razorpay', $2, 'cust_F')`, [F, subF]);
  check('the provider\'s subscription (the mandate) is stored with the shop', !at.err && (await sub(F)).autopay_subscription_id === subF && (await sub(F)).autopay_customer_id === 'cust_F', at);
  const ck = await checkout(F, 'm1');
  check('paying for a plan while AutoPay is being set up is refused (no double payment)', /Turn AutoPay off/.test(ck.err || ''), ck);
  const e1 = await event(subF, 'authenticated');
  const s2 = await status(F);
  check('the provider confirms the mandate: the trial runs (lifecycle trial), writes work', e1.known && s2.state === 'trial_active' && s2.lifecycle === 'trial' && s2.autopay.status === 'active'
    && !(await write(F, 'f2')).err, { e1, s2 });
  check('no money counted for a trial or an AutoPay set-up', (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [F]))[0].n === 0);
  await sql(`UPDATE public.hangtag_subscriptions SET trial_ends_at = NOW() + interval '2 days' WHERE owner_id = $1`, [F]);
  check('the last days of the trial: lifecycle trial_ending (with the next charge date)', (await status(F)).lifecycle === 'trial_ending' && !!(await status(F)).autopay.next_charge_at, await status(F));
  await sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '30 days', trial_ends_at = NOW() - interval '5 minutes' WHERE owner_id = $1`, [F]);
  const s3 = await status(F);
  check('the trial ended and the provider is collecting: access kept (renewal_due, renewing) — writes work', s3.state === 'renewal_due' && s3.lifecycle === 'renewing' && !(await write(F, 'f3')).err, s3);
  const bad = await event(subF, 'charged', null, 999), zero = await event(subF, 'charged', 'pay_z', 0);
  check('a charge needs the provider\'s payment and a real amount', /payment and its amount/.test(bad.err || '') && /payment and its amount/.test(zero.err || ''), { bad, zero });
  const ch = await event(subF, 'charged', 'pay_F1', 999);
  const pays = await sql(`SELECT * FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [F]);
  const s4 = await status(F);
  check('the provider captured 999: one AutoPay payment, captured, a paid month (state paid_active, lifecycle active)', ch.known && pays.length === 1 && pays[0].kind === 'autopay'
    && pays[0].status === 'paid' && !!pays[0].captured_at && +pays[0].amount === 999 && pays[0].provider_payment_id === 'pay_F1' && s4.state === 'paid_active' && s4.lifecycle === 'active'
    && Math.round(days(s4.period_start, s4.period_end)) >= 28, { pays, s4 });
  const again = await event(subF, 'charged', 'pay_F1', 999);
  check('the same charge reported again changes nothing', again.already === true && (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [F]))[0].n === 1, again);
  await event(subF, 'pending');
  check('a renewal that fails: past_due (the provider retries), the paid month runs on', (await status(F)).lifecycle === 'past_due' && (await sub(F)).autopay_status === 'past_due');
  await sql(`UPDATE public.hangtag_subscriptions SET period_end = NOW() - interval '1 hour', period_start = NOW() - interval '31 days' WHERE owner_id = $1`, [F]);
  const s5 = await status(F);
  check('…the month ended while it retries: access kept for the grace hours (renewal_due, past_due)', s5.state === 'renewal_due' && s5.lifecycle === 'past_due' && !(await write(F, 'f4')).err, s5);
  await event(subF, 'halted');
  const s6 = await status(F);
  check('the provider gives up (halted): locked at once, lifecycle halted', s6.state === 'paid_expired' && s6.lifecycle === 'halted' && HT402(await write(F, 'f5')), s6);
  const ck2 = await checkout(F, 'm1');
  check('…and the owner can pay for a plan by hand', !ck2.err && +ck2.amount === 999, ck2);
  const unk = await event('sub_nobody', 'charged', 'pay_n', 999);
  check('a report about AutoPay Hangtag doesn\'t know changes nothing', unk.known === false && (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE provider_payment_id = 'pay_n'`))[0].n === 0, unk);
}

console.log('=== Phase 54: cancel any time before the renewal ===');
{
  await onboard(G, 'Gee');
  await val(G, `SELECT public.hangtag_autopay_begin(true, 'autopay-2026-10')`);
  const subG = 'sub_G' + Date.now();
  await asService(`SELECT public.hangtag_autopay_attach($1, 'razorpay', $2)`, [G, subG]);
  await event(subG, 'authenticated');
  const req = await val(G, `SELECT public.hangtag_autopay_cancel_request()`);
  check('the owner asks to cancel: the function is given the provider\'s subscription to cancel', req.ok && req.subscription_id === subG && req.provider === 'razorpay', req);
  const e = await event(subG, 'cancelled');
  const s = await status(G);
  check('cancelled during the trial: the trial runs to its end (lifecycle cancelled), no charge', e.known && s.state === 'trial_active' && s.lifecycle === 'cancelled' && s.autopay.status === 'cancelled'
    && !s.autopay.next_charge_at && !(await write(G, 'g1')).err, s);
  const twice = await tryAs(G, `SELECT public.hangtag_autopay_cancel_request()`);
  check('…cancelling again: "AutoPay isn\'t on"', /isn't on/.test(twice.err || ''), twice);
  await sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '30 days', trial_ends_at = NOW() - interval '1 minute' WHERE owner_id = $1`, [G]);
  const s2 = await status(G);
  check('…then it ends like any trial: expired and locked, nothing charged', s2.state === 'trial_expired' && s2.lifecycle === 'expired' && HT402(await write(G, 'g2'))
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [G]))[0].n === 0, s2);
  const late = await event(subG, 'charged', 'pay_G_late', 999);
  check('a charge the provider still reports after the cancel is recorded and honoured (the money was taken), AutoPay stays off',
    late.known && (await sub(G)).autopay_status === 'cancelled' && (await status(G)).state === 'paid_active', late);
  const cap = await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE captured_at IS NOT NULL AND (amount <= 0 OR provider IN ('manual', 'free') OR status <> 'paid')`);
  check('money is counted as received only for amounts the provider captured (never a trial, a set-up, a free promo or a grant)', cap[0].n === 0, cap);
}

console.log('=== Phase 55: the Platform Console — roles by account id, checked by every function ===');
{
  await sql(`INSERT INTO public.hangtag_platform_staff (user_id, role, display_name) VALUES ($1, 'super_admin', 'Boss')`, [SUPER]);   // the first super admin (SQL Editor)
  const w0 = await val(NOSTAFF, `SELECT public.hangtag_platform_whoami()`);
  await val(NOSTAFF, `SELECT public.hangtag_platform_whoami()`);
  const den = await sql(`SELECT * FROM public.hangtag_platform_audit WHERE action = 'console.denied' AND actor = $1`, [NOSTAFF]);
  check('an account without a console role: { staff: false } with its own account id, the attempt noted once', w0.staff === false && w0.account === NOSTAFF && den.length === 1 && den[0].ok === false, { w0, den });
  check('signed out: the console\'s functions can\'t even be called',denied(await tryAs(null, `SELECT public.hangtag_platform_whoami()`)));
  const w = await val(SUPER, `SELECT public.hangtag_platform_sign_in()`);
  check('the super admin signs in (noted): role and its permissions', w.staff === true && w.role === 'super_admin' && w.permissions.includes('staff.manage') && w.permissions.includes('settings.manage')
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit WHERE action = 'console.sign_in' AND actor = $1`, [SUPER]))[0].n === 1, w);
  for (const [u, r] of [[ADM, 'admin'], [BILL, 'billing_admin'], [SUP, 'support_admin'], [RO, 'read_only']]) {
    const x = await tryAs(SUPER, `SELECT public.hangtag_platform_staff_save($1, $2, true, NULL)`, [u, r]);
    if (x.err) check(`super admin gives ${r}`, false, x);
  }
  const roles = await sql(`SELECT role FROM public.hangtag_platform_staff ORDER BY role`);
  check('the super admin gives each role by account id (no email involved), each change in the audit log', roles.length === 5
    && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit WHERE action = 'staff.update'`))[0].n === 4, roles);
  const perms = {};
  for (const u of [ADM, BILL, SUP, RO]) perms[u] = (await val(u, `SELECT public.hangtag_platform_whoami()`)).permissions;
  check('admin: everything but Hangtag\'s settings', perms[ADM].includes('staff.manage') && perms[ADM].includes('audit.view') && !perms[ADM].includes('settings.manage'));
  check('billing admin: plans, promotions, payments — not the audit log, staff or settings', perms[BILL].includes('promotions.manage') && perms[BILL].includes('plans.manage')
    && perms[BILL].includes('payments.view') && !perms[BILL].includes('audit.view') && !perms[BILL].includes('staff.manage') && !perms[BILL].includes('settings.view'));
  check('support admin: customers, health, diagnostics — no promotions', perms[SUP].includes('diagnostics.view') && !perms[SUP].includes('promotions.view'));
  check('read only: views, nothing that changes', perms[RO].every((p) => p.endsWith('.view')));

  const dash = await val(RO, `SELECT public.hangtag_platform_dashboard()`);
  const truth = (await sql(`SELECT COALESCE(sum(amount), 0)::numeric AS s, count(*)::int AS n FROM public.hangtag_subscription_payments WHERE captured_at IS NOT NULL
      AND captured_at >= (date_trunc('month', NOW() AT TIME ZONE 'Asia/Kolkata')) AT TIME ZONE 'Asia/Kolkata'`))[0];
  const offer = dash.offers.find((o) => o.code === 'LAUNCH100');
  check('the dashboard (every role): totals from the database — shops, plans, AutoPay, money captured this month, the offer\'s counter',
    dash.shops.total === 7 && +dash.revenue.month === +truth.s && dash.revenue.month_count === truth.n && offer && offer.redeemed === 3 && offer.cap === 3
    && dash.subscriptions.autopay_cancelled === 1 && typeof dash.usage.bills_24h === 'number', { dash, truth });
  check('…never a shop\'s own rows (no names, emails or ids in it)', !/@shop\.test|Aura|aaaaaaaa-0000-0000-0000-000000000001/.test(JSON.stringify(dash)));
  for (const [who, label] of [[A, 'a shop owner'], [null, 'a signed-out visitor'], [NOSTAFF, 'an account without a role']]) {
    const r = await tryAs(who, `SELECT public.hangtag_platform_dashboard()`);
    check(`${label} can't open the dashboard`, denied(r), r);
  }
  const prRO = await tryAs(RO, `SELECT public.hangtag_platform_promotions()`), prSUP = await tryAs(SUP, `SELECT public.hangtag_platform_promotions()`);
  check('promotions: read only may look; support may not', !prRO.err && prRO.r[0].hangtag_platform_promotions.campaigns.some((c) => c.code === 'LAUNCH100') && denied(prSUP), { prSUP });
  const saveRO = await tryAs(RO, `SELECT public.hangtag_platform_campaign_save('LAUNCH100', '{"max_uses": 500}')`);
  check('read only can\'t change a campaign', denied(saveRO), saveRO);
  const below = await tryAs(BILL, `SELECT public.hangtag_platform_campaign_save('LAUNCH100', '{"max_uses": 1}')`);
  const unknownField = await tryAs(BILL, `SELECT public.hangtag_platform_campaign_save('LAUNCH100', '{"redeemed": 0}')`);
  const badVal = await tryAs(BILL, `SELECT public.hangtag_platform_campaign_save('LAUNCH100', '{"max_uses": "lots"}')`);
  check('a campaign\'s counter can\'t be edited, its cap can\'t go below the redemptions, values are checked', /below the 3 already redeemed/.test(below.err || '')
    && /no field "redeemed"/.test(unknownField.err || '') && /Check the values/.test(badVal.err || ''), { below, unknownField, badVal });
  const ok = await tryAs(BILL, `SELECT public.hangtag_platform_campaign_save('launch100', '{"max_uses": 100, "ends_at": "2027-01-31T18:29:59Z", "title": "Launch offer"}')`);
  const log = (await sql(`SELECT * FROM public.hangtag_platform_audit WHERE action = 'promotion.update' ORDER BY id DESC LIMIT 1`))[0];
  check('the billing admin raises the cap to 100 and sets an end: saved, and the audit log keeps before and after', !ok.err && log && log.actor === BILL && log.actor_role === 'billing_admin'
    && log.detail.before.max_uses === 3 && log.detail.after.max_uses === 100 && !!log.detail.after.ends_at, { ok, log });
  const plan = await tryAs(BILL, `SELECT public.hangtag_platform_plan_save('m6', '{"price": 4599}')`), apOff = await tryAs(BILL, `SELECT public.hangtag_platform_plan_save('m1', '{"active": false}')`);
  check('a plan\'s price is changed in the console (audited); the plan AutoPay renews stays on sale', !plan.err && +(await sql(`SELECT price FROM public.hangtag_plans WHERE code = 'm6'`))[0].price === 4599
    && /stays on sale/.test(apOff.err || '') && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit WHERE action = 'plan.update'`))[0].n === 1, { plan, apOff });
  await sql(`UPDATE public.hangtag_plans SET price = 4499 WHERE code = 'm6'`);
  const setB = await tryAs(BILL, `SELECT public.hangtag_platform_settings()`), setA = await val(ADM, `SELECT public.hangtag_platform_settings()`);
  const saveA = await tryAs(ADM, `SELECT public.hangtag_platform_settings_save('{"trial_ending_days": 5}')`);
  check('Hangtag\'s settings: the billing admin can\'t see them; an admin sees but can\'t change them', denied(setB) && setA.can_manage === false && setA.autopay_enabled === true && denied(saveA), { setB, setA, saveA });
  const saveS = await val(SUPER, `SELECT public.hangtag_platform_settings_save('{"trial_ending_days": 5}')`);
  check('…the super admin changes them (audited)', saveS.trial_ending_days === 5 && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit WHERE action = 'settings.update'`))[0].n === 1, saveS);
  const mkSuper = await tryAs(ADM, `SELECT public.hangtag_platform_staff_save($1, 'super_admin', true, NULL)`, [SUPER2]);
  const demote = await tryAs(ADM, `SELECT public.hangtag_platform_staff_save($1, 'read_only', true, NULL)`, [SUPER]);
  const mkSup = await tryAs(ADM, `SELECT public.hangtag_platform_staff_save($1, 'support_admin', true, 'Desk')`, [SUPER2]);
  check('an admin can give support roles, never admin or super admin, nor change one', denied(mkSuper) && denied(demote) && !mkSup.err, { mkSuper, demote, mkSup });
  const self = await tryAs(SUPER, `SELECT public.hangtag_platform_staff_save($1, 'read_only', true, NULL)`, [SUPER]);
  const nobody = await tryAs(SUPER, `SELECT public.hangtag_platform_staff_save($1, 'admin', true, NULL)`, ['bbbbbbbb-0000-0000-0000-000000000000']);
  check('nobody changes their own access; an unknown account id is refused', /own console access/.test(self.err || '') && /No Hangtag account has that id/.test(nobody.err || ''), { self, nobody });
  await sql(`UPDATE public.hangtag_platform_staff SET role = 'super_admin' WHERE user_id = $1`, [SUPER2]);
  const demoted = await tryAs(SUPER2, `SELECT public.hangtag_platform_staff_save($1, 'admin', true, NULL)`, [SUPER]);
  const last = await tryAs(SUPER2, `SELECT public.hangtag_platform_staff_save($1, 'admin', true, NULL)`, [SUPER2]);
  check('with two super admins one may change the other; the one left can\'t change their own access, so a super admin always stays',
    !demoted.err && /own console access/.test(last.err || '') && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_staff WHERE role = 'super_admin' AND active`))[0].n === 1, { demoted, last });
  await sql(`UPDATE public.hangtag_platform_staff SET role = 'super_admin' WHERE user_id = $1`, [SUPER]);
  const audit = await val(ADM, `SELECT public.hangtag_platform_audit_list(5, NULL)`), auditB = await tryAs(BILL, `SELECT public.hangtag_platform_audit_list(5, NULL)`);
  check('the audit log, newest first, with who did it (admins only)', audit.length === 5 && audit[0].id > audit[4].id && audit.some((x) => x.actor_email) && denied(auditB), { auditB });
  await tryAs(SUPER, `SELECT public.hangtag_platform_staff_save($1, 'read_only', false, NULL)`, [RO]);
  check('a switched-off staff account is out at once', (await val(RO, `SELECT public.hangtag_platform_whoami()`)).staff === false && denied(await tryAs(RO, `SELECT public.hangtag_platform_dashboard()`)));
}

console.log('=== Phase 55: the shops\' data stays theirs ===');
{
  for (const t of ['hangtag_platform_staff', 'hangtag_platform_audit', 'hangtag_platform_config']) {
    const st = await tryAs(SUPER, `SELECT * FROM public.${t}`), sh = await tryAs(A, `SELECT * FROM public.${t}`), w = await tryAs(SUPER, `INSERT INTO public.hangtag_platform_audit (action) VALUES ('x.fake')`);
    check(`${t}: no direct reads or writes, not even by staff (only through the console's functions)`, denied(st) && denied(sh) && denied(w), { st, sh, w });
  }
  await as(A, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1', 'Asha', '9876543210')`);
  const seen = (await as(SUPER, `SELECT count(*)::int n FROM public.hangtag_customers`)).rows[0].n, own = (await as(A, `SELECT count(*)::int n FROM public.hangtag_customers`)).rows[0].n;
  check('a staff account reads no shop\'s data (row security as before); the shop still reads its own', seen === 0 && own === 1, { seen, own });
  const promote = await tryAs(A, `SELECT public.hangtag_platform_staff_save($1, 'super_admin', true, NULL)`, [A]);
  check('a shop owner can\'t give themselves a console role', denied(promote), promote);
  const defs = await sql(`SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND (p.proname LIKE 'hangtag_platform%' OR p.proname LIKE 'hangtag_autopay%' OR p.proname = 'hangtag_offer_for') AND p.proname <> 'hangtag_platform_permissions'`);
  check('every console and AutoPay function is SECURITY DEFINER with search_path = \'\'', defs.length >= 18 && defs.every((d) => d.prosecdef && /search_path=""/.test(d.cfg)), defs.filter((d) => !d.prosecdef || !/search_path=""/.test(d.cfg)));
  const rep = (await db.query(`SELECT check_name, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
  const mine = rep.filter((r) => /Plans on sale|trial lasts 30|Capped offers|AutoPay: each shop|Platform Console tables|Platform Console and AutoPay|Money counted/.test(r.check_name));
  check('the report: rows 80-86 all ok', mine.length === 7 && mine.every((r) => r.ok), mine);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
