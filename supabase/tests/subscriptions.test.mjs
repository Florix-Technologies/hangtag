// Plans, subscriptions, promo codes and the access lock (schema.sql section 3t, migration
// 20261006120000_hangtag_plans_subscriptions.sql). A paid-access boundary, tested as an attacker would try it:
// the trial (7 days from the end of shop setup, one per email, none for team members), the states, the status the app
// reads, promo codes checked only here, payments created with the price computed here and activated only by the trusted
// service role, calendar-month periods that never lose paid days, the lock on every business write (direct and through
// SECURITY DEFINER functions), reads that keep working, renewal that opens everything again, the public store closing,
// and that no app user can read or write any of it directly.
// The prices and the trial length are data: these checks use their own (the 1, 3 and 6 months plans at 499, 1349 and 2499, a
// 7-day trial, no offer that applies by itself), set by fixtures() after each migration run. Section 3w's defaults (the
// 30-day trial, Monthly to 12 Months, the launch offer, AutoPay) are checked in plans-autopay-platform.test.mjs.
// Run: node supabase/tests/subscriptions.test.mjs
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import fs from 'fs';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs } from '../../src/infrastructure/supabase/mappers.js';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIG = fs.readFileSync(new URL('../migrations/20261006120000_hangtag_plans_subscriptions.sql', import.meta.url), 'utf8');
const MIG_W = fs.readFileSync(new URL('../migrations/20261009120000_hangtag_plans_autopay_platform.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const A2 = '55555555-5555-5555-5555-555555555555';   // a second account made later with A's email (other case and spaces)
const NEWSHOP = '66666666-6666-6666-6666-666666666666';
const MGR = { id: '33333333-3333-3333-3333-333333333333', key: 'dev-key-manager-000000000000000000', dev: 'dev-manager-1', role: 'manager', username: 'meera' };
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
async function as(db, who, sql, params) {
  const id = typeof who === 'string' ? who : who && who.id, key = who && typeof who === 'object' ? who.key : null;
  await db.exec(`SET ROLE ${id ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
    [id || '', key ? JSON.stringify({ authorization: 'Bearer x', 'x-hangtag-device': key }) : JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
async function asService(db, sql, params) {
  await db.exec('SET ROLE service_role');
  await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryService = async (db, sql, params) => { try { return { r: await asService(db, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const one = async (db, who, sql, params) => (await as(db, who, sql, params)).rows[0];
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const status = async (db, who) => (await one(db, who, `SELECT public.hangtag_subscription_status() AS s`)).s;
const quote = (db, who, plan, promo) => tryAs(db, who, `SELECT public.hangtag_subscription_quote($1, $2) AS q`, [plan, promo]);
const checkout = (db, who, plan, promo, prov = 'razorpay') => tryAs(db, who, `SELECT public.hangtag_subscription_checkout($1, $2, $3) AS c`, [plan, promo, prov]);
const activate = (db, pid, ref, amount) => tryService(db, `SELECT public.hangtag_subscription_activate($1, $2, $3) AS a`, [pid, ref, amount]);
const sql = async (db, q, p) => (await db.query(q, p)).rows;   // the SQL Editor (trusted)
const HT402 = (r) => r.code === 'HT402' && /HANGTAG_SUBSCRIPTION_INACTIVE/.test(r.err || '');
const denied = (r) => /permission denied/.test(r.err || '');
const iso = (v) => new Date(v).toISOString();
const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;

function bill(id, price) {
  const T = computeCheckout({ lines: [{ q: 1, price, rate: 0 }], billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, [{ method: 'cash', amount: T.total }], { customer: false });
  const L = T.lines[0];
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: [{ ln: 0, p: 'tee', v: 'tee:m', n: 'Tee', c: '', s: 'M', vl: 'M', ov: [], sku: '', q: 1, price, cost: null, dAmt: 0, bdAmt: 0, gst: 0, hsn: '6109', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total }],
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'cash', payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
const saveBill = (db, who, b) => tryAs(db, who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([billArgs(b)])]);

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'Owner@A.test'), ($2, 'owner@b.test'), ($3, 'meera@staff.hangtag.invalid')`, [A, B, MGR.id]);
await db.exec(NEW);
await db.exec(MIG);   // the migration runs on top of schema.sql, and again: safe to run twice
await db.exec(MIG);
await db.exec(MIG_W);   // then section 3w's (its functions are the current ones)
/* this test's own prices and trial (only where section 3w's defaults replaced them) */
async function fixtures() {
  await db.query(`UPDATE public.hangtag_plans p SET price = v.price FROM (VALUES ('m1', 999, 499), ('m3', 2499, 1349), ('m6', 4499, 2499)) v(code, now_price, price)
      WHERE p.code = v.code AND p.price = v.now_price`);
  await db.query(`UPDATE public.hangtag_plans p SET label = v.label FROM (VALUES ('m1', 'Monthly', '1 month'), ('m3', '3 Months', '3 months'), ('m6', '6 Months', '6 months'))
      v(code, now_label, label) WHERE p.code = v.code AND p.label = v.now_label`);
  await db.query(`UPDATE public.hangtag_plans SET days = 7 WHERE code = 'trial' AND days = 30`);
  await db.query(`UPDATE public.hangtag_plans SET active = false WHERE code = 'm12'`);
  await db.query(`UPDATE public.hangtag_promo_codes SET active = false WHERE code = 'LAUNCH100'`);
}
await fixtures();

console.log('=== the trial starts when the shop is set up, not at sign-up ===');
{
  const s0 = await status(db, A);
  check('signed up, setup not finished: no plan yet (state "none"), nothing locked', s0.state === 'none' && s0.is_owner === true, s0);
  check('…and no plan record was made at sign-up', (await sql(db, `SELECT count(*)::int n FROM public.hangtag_subscriptions`))[0].n === 0);
  await as(db, A, `UPDATE public.hangtag_profiles SET shop_name = 'Aura', business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [A]);
  const s = await status(db, A);
  check('setup finished: the free trial is running', s.state === 'trial_active' && s.days_left === 7 && s.plan_code === null, s);
  check('the trial is exactly 7 days', days(s.trial_started_at, s.trial_ends_at) === 7, s);
  check('access until = the trial end; the server\'s clock is given', iso(s.access_until) === iso(s.trial_ends_at) && !!s.server_now, s);
  await as(db, A, `UPDATE public.hangtag_profiles SET onboarded_at = NOW() + interval '1 day' WHERE id = $1`, [A]);
  const again = await status(db, A);
  check('finishing setup again does not start a new trial', iso(again.trial_started_at) === iso(s.trial_started_at), again);
}

console.log('=== team members have no trial of their own; one trial per email ===');
{
  await db.exec('SET ROLE service_role');
  await db.query(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1, $2, 'Meera', $3, $4, 'active', $2)`, [MGR.id, A, MGR.username, MGR.role]);
  await db.query(`INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Phone', 'Android', $4)`, [A, MGR.dev, MGR.id, hash(MGR.key)]);
  await db.exec('RESET ROLE');
  await sql(db, `UPDATE public.hangtag_profiles SET onboarded_at = NOW() WHERE id = $1`, [MGR.id]);
  check('a team member finishing a profile gets no plan record of its own', (await sql(db, `SELECT count(*)::int n FROM public.hangtag_subscriptions WHERE owner_id = $1`, [MGR.id]))[0].n === 0);
  const m = await status(db, MGR);
  const o = await status(db, A);
  check('a team member sees the SHOP\'s plan (not the owner)', m.state === 'trial_active' && m.is_owner === false && iso(m.trial_ends_at) === iso(o.trial_ends_at), m);
  // A deleted and made again with the same email (another case, spaces): the trial was used
  await sql(db, `INSERT INTO auth.users (id, email) VALUES ($1, '  owner@a.TEST ')`, [A2]);
  await as(db, A2, `UPDATE public.hangtag_profiles SET shop_name = 'Aura 2', onboarded_at = NOW() WHERE id = $1`, [A2]);
  const s2 = await status(db, A2);
  check('a second account with the same email: no second trial (it starts already over)', s2.state === 'trial_expired' && s2.days_left === 0, s2);
  await sql(db, `DELETE FROM auth.users WHERE id = $1`, [A2]);
  check('the email\'s trial stays claimed (by the first account) after the second account is deleted',
    (await sql(db, `SELECT owner_id FROM public.hangtag_trial_claims WHERE email_key = md5('owner@a.test')`))[0]?.owner_id === A);
}

console.log('=== a shop that never finishes setup cannot use Hangtag for free forever ===');
{
  await sql(db, `INSERT INTO auth.users (id, email) VALUES ($1, 'skip@setup.test')`, [NEWSHOP]);
  const r = await tryAs(db, NEWSHOP, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('x', 'X', 10, '{"opts":[]}'::jsonb)`);
  const s = await status(db, NEWSHOP);
  check('its first business write starts its trial (no setup needed to start the clock)', !r.err && (await sql(db, `SELECT count(*)::int n FROM public.hangtag_subscriptions WHERE owner_id = $1`, [NEWSHOP]))[0].n === 1, { r, s });
  await sql(db, `UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '8 days', trial_ends_at = NOW() - interval '1 day' WHERE owner_id = $1`, [NEWSHOP]);
  const w = await tryAs(db, NEWSHOP, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('y', 'Y', 10, '{"opts":[]}'::jsonb)`);
  check('…and is locked when that trial ends, setup or not', HT402(w), w);
  const u = await tryAs(db, NEWSHOP, `UPDATE public.hangtag_profiles SET onboarded_at = NULL WHERE id = $1`, [NEWSHOP]);
  const w2 = await tryAs(db, NEWSHOP, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('z', 'Z', 10, '{"opts":[]}'::jsonb)`);
  check('clearing "setup finished" on its profile does not unlock it', !u.err && HT402(w2), { u, w2 });
}

console.log('=== the shop sells during the trial ===');
await as(db, A, `INSERT INTO public.hangtag_products (id, name, price, cost_price, category, options) VALUES ('tee', 'Everyday Tee', 500, 200, 'Clothing', '{"opts":[{"name":"Size","values":["M"]}]}'::jsonb)`);
await as(db, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, price, cost_price, active) VALUES ('tee:m', 'tee', '["M"]', 500, 200, true)`);
await as(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('open:tee', 'tee:m', 'tee', 'OPENING', 20, 1)`);
await as(db, A, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1', 'Asha', '9876543210')`);
await as(db, A, `INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', '{"caps":{"uses_mobile_store":true,"uses_sales_orders":true},"capsAt":1}'::jsonb)`);
{
  const r = await saveBill(db, A, bill('b1', 500));
  check('a bill is saved during the trial (through hangtag_save_sales)', !r.err, r);
  const m = await saveBill(db, MGR, bill('b2', 500));
  check('…and by a team member of the shop', !m.err, m);
}
const token = (await one(db, A, `SELECT store_token FROM public.hangtag_profiles WHERE id = $1`, [A])).store_token;

console.log('=== plans and prices come from the database ===');
{
  const p = (await one(db, A, `SELECT public.hangtag_subscription_plans() AS p`)).p;
  check('three paid plans: 1, 3 and 6 months, with their prices', p.length === 3 && p.map((x) => x.months).join() === '1,3,6' && p.every((x) => +x.price > 0 && x.currency === 'INR'), p);
  await sql(db, `UPDATE public.hangtag_plans SET price = 599 WHERE code = 'm1'`);
  const p2 = (await one(db, A, `SELECT public.hangtag_subscription_plans() AS p`)).p;
  check('a price changed in the database is what the app gets', +p2[0].price === 599, p2[0]);
  await db.exec(MIG); await db.exec(MIG_W); await fixtures();
  check('running the migrations again keeps the changed price', +(await sql(db, `SELECT price FROM public.hangtag_plans WHERE code = 'm1'`))[0].price === 599);
  await sql(db, `UPDATE public.hangtag_plans SET price = 499 WHERE code = 'm1'`);
  const r = await tryAs(db, A, `UPDATE public.hangtag_plans SET price = 1 WHERE code = 'm1'`);
  const r2 = await tryAs(db, A, `INSERT INTO public.hangtag_plans (code, label, kind, months, price) VALUES ('cheap', 'Cheap', 'paid', 12, 1)`);
  check('no app user can change a price or add a plan', !!r.err && !!r2.err && +(await sql(db, `SELECT price FROM public.hangtag_plans WHERE code = 'm1'`))[0].price === 499, { r, r2 });
}

console.log('=== promo codes are checked by the database ===');
await sql(db, `INSERT INTO public.hangtag_promo_codes (code, kind, value, plans, starts_at, ends_at, max_uses, per_account_limit, active) VALUES
  ('LAUNCH20', 'percent', 20, NULL, NULL, NULL, NULL, 1, true),
  ('FLAT300', 'fixed', 300, NULL, NULL, NULL, NULL, 1, true),
  ('HUGE', 'fixed', 99999, '{m1}', NULL, NULL, NULL, 1, true),
  ('OLD', 'percent', 10, NULL, NOW() - interval '30 days', NOW() - interval '1 day', NULL, 1, true),
  ('SOON', 'percent', 10, NULL, NOW() + interval '1 day', NULL, NULL, 1, true),
  ('OFF', 'percent', 10, NULL, NULL, NULL, NULL, 1, false),
  ('SIXONLY', 'percent', 50, '{m6}', NULL, NULL, NULL, 1, true),
  ('ONE', 'percent', 10, NULL, NULL, NULL, 1, 5, true),
  ('TWICE', 'fixed', 50, NULL, NULL, NULL, NULL, 2, true)`);
{
  const q = async (plan, promo) => { const r = await quote(db, A, plan, promo); return r.err ? r : r.r.rows[0].q; };
  let x = await q('m3', null);
  check('no promo: price = amount (from the plan)', +x.price === 1349 && +x.discount === 0 && +x.amount === 1349 && x.promo === null && x.plan.months === 3, x);
  x = await q('m3', 'launch20');
  check('20% off, the code typed in lower case: discount 269.80, final 1079.20', x.promo.valid === true && +x.discount === 269.8 && +x.amount === 1079.2 && x.promo.code === 'LAUNCH20', x);
  x = await q('m1', ' FLAT300 ');
  check('a fixed discount (with spaces around the code)', x.promo.valid && +x.discount === 300 && +x.amount === 199, x);
  x = await q('m1', 'HUGE');
  check('a fixed discount larger than the price stops at the price (final 0, never negative)', x.promo.valid && +x.discount === 499 && +x.amount === 0, x);
  const reasons = {};
  for (const [code, plan] of [['NOPE', 'm1'], ['OFF', 'm1'], ['SOON', 'm1'], ['OLD', 'm1'], ['SIXONLY', 'm1'], ['bad code!', 'm1']]) reasons[code] = await q(plan, code);
  check('unknown code → invalid', reasons.NOPE.promo.valid === false && reasons.NOPE.promo.reason === 'invalid' && /isn't valid/.test(reasons.NOPE.promo.message) && +reasons.NOPE.amount === 499, reasons.NOPE);
  check('switched off → inactive', reasons.OFF.promo.reason === 'inactive' && /no longer active/.test(reasons.OFF.promo.message), reasons.OFF);
  check('not started → not_started', reasons.SOON.promo.reason === 'not_started' && /isn't active yet/.test(reasons.SOON.promo.message), reasons.SOON);
  check('ended → expired', reasons.OLD.promo.reason === 'expired' && /has expired/.test(reasons.OLD.promo.message), reasons.OLD);
  check('for another plan → not_for_plan, naming the plan', reasons.SIXONLY.promo.reason === 'not_for_plan' && /1 month/.test(reasons.SIXONLY.promo.message), reasons.SIXONLY);
  check('a malformed code → invalid (never an error)', reasons['bad code!'].promo.reason === 'invalid', reasons['bad code!']);
  check('a refused code never discounts', Object.values(reasons).every((r) => +r.discount === 0 && +r.amount === +r.price));
  const unk = await quote(db, A, 'trial', null), unk2 = await quote(db, A, 'gold', null);
  check('the trial or an unknown plan cannot be bought', /Choose a plan/.test(unk.err || '') && /Choose a plan/.test(unk2.err || ''), { unk, unk2 });
  const mq = await quote(db, MGR, 'm1', null), aq = await quote(db, null, 'm1', null), bq = await quote(db, MGR, 'm1', 'LAUNCH20');
  check('a team member cannot choose a plan; nor can a signed-out visitor', /Only the shop owner/.test(mq.err || '') && !!aq.err && !!bq.err, { mq, aq });
}

console.log('=== checkout: the database decides the amount ===');
let pay1;
{
  const r = await checkout(db, A, 'm3', 'LAUNCH20');
  pay1 = r.r && r.r.rows[0].c;
  const row = (await sql(db, `SELECT * FROM public.hangtag_subscription_payments WHERE id = $1`, [pay1 && pay1.payment_id]))[0];
  check('a payment with the server\'s price, discount and amount, status created', !r.err && row && +row.price === 1349 && +row.discount === 269.8 && +row.amount === 1079.2
    && row.promo_code === 'LAUNCH20' && row.status === 'created' && row.owner_id === A && row.provider === 'razorpay', { r, row });
  const bad = await checkout(db, A, 'm1', 'OLD');
  check('an invalid promo refuses the checkout with its message', /has expired/.test(bad.err || ''), bad);
  const m = await checkout(db, MGR, 'm1', null);
  check('a team member cannot check out', /Only the shop owner/.test(m.err || ''), m);
  const manual = await checkout(db, A, 'm1', null, 'manual'), free = await checkout(db, A, 'm1', null, 'free');
  check('the app cannot pick the "manual" or "free" provider', /way to pay/.test(manual.err || '') && /way to pay/.test(free.err || ''), { manual, free });
  const ins = await tryAs(db, A, `INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, discount, amount, provider, status) VALUES ($1, 'm6', 2499, 2499, 0, 'razorpay', 'paid')`, [A]);
  const upd = await tryAs(db, A, `UPDATE public.hangtag_subscription_payments SET amount = 1, discount = price - 1 WHERE id = $1`, [pay1.payment_id]);
  const st = await tryAs(db, A, `UPDATE public.hangtag_subscription_payments SET status = 'paid' WHERE id = $1`, [pay1.payment_id]);
  check('the app cannot add, change or mark a payment paid', denied(ins) && denied(upd) && denied(st), { ins, upd, st });
  const sub = await tryAs(db, A, `UPDATE public.hangtag_subscriptions SET period_end = NOW() + interval '10 years'`);
  const subi = await tryAs(db, A, `INSERT INTO public.hangtag_subscriptions (owner_id, trial_started_at, trial_ends_at) VALUES ($1, NOW(), NOW() + interval '10 years')`, [B]);
  const subd = await tryAs(db, A, `DELETE FROM public.hangtag_subscriptions`);
  check('the app cannot extend, add or remove a plan record', denied(sub) && denied(subi) && denied(subd), { sub, subi, subd });
  const pc = await tryAs(db, A, `SELECT * FROM public.hangtag_promo_codes`), pci = await tryAs(db, A, `INSERT INTO public.hangtag_promo_codes (code, kind, value) VALUES ('MINE', 'percent', 100)`);
  const red = await tryAs(db, A, `INSERT INTO public.hangtag_promo_redemptions (payment_id, code, owner_id) VALUES ($1, 'LAUNCH20', $2)`, [pay1.payment_id, A]);
  check('the app cannot read or add promo codes, or record a redemption', denied(pc) && denied(pci) && denied(red), { pc, pci, red });
  const own = (await as(db, A, `SELECT id FROM public.hangtag_subscription_payments`)).rows;
  const theirs = (await as(db, B, `SELECT id FROM public.hangtag_subscription_payments`)).rows;
  const mgr = (await as(db, MGR, `SELECT id FROM public.hangtag_subscription_payments`)).rows;
  check('the owner reads the shop\'s plan payments; another shop and a team member see none', own.length === 1 && theirs.length === 0 && mgr.length === 0, { own, theirs, mgr });
  for (const fn of [`SELECT public.hangtag_subscription_activate($1, 'pay_x', 1079.2)`, `SELECT public.hangtag_subscription_attach($1, 'razorpay', 'plink_x')`,
    `SELECT public.hangtag_subscription_fail($1, 'failed')`]) {
    const r1 = await tryAs(db, A, fn, [pay1.payment_id]), r2 = await tryAs(db, null, fn, [pay1.payment_id]);
    check(`the app cannot call ${fn.match(/hangtag_\w+/)[0]} (service role only)`, denied(r1) && denied(r2), { r1, r2 });
  }
  const ag = await tryAs(db, A, `SELECT public.hangtag_admin_grant($1, 'm6', 'me')`, [A]), sus = await tryAs(db, A, `SELECT public.hangtag_admin_suspend($1, false, NULL)`, [A]);
  const en = await tryAs(db, A, `SELECT public.hangtag_subscription_ensure($1)`, [B]), ex = await tryAs(db, A, `SELECT public.hangtag_subscription_extend($1, 'm6')`, [A]);
  check('nor the admin helpers or the internal ones', denied(ag) && denied(sus) && denied(en) && denied(ex), { ag, sus, en, ex });
}

console.log('=== activation: only the provider\'s confirmation, exact amount, calendar months, no lost days ===');
{
  const before = await status(db, A);
  const wrong = await activate(db, pay1.payment_id, 'pay_A1', 1);
  check('a different amount is refused', /not the amount due/.test(wrong.err || ''), wrong);
  const noref = await activate(db, pay1.payment_id, '', 1079.2);
  check('a paid amount without the provider\'s reference is refused', /reference is missing/.test(noref.err || ''), noref);
  const ok = await activate(db, pay1.payment_id, 'pay_A1', 1079.2);
  const a = ok.r && ok.r.rows[0].a;
  check('the confirmed payment activates 3 months', !ok.err && a.ok && a.state === 'paid_active' && a.plan_code === 'm3' && a.already === false, ok);
  check('…starting when the running trial ends (paying early never loses trial days)', iso(a.period_start) === iso(before.trial_ends_at), { a, before });
  const end = new Date(before.trial_ends_at); end.setUTCMonth(end.getUTCMonth() + 3);
  check('…and ending 3 calendar months later', iso(a.period_end) === iso(end), { a, end });
  const again = await activate(db, pay1.payment_id, 'pay_A1', 1079.2);
  check('activating again changes nothing (idempotent)', !again.err && again.r.rows[0].a.already === true && iso(again.r.rows[0].a.period_end) === iso(a.period_end), again);
  const red = await sql(db, `SELECT * FROM public.hangtag_promo_redemptions WHERE payment_id = $1`, [pay1.payment_id]);
  check('the promo use is recorded against the payment', red.length === 1 && red[0].code === 'LAUNCH20' && red[0].owner_id === A && +red[0].discount === 269.8, red);
  const used = await quote(db, A, 'm6', 'LAUNCH20');
  check('a code used up for this shop (1 per shop) → already_used', used.r && used.r.rows[0].q.promo.reason === 'already_used' && /already used/.test(used.r.rows[0].q.promo.message), used);
  const s = await status(db, A);
  check('status: paid_active, the plan, its period, days left counted to the paid end', s.state === 'paid_active' && s.plan_code === 'm3' && s.plan_label === '3 months'
    && iso(s.period_end) === iso(a.period_end) && iso(s.access_until) === iso(a.period_end) && s.days_left > 90, s);
  // stacking on an active paid plan
  const p2 = (await checkout(db, A, 'm1', null)).r.rows[0].c;
  const a2 = (await activate(db, p2.payment_id, 'pay_A2', 499)).r.rows[0].a;
  const end2 = new Date(a.period_end); end2.setUTCMonth(end2.getUTCMonth() + 1);
  check('renewing during a paid plan adds a month after its end', iso(a2.period_start) === iso(a.period_end) && iso(a2.period_end) === iso(end2), { a2, end2 });
  const reuse = await activate(db, (await checkout(db, A, 'm1', null)).r.rows[0].c.payment_id, 'pay_A2', 499);
  check('one provider payment cannot activate two plan payments', !!reuse.err, reuse);
  // month ends: a trial that ends on 31 January → 6 months = 31 July; 1 month = end of February
  await sql(db, `UPDATE public.hangtag_profiles SET onboarded_at = NOW() WHERE id = $1`, [B]);
  await sql(db, `UPDATE public.hangtag_subscriptions SET plan_code = NULL, period_start = NULL, period_end = NULL, trial_ends_at = '2027-01-31T10:00:00Z' WHERE owner_id = $1`, [B]);
  const pb = (await checkout(db, B, 'm1', null)).r.rows[0].c;
  const ab = (await activate(db, pb.payment_id, 'pay_B1', 499)).r.rows[0].a;
  check('a month after 31 January ends on 28 February (calendar months)', iso(ab.period_start) === '2027-01-31T10:00:00.000Z' && iso(ab.period_end) === '2027-02-28T10:00:00.000Z', ab);
  const pb6 = (await checkout(db, B, 'm6', null)).r.rows[0].c;
  const ab6 = (await activate(db, pb6.payment_id, 'pay_B6', 2499)).r.rows[0].a;
  check('6 more months after 28 February: 28 August', iso(ab6.period_end) === '2027-08-28T10:00:00.000Z', ab6);
  // a checkout marked expired, then the provider says it was paid: the money is honoured
  const pe = (await checkout(db, B, 'm1', null)).r.rows[0].c;
  await tryService(db, `SELECT public.hangtag_subscription_fail($1, 'expired')`, [pe.payment_id]);
  const ae = await activate(db, pe.payment_id, 'pay_B_late', 499);
  check('money confirmed by the provider after the link expired is still honoured', !ae.err && ae.r.rows[0].a.ok, ae);
  const zero = await checkout(db, B, 'm1', 'HUGE');
  check('a 100% promo makes a free payment (provider "free", amount 0)', !zero.err && +zero.r.rows[0].c.amount === 0
    && (await sql(db, `SELECT provider FROM public.hangtag_subscription_payments WHERE id = $1`, [zero.r.rows[0].c.payment_id]))[0].provider === 'free', zero);
}

console.log('=== promo limits: total (with checkouts in progress) and per shop ===');
{
  const pa = await checkout(db, A, 'm1', 'ONE');
  check('ONE (1 use in total): the first shop starts a checkout with it', !pa.err, pa);
  const qb = await quote(db, B, 'm1', 'ONE');
  check('…while that checkout is open, another shop is told it is fully used', qb.r && qb.r.rows[0].q.promo.reason === 'used_up' && /fully used/.test(qb.r.rows[0].q.promo.message), qb);
  const qa = await quote(db, A, 'm1', 'ONE');
  check('…but the same shop can try again (its own open checkout does not block it)', qa.r && qa.r.rows[0].q.promo.valid === true, qa);
  await sql(db, `UPDATE public.hangtag_subscription_payments SET created_at = NOW() - interval '31 minutes' WHERE id = $1`, [pa.r.rows[0].c.payment_id]);
  const qb2 = await quote(db, B, 'm1', 'ONE');
  check('an abandoned checkout stops counting after 30 minutes', qb2.r && qb2.r.rows[0].q.promo.valid === true, qb2);
  await activate(db, pa.r.rows[0].c.payment_id, 'pay_A_one', +pa.r.rows[0].c.amount);
  const qb3 = await quote(db, B, 'm1', 'ONE');
  check('once paid, the code is fully used for everyone else', qb3.r && qb3.r.rows[0].q.promo.reason === 'used_up', qb3);
  for (let i = 0; i < 2; i++) {
    const c = (await checkout(db, B, 'm1', 'TWICE')).r.rows[0].c;
    await activate(db, c.payment_id, 'pay_B_tw' + i, +c.amount);
  }
  const q3 = await quote(db, B, 'm1', 'TWICE');
  check('TWICE (2 per shop): a third use by the same shop is refused', q3.r && q3.r.rows[0].q.promo.reason === 'already_used', q3);
  const qA = await quote(db, A, 'm1', 'TWICE');
  check('…another shop may still use it', qA.r && qA.r.rows[0].q.promo.valid === true, qA);
}

console.log('=== the lock: an ended plan refuses every business write, keeps every row ===');
{
  const rowsBefore = (await one(db, A, `SELECT (SELECT count(*) FROM public.hangtag_sales)::int AS s, (SELECT count(*) FROM public.hangtag_products)::int AS p, (SELECT count(*) FROM public.hangtag_customers)::int AS c`));
  await sql(db, `UPDATE public.hangtag_subscriptions SET trial_ends_at = trial_started_at, period_start = NOW() - interval '2 months', period_end = NOW() - interval '1 minute' WHERE owner_id = $1`, [A]);
  const s = await status(db, A);
  check('the paid plan ended: paid_expired, 0 days left (the status still answers)', s.state === 'paid_expired' && s.days_left === 0, s);
  const tries = {
    sale: await saveBill(db, A, bill('b3', 500)),
    product: await tryAs(db, A, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('new', 'New', 10, '{"opts":[]}'::jsonb)`),
    price: await tryAs(db, A, `UPDATE public.hangtag_variants SET price = 1 WHERE id = 'tee:m'`),
    customer: await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c2', 'Ravi')`),
    stock: await tryAs(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('adj1', 'tee:m', 'tee', 'ADJUST', 5, 2)`),
    settings: await tryAs(db, A, `UPDATE public.hangtag_meta SET value = value || '{"x":1}'::jsonb WHERE key = 'settings'`),
    deleteSale: await tryAs(db, A, `DELETE FROM public.hangtag_sales WHERE id = 'b1'`),
    member: await saveBill(db, MGR, bill('b4', 500)),
  };
  for (const [k, r] of Object.entries(tries)) check(`locked: ${k} refused with HT402`, HT402(r), r);
  const rowsAfter = (await one(db, A, `SELECT (SELECT count(*) FROM public.hangtag_sales)::int AS s, (SELECT count(*) FROM public.hangtag_products)::int AS p, (SELECT count(*) FROM public.hangtag_customers)::int AS c`));
  check('every row is still there and readable (nothing deleted or hidden)', JSON.stringify(rowsBefore) === JSON.stringify(rowsAfter) && rowsAfter.s === 2, { rowsBefore, rowsAfter });
  check('the team member still reads the shop\'s data', (await as(db, MGR, `SELECT count(*)::int n FROM public.hangtag_products`)).rows[0].n >= 1);
  const svc = await tryService(db, `INSERT INTO public.hangtag_customers (owner_id, id, name) VALUES ($1, 'svc', 'Support fix')`, [A]);
  const editor = await tryService(db, `DELETE FROM public.hangtag_customers WHERE owner_id = $1 AND id = 'svc'`, [A]);
  check('trusted callers (service role) are not blocked', !svc.err && !editor.err, { svc, editor });
  const cat = (await as(db, null, `SELECT public.hangtag_mobile_catalog($1) AS c`, [token])).rows[0].c;
  check('the public store answers "closed" (no error, no catalog)', cat.ok === false && /not open/.test(cat.message) && !cat.items, cat);
  const other = await tryAs(db, B, `INSERT INTO public.hangtag_customers (id, name) VALUES ('cb', 'B customer')`);
  check('another shop with a running plan is not affected', !other.err, other);
  // suspended (even with time left)
  await sql(db, `UPDATE public.hangtag_subscriptions SET period_end = NOW() + interval '30 days' WHERE owner_id = $1`, [A]);
  await sql(db, `SELECT public.hangtag_admin_suspend($1, true, 'Chargeback')`, [A]);
  const ss = await status(db, A), sm = await status(db, MGR);
  const sw = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c3', 'Lata')`);
  check('suspended: locked even with paid time left; the owner sees why, a team member does not', ss.state === 'suspended' && ss.suspended === true && ss.suspended_reason === 'Chargeback'
    && sm.state === 'suspended' && !sm.suspended_reason && HT402(sw), { ss, sm, sw });
  await sql(db, `SELECT public.hangtag_admin_suspend($1, false, NULL)`, [A]);
  const back = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c3', 'Lata')`);
  check('lifting the suspension opens it again at once', !back.err && (await status(db, A)).state === 'paid_active', back);
  // expired again, then renewed
  await sql(db, `UPDATE public.hangtag_subscriptions SET period_end = NOW() - interval '1 minute' WHERE owner_id = $1`, [A]);
  const locked = await saveBill(db, A, bill('b5', 500));
  const pr = (await checkout(db, A, 'm1', null)).r.rows[0].c;
  const ar = (await activate(db, pr.payment_id, 'pay_A_renew', 499)).r.rows[0].a;
  const after = await saveBill(db, A, bill('b5', 500));
  const cat2 = (await as(db, null, `SELECT public.hangtag_mobile_catalog($1) AS c`, [token])).rows[0].c;
  check('renewing an ended plan starts now and opens everything again at once (the same bill saves; the store opens)', HT402(locked) && !after.err && ar.state === 'paid_active'
    && Math.abs(new Date(ar.period_start) - Date.now()) < 120000 && cat2.ok === true, { locked, after, ar, cat2: cat2.ok });
}

console.log('=== the trial ending ===');
{
  await sql(db, `UPDATE public.hangtag_subscriptions SET plan_code = NULL, period_start = NULL, period_end = NULL, trial_started_at = NOW() - interval '8 days', trial_ends_at = NOW() - interval '1 second' WHERE owner_id = $1`, [A]);
  const s = await status(db, A);
  const w = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c4', 'Kiran')`);
  check('trial ended: trial_expired, locked, 0 days left', s.state === 'trial_expired' && s.days_left === 0 && HT402(w), { s, w });
  check('…a team member is locked out too', HT402(await saveBill(db, MGR, bill('b6', 500))));
  const svc = await tryService(db, `SELECT public.hangtag_admin_grant($1, 'm1', 'Goodwill') AS g`, [A]);
  const g = svc.r && svc.r.rows[0].g;
  const row = (await sql(db, `SELECT * FROM public.hangtag_subscription_payments WHERE provider = 'manual' AND owner_id = $1`, [A]))[0];
  check('Hangtag can give a month without a payment (recorded as a manual payment of 0)', g && g.state === 'paid_active' && row && +row.amount === 0 && row.status === 'paid' && row.note === 'Goodwill', { g, row });
}

console.log('=== the migration on a database with shops already set up ===');
{
  await sql(db, `DELETE FROM public.hangtag_products WHERE owner_id = $1`, [NEWSHOP]);   // the test's product without a variant
  await sql(db, `DELETE FROM public.hangtag_subscriptions WHERE owner_id = $1`, [B]);
  await db.exec(MIG);
  const s = (await sql(db, `SELECT * FROM public.hangtag_subscriptions WHERE owner_id = $1`, [B]))[0];
  check('an existing shop without a plan record gets a trial (this test\'s 7 days) from when the migration runs', s && days(s.trial_started_at, s.trial_ends_at) === 7 && Math.abs(new Date(s.trial_started_at) - Date.now()) < 120000, s);
  await db.exec(MIG_W); await fixtures();
  // rows 80 and 81 check section 3w's default plans and trial, which this test replaced with its own
  const all = await report(db), rep = all.filter((r) => !/^(Plans on sale: Monthly|The free trial lasts 30 days)/.test(r.check_name));
  check('migration report: every row ok (74-77: plans, every set-up shop has a record, every business table locked, promo uses on paid payments)', rep.length === all.length - 2 && rep.length >= 65 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  const guarded = (await sql(db, `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname = 'zz_hangtag_subscription_guard'`))[0].n;
  check('the lock is on every business table (at least 40)', guarded >= 40, guarded);
  const defs = await sql(db, `SELECT p.proname, p.prosecdef, array_to_string(p.proconfig, ',') cfg FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
      AND (p.proname LIKE 'hangtag_subscription%' OR p.proname IN ('hangtag_access_ok', 'hangtag_promo_evaluate', 'hangtag_admin_grant', 'hangtag_admin_suspend', 'hangtag_agent_take'))`);
  check('every function of section 3t is SECURITY DEFINER with search_path = \'\'', defs.length >= 18 && defs.every((d) => d.prosecdef && /search_path=""/.test(d.cfg)), defs.filter((d) => !d.prosecdef || !/search_path=""/.test(d.cfg)));
}

console.log('--- promo limits across several open checkouts; one trial per inbox ---');
{
  await sql(db, `INSERT INTO public.hangtag_promo_codes (code, kind, value, max_uses, per_account_limit, active) VALUES ('FREEONE', 'percent', 100, NULL, 1, true), ('HALFONE', 'percent', 50, NULL, 1, true) ON CONFLICT (code) DO NOTHING`);
  const c1 = (await checkout(db, B, 'm1', 'FREEONE')).r.rows[0].c, c2 = (await checkout(db, B, 'm1', 'FREEONE')).r.rows[0].c;
  const a1 = (await activate(db, c1.payment_id, 'free:' + c1.payment_id, 0)).r.rows[0].a, a2 = (await activate(db, c2.payment_id, 'free:' + c2.payment_id, 0)).r.rows[0].a;
  const n1 = (await sql(db, `SELECT count(*)::int AS n FROM public.hangtag_promo_redemptions WHERE code = 'FREEONE' AND owner_id = $1`, [B]))[0].n;
  const p2 = (await sql(db, `SELECT status, period_end FROM public.hangtag_subscription_payments WHERE id = $1`, [c2.payment_id]))[0];
  check('a 100% code checked out twice before either was used: one plan; the second is refused (failed, no plan time)', a1.ok === true && a2.ok === false && a2.reason === 'promo_limit' && n1 === 1 && p2.status === 'failed' && !p2.period_end, { a1, a2, n1, p2 });
  check('…and a third checkout with it is refused at once (already used)', /already used/.test((await checkout(db, B, 'm1', 'FREEONE')).err || ''));
  const h1 = (await checkout(db, B, 'm1', 'HALFONE')).r.rows[0].c, h2 = (await checkout(db, B, 'm3', 'HALFONE')).r.rows[0].c;
  const b1 = (await activate(db, h1.payment_id, 'pay_H1', +h1.amount)).r.rows[0].a, b2 = (await activate(db, h2.payment_id, 'pay_H2', +h2.amount)).r.rows[0].a;
  const notes = await sql(db, `SELECT id, note FROM public.hangtag_subscription_payments WHERE id IN ($1, $2)`, [h1.payment_id, h2.payment_id]);
  check('two paid checkouts with a once-only code: the money taken is honoured, and the second payment is marked for review', b1.ok === true && b2.ok === true
    && !notes.find((x) => x.id === h1.payment_id).note && /promo code used beyond its limit/.test(notes.find((x) => x.id === h2.payment_id).note || ''), notes);
  const U = ['77777777-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000002', '77777777-0000-0000-0000-000000000003', '77777777-0000-0000-0000-000000000004'];
  const mails = ['ravi.shop@gmail.com', 'Ravi.Shop+second@gmail.com', 'r.a.v.i.shop@googlemail.com', 'ravishop@example.com'];
  const states = [];
  for (const [i, id] of U.entries()) {
    await sql(db, `INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, mails[i]]);
    await as(db, id, `UPDATE public.hangtag_profiles SET shop_name = 'Ravi ' || $2, onboarded_at = NOW() WHERE id = $1`, [id, String(i)]);
    states.push((await status(db, id)).state);
  }
  check('one trial per inbox: name+tag@ and Gmail dots / googlemail.com are the same inbox; another address gets its own trial', JSON.stringify(states) === JSON.stringify(['trial_active', 'trial_expired', 'trial_expired', 'trial_active']), states);
  for (const id of U) await sql(db, `DELETE FROM auth.users WHERE id = $1`, [id]);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
