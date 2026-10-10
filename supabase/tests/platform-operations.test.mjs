// The Platform Console's customers, subscriptions, payments and the actions on a shop (schema.sql section 3x, migration
// 20261010120000_hangtag_platform_operations.sql), tested as each console role and as an attacker would: the lists come
// from the shops' own records (one definition per list, so the dashboard's counts and the lists agree); a shop's page shows
// each tab only to the roles that may see it, counts only (never who its receipts went to); every action is checked in the
// database (not only by the console's buttons), previewed without changing anything, needs a reason, and is in the audit
// log with who, which shop, before, after, the reason and the outcome — refused and failed attempts too; a shop owner or
// a team member reaches none of it; payments show their safe fields only.
// Run: node supabase/tests/platform-operations.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIG_X = fs.readFileSync(new URL('../migrations/20261010120000_hangtag_platform_operations.sql', import.meta.url), 'utf8');
const id = (n) => `bbbbbbbb-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = id(1), B = id(2), C = id(3), D = id(4), E = id(5), F = id(6), G = id(7), M = id(8);
const SUPER = id(11), ADM = id(12), BILL = id(13), SUP = id(14), RO = id(15), NOSTAFF = id(16);
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
async function as(who, q, params) {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(q, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (who, q, params) => { try { return { r: (await as(who, q, params)).rows }; } catch (e) { return { err: e.message, code: e.code }; } };
async function asService(q, params) {
  await db.exec('SET ROLE service_role');
  await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`);
  try { return (await db.query(q, params)).rows; } finally { await db.exec('RESET ROLE'); }
}
const sql = async (q, p) => (await db.query(q, p)).rows;   // the SQL Editor (trusted)
const val = async (who, q, p) => { const r = await tryAs(who, q, p); return r.err ? r : Object.values(r.r[0])[0]; };
const customers = (who, o = {}) => val(who, `SELECT public.hangtag_platform_customers($1, $2, $3, $4, $5)`, [o.q ?? null, o.list ?? 'all', o.sort ?? 'newest', o.limit ?? 25, o.offset ?? 0]);
const subscriptions = (who, o = {}) => val(who, `SELECT public.hangtag_platform_subscriptions($1, $2, $3, $4, $5)`, [o.q ?? null, o.list ?? 'all', o.sort ?? 'expiry', o.limit ?? 25, o.offset ?? 0]);
const payments = (who, o = {}) => val(who, `SELECT public.hangtag_platform_payments($1, $2, $3, $4, $5, $6, $7)`,
  [o.q ?? null, o.status ?? 'all', o.from ?? null, o.to ?? null, o.days ?? null, o.limit ?? 25, o.offset ?? 0]);
const customer = (who, owner) => val(who, `SELECT public.hangtag_platform_customer($1)`, [owner]);
const act = (who, owner, action, reason = null, args = {}, dry = false) =>
  val(who, `SELECT public.hangtag_platform_customer_action($1, $2, $3, $4::jsonb, $5)`, [owner, action, reason, JSON.stringify(args), dry]);
const sub = async (o) => (await sql(`SELECT * FROM public.hangtag_subscriptions WHERE owner_id = $1`, [o]))[0];
const auditOf = (action, actor) => sql(`SELECT * FROM public.hangtag_platform_audit WHERE action = $1 AND actor = $2 ORDER BY id`, [action, actor]);
const denied = (r) => r && (r.code === '42501' || /permission denied/.test(r.err || ''));
const ids = (res) => (res && res.rows ? res.rows.map((x) => x.owner_id).sort() : res);
const sorted = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));   // JSONB orders an object's keys its own way
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

await db.exec(SUPABASE);
await db.exec(NEW);
await db.exec(MIG_X); await db.exec(MIG_X);   // the migration on top of schema.sql, twice: safe to run again
for (const [u, e] of [[A, 'aura@shop.test'], [B, 'bloom@shop.test'], [C, 'cobalt@shop.test'], [D, 'dune@shop.test'], [E, 'ember@shop.test'], [F, 'fable@shop.test'],
  [G, 'signup@shop.test'], [M, 'staff@aura.test'], [SUPER, 'boss@hangtag.test'], [ADM, 'admin@hangtag.test'], [BILL, 'billing@hangtag.test'],
  [SUP, 'support@hangtag.test'], [RO, 'viewer@hangtag.test'], [NOSTAFF, 'someone@hangtag.test']]) await sql(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [u, e]);
await sql(`INSERT INTO public.hangtag_platform_staff (user_id, role) VALUES ($1, 'super_admin'), ($2, 'admin'), ($3, 'billing_admin'), ($4, 'support_admin'), ($5, 'read_only')`,
  [SUPER, ADM, BILL, SUP, RO]);

// the shops, as they would be after real use
const onboard = (o, shop, owner, phone = null, gstin = null) => sql(`UPDATE public.hangtag_profiles SET shop_name = $2, full_name = $3, phone = $4, gstin = $5,
  business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [o, shop, owner, phone, gstin]);
await onboard(A, 'Aura Threads', 'Asha Rao', '+91 98765 43210', '29ABCDE1234F1Z5');
await onboard(B, 'Bloom Florist', 'Bilal Khan', '9123456780');
await onboard(C, 'Cobalt Tools', 'Chen Li');
await onboard(D, 'Dune Books', 'Divya Nair');
await onboard(E, 'Ember Cafe', 'Esha Roy');
await onboard(F, 'Fable Toys', 'Farid Ali');
for (const o of [A, B, C, D, E, F]) await sql(`SELECT public.hangtag_subscription_ensure($1)`, [o]);
// A: on its trial, selling: 10 received, 3 sold, 1 returned to stock → 8 in stock; two receipts that failed
await as(A, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Tee', 500, '{"opts":[]}')`);
await as(A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, size) VALUES ('p1:M', 'p1', '[]', '')`);
await as(A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('o1', 'p1:M', 'p1', 'OPENING', 10, 1)`);
await as(A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s1', 1790000000000, 1500, 1500, 'cash')`);
await as(A, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, variant_id, product_name, size, quantity, unit_price) VALUES ('s1', 0, 'p1', 'p1:M', 'Tee', 'M', 3, 500)`);
await as(A, `INSERT INTO public.hangtag_returns (id, sale_id, t, kind, refund_amount, refund_method, value) VALUES ('r1', 's1', 1790000004000, 'return', 500, 'cash', 500)`);
await as(A, `INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_id, product_name, size, quantity, unit_price, value)
  VALUES ('r1', 0, 's1', 0, 'p1:M', 'p1', 'Tee', 'M', 1, 500, 500)`);
for (const k of [1, 2]) await asService(`INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, error)
  VALUES ($1, 's1', 'whatsapp', 'riya@mail.in', 'failed', 'meta', 'The number is not on WhatsApp')`, [A]);
await asService(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, created_by) VALUES ($1, $2, 'Staff', 'staff1', 'cashier', $2)`, [M, A]);
// B: a paid month given earlier, then AutoPay on and its first charge captured
await sql(`SELECT public.hangtag_admin_grant($1, 'm1', 'seed')`, [B]);
await sql(`UPDATE public.hangtag_subscriptions SET autopay_status = 'active', autopay_provider = 'razorpay', autopay_subscription_id = 'sub_B',
  autopay_authorized_at = NOW(), autopay_next_charge_at = NOW() + interval '20 days', autopay_plan_code = 'm1' WHERE owner_id = $1`, [B]);
await asService(`SELECT public.hangtag_autopay_event('razorpay', 'sub_B', 'charged', 'pay_B1', 999)`);
// C: its trial ended; D: paid, AutoPay retrying a failed charge; F: paid, ending in 3 days, no AutoPay, a checkout open
await sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '40 days', trial_ends_at = NOW() - interval '10 days' WHERE owner_id = $1`, [C]);
await sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '60 days', trial_ends_at = NOW() - interval '30 days', plan_code = 'm1',
  period_start = NOW() - interval '29 days', period_end = NOW() + interval '1 day', autopay_status = 'past_due', autopay_provider = 'razorpay',
  autopay_subscription_id = 'sub_D', autopay_failed_at = NOW() WHERE owner_id = $1`, [D]);
await sql(`INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, amount, provider, provider_order_id, status, kind, created_at)
  VALUES ($1, 'm1', 999, 999, 'razorpay', 'order_D1', 'failed', 'one_time', NOW() - interval '1 day')`, [D]);
await sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '120 days', trial_ends_at = NOW() - interval '90 days', plan_code = 'm3',
  period_start = NOW() - interval '87 days', period_end = NOW() + interval '3 days' WHERE owner_id = $1`, [F]);
await sql(`INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, amount, provider, provider_order_id, status)
  VALUES ($1, 'm3', 2499, 2499, 'razorpay', 'order_F1', 'created')`, [F]);
// sign-ins: A twice, its team member once, B once
await sql(`INSERT INTO auth.sessions (user_id) VALUES ($1), ($1), ($2), ($3)`, [A, M, B]);

console.log('=== the roles: who may do what to a shop ===');
{
  const perms = {};
  for (const [who, k] of [[SUPER, 'super'], [ADM, 'admin'], [BILL, 'billing'], [SUP, 'support'], [RO, 'read']]) perms[k] = (await val(who, `SELECT public.hangtag_platform_whoami()`)).permissions;
  const has = (k, p) => perms[k].includes(p);
  check('suspend and restore: super admin and admin only', has('super', 'customers.suspend') && has('admin', 'customers.suspend') && !has('billing', 'customers.suspend')
    && !has('support', 'customers.suspend') && !has('read', 'customers.suspend'), perms);
  check('end a shop\'s sign-ins: super admin, admin, support admin', has('super', 'customers.sessions') && has('admin', 'customers.sessions') && has('support', 'customers.sessions')
    && !has('billing', 'customers.sessions') && !has('read', 'customers.sessions'));
  check('give or extend a plan: super admin, admin, billing admin (subscriptions.manage); read only: views only', has('billing', 'subscriptions.manage') && !has('support', 'subscriptions.manage')
    && perms.read.every((p) => p.endsWith('.view')));
}

console.log('=== customers: real rows, lists, search, order, pages ===');
let all;
{
  all = await customers(RO);
  const row = (o) => all.rows && all.rows.find((x) => x.owner_id === o);
  check('every shop, and every sign-up that never finished setting up (8); never a team member or a console account', all.total === 8
    && !all.rows.some((x) => [M, SUPER, ADM, BILL, SUP, RO].includes(x.owner_id)) && !!row(G) && row(G).state === 'none', all.err || all.rows.map((x) => x.email));
  const a = row(A);
  check('a shop\'s row from its own records: name, owner, phone, GSTIN, trial, 1 product, 8 in stock (10 − 3 sold + 1 returned), 2 failed messages, last used',
    a.shop_name === 'Aura Threads' && a.owner_name === 'Asha Rao' && a.phone === '+91 98765 43210' && a.gstin === '29ABCDE1234F1Z5' && a.state === 'trial_active'
    && a.lifecycle === 'trial' && +a.products === 1 && +a.variants === 1 && +a.stock === 8 && +a.errors_30d === 2 && !!a.last_active && a.email === 'aura@shop.test', a);
  const b = row(B);
  check('money counted only when the provider captured it (999 by AutoPay, not the month given free); AutoPay on with its next charge',
    +b.revenue === 999 && b.autopay_status === 'active' && !!b.next_charge_at && b.state === 'paid_active' && b.plan_code === 'm1', b);
  check('each list counted for this search', same(all.counts, { all: 8, trial: 2, active: 3, payment_failed: 1, expiring: 2, expired: 1, suspended: 0, inactive: 7 }), all.counts);
  const lists = {};
  for (const l of ['trial', 'active', 'payment_failed', 'expiring', 'expired']) lists[l] = ids(await customers(RO, { list: l }));
  check('trial = A, E · active = B, D, F · payment failed = D (AutoPay retrying, its last payment failed) · expiring = D, F (no AutoPay to renew) · expired = C',
    JSON.stringify(lists) === JSON.stringify({ trial: [A, E].sort(), active: [B, D, F].sort(), payment_failed: [D], expiring: [D, F].sort(), expired: [C] }), lists);
  const find = async (q) => ids(await customers(RO, { q }));
  check('search: phone (any spacing), GSTIN, email, owner, shop name, account id', JSON.stringify(await find('9876543210')) === JSON.stringify([A])
    && JSON.stringify(await find('29abcde')) === JSON.stringify([A]) && JSON.stringify(await find('bloom@')) === JSON.stringify([B])
    && JSON.stringify(await find('divya')) === JSON.stringify([D]) && JSON.stringify(await find('ember')) === JSON.stringify([E])
    && JSON.stringify(await find(F)) === JSON.stringify([F]) && (await customers(RO, { q: 'nobody-here' })).total === 0);
  const byRevenue = await customers(RO, { sort: 'revenue' });
  const p1 = await customers(RO, { limit: 3 }), p2 = await customers(RO, { limit: 3, offset: 3 });
  check('sorted by revenue (B first); a page at a time, no shop twice', byRevenue.rows[0].owner_id === B && p1.rows.length === 3 && p2.rows.length === 3 && p2.total === 8
    && !p1.rows.some((x) => p2.rows.some((y) => y.owner_id === x.owner_id)));
  const bad = await customers(RO, { list: 'everything' }), long = await customers(RO, { q: 'x'.repeat(200) });
  check('an unknown list or an overlong search is refused in words', bad.code === 'P0001' && /Unknown list/.test(bad.err) && long.code === 'P0001', { bad, long });
}

console.log('=== tenant isolation: only the console reads across shops ===');
{
  check('a shop owner can\'t list the shops (42501)', denied(await customers(A)));
  check('…nor open another shop\'s page, its plan or a payment', denied(await customer(A, B)) && denied(await val(A, `SELECT public.hangtag_platform_subscription($1)`, [B]))
    && denied(await payments(A)));
  check('a signed-in account without a console role: refused; a visitor: refused', denied(await customers(NOSTAFF)) && denied(await customers(null)));
  const internal = [];
  for (const q of [`SELECT * FROM public.hangtag_platform_shop_rows(NULL)`, `SELECT public.hangtag_platform_list('customers', '', 'all', 'newest', 25, 0)`,
    `SELECT public.hangtag_platform_sub_json($1::uuid)`, `SELECT public.hangtag_platform_pay_list($1::uuid, 5)`, `SELECT public.hangtag_platform_snapshot($1::uuid)`]) {
    const r = await tryAs(A, q.includes('$1') ? q : q, q.includes('$1') ? [B] : undefined), s = await tryAs(SUPER, q, q.includes('$1') ? [B] : undefined);
    internal.push(denied(r) && denied(s));
  }
  check('the pieces the console is built from (every shop\'s rows) can\'t be called by anyone signed in — not even console staff', internal.every(Boolean), internal);
  check('each shop still reads only its own data (row security unchanged)', (await tryAs(A, `SELECT count(*)::int AS n FROM public.hangtag_products`)).r[0].n === 1
    && (await tryAs(B, `SELECT count(*)::int AS n FROM public.hangtag_products`)).r[0].n === 0);
}

console.log('=== a customer\'s page ===');
{
  const s = await customer(SUPER, A);
  const keys = Object.keys(s || {});
  check('ten tabs of data: overview, plan, payments, usage, inventory, messages, errors, referrals, wallet, activity', ['overview', 'subscription', 'payments', 'usage', 'inventory',
    'communications', 'errors', 'referrals', 'wallet', 'activity'].every((k) => keys.includes(k)), keys);
  check('overview and usage from the shop\'s records: 1 bill, the team, its customers; inventory: 8 in stock', s.overview.shop_name === 'Aura Threads' && +s.usage.bills === 1
    && +s.usage.team === 1 && +s.inventory.stock === 8 && +s.inventory.products === 1, { o: s.overview, u: s.usage, i: s.inventory });
  const msgs = JSON.stringify(s.communications);
  check('messages: 2 failed in 30 days, with the provider\'s reason — never who they went to', +s.communications.failed_30d === 2 && s.communications.recent.length === 2
    && !/riya@mail\.in|recipient/.test(msgs), s.communications);
  check('errors: the failed messages, newest first; referrals and wallet: no ledger yet, said plainly (nothing invented)', s.errors.count_30d === 2
    && s.errors.recent.every((e) => e.source === 'message') && s.referrals.available === false && s.wallet.available === false, { e: s.errors, r: s.referrals, w: s.wallet });
  check('activity: signed up, set up the shop, trial started', ['signed_up', 'shop_set_up', 'trial_started'].every((k) => s.activity.some((x) => x.kind === k)), s.activity);
  check('a super admin may do everything to it', same(s.can, { suspend: true, subscriptions: true, sessions: true }) && s.plans.length === 4, s.can);
  const b = await customer(BILL, A);
  check('a billing admin: the plan and payments, not the shop\'s usage, stock, messages or errors; may give or extend a plan, not suspend',
    !!b.subscription && Array.isArray(b.payments) && b.usage === null && b.inventory === null && b.communications === null && b.errors === null
    && b.can.subscriptions === true && b.can.suspend === false && b.can.sessions === false, { u: b.usage, can: b.can });
  const sp = await customer(SUP, A);
  check('a support admin: usage, stock, messages and errors; no referrals or wallet; may end sign-ins only', !!sp.usage && !!sp.inventory && !!sp.communications && !!sp.errors
    && sp.referrals === null && sp.wallet === null && same(sp.can, { suspend: false, subscriptions: false, sessions: true }), sp.can);
  const pb = await customer(RO, B);
  check('a shop\'s payments are its own (B: the month given and the AutoPay charge — none of D\'s)', pb.payments.length === 2 && pb.payments.every((p) => p.owner_id === B)
    && pb.payments.map((p) => p.status).sort().join() === 'captured,granted', pb.payments);
  const m = await customer(SUPER, M), x = await customer(SUPER, id(99));
  check('a team member is not a customer; an unknown id: "No such customer"', m.code === 'P0002' && x.code === 'P0002', { m, x });
}

console.log('=== the actions on a shop: checked, previewed, audited ===');
{
  const pre = await act(ADM, E, 'suspend', null, {}, true);
  check('preview: the exact consequence (trial_active → suspended, no access)', pre.ok === true && pre.dry_run === true && pre.before.state === 'trial_active'
    && pre.after.state === 'suspended' && pre.after.access === false, pre);
  check('…and nothing changed, nothing logged', !(await sub(E)).suspended && (await auditOf('customer.suspend', ADM)).length === 0);
  const noWhy = await act(ADM, E, 'suspend', '  ');
  check('no reason: refused, nothing changed', noWhy.code === 'P0001' && /reason/.test(noWhy.err) && !(await sub(E)).suspended, noWhy);
  const done = await act(ADM, E, 'suspend', 'Chargeback on the last payment');
  const s = await sub(E), a = (await auditOf('customer.suspend', ADM))[0];
  check('suspended by an admin: the shop is locked', done.ok === true && done.after.state === 'suspended' && s.suspended, done);
  check('…its own record says only "Suspended by Hangtag"; the reason stays in the console', s.suspended_reason === 'Suspended by Hangtag', s.suspended_reason);
  check('…the audit log: the admin, the role, the shop, before, after, the reason, the outcome', a && a.actor === ADM && a.actor_role === 'admin' && a.target_type === 'shop'
    && a.target_id === E && a.ok === true && a.detail.reason === 'Chargeback on the last payment' && a.detail.before.state === 'trial_active'
    && a.detail.after.state === 'suspended' && a.detail.outcome === 'done', a);
  const w = await tryAs(E, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('x', 'X', 1, '{"opts":[]}')`);
  check('…and the shop can\'t change anything now (HT402)', w.code === 'HT402', w);
  const page = await customer(RO, E);
  check('its page says who suspended it, when and why (the console\'s record)', page.subscription.suspended === true && page.subscription.suspension.reason === 'Chargeback on the last payment'
    && page.subscription.suspension.by_role === 'admin', page.subscription.suspension);
  const again = await act(ADM, E, 'suspend', 'Twice');
  const failed = (await auditOf('customer.suspend', ADM)).filter((x) => !x.ok);
  check('suspending it again: refused in words, and the failed attempt is in the audit log', again.ok === false && again.code === 'REFUSED' && /already suspended/.test(again.message)
    && failed.length === 1 && failed[0].detail.outcome === 'failed' && failed[0].detail.reason === 'Twice', { again, failed });
  const nope = await act(BILL, E, 'restore', 'Customer paid');
  const nope2 = await act(BILL, E, 'restore', 'Customer paid');
  const den = await auditOf('customer.restore', BILL);
  check('a billing admin can\'t restore it — refused by the database, not only by a hidden button — and the attempt is logged once a minute at most',
    nope.ok === false && nope.code === 'DENIED' && nope2.code === 'DENIED' && den.length === 1 && den[0].ok === false && den[0].detail.outcome === 'denied'
    && (await sub(E)).suspended, { nope, den });
  check('support can\'t suspend; read only can\'t end sign-ins; a shop owner can\'t do anything to another shop', (await act(SUP, A, 'suspend', 'x x x')).code === 'DENIED'
    && (await act(RO, A, 'sign_out', 'x x x')).code === 'DENIED' && (await act(A, B, 'suspend', 'x x x')).code === 'DENIED' && !(await sub(B)).suspended
    && (await auditOf('customer.suspend', A)).length === 1);
  check('a visitor can\'t call it at all', denied(await act(null, E, 'restore', 'x x x')));
  const back = await act(SUPER, E, 'restore', 'Chargeback resolved');
  check('restored by a super admin: open again, audited', back.ok === true && back.after.state === 'trial_active' && !(await sub(E)).suspended
    && (await auditOf('customer.restore', SUPER))[0].detail.before.state === 'suspended');

  const gpre = await act(BILL, C, 'grant', null, { plan: 'm3' }, true);
  check('give a plan, previewed: the ended trial becomes 3 paid months', gpre.ok && gpre.before.state === 'trial_expired' && gpre.after.state === 'paid_active'
    && days(gpre.after.period_start, gpre.after.period_end) >= 89 && (await sql(`SELECT count(*)::int AS n FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [C]))[0].n === 0, gpre);
  const g = await act(BILL, C, 'grant', 'Launch partner', { plan: 'm3' });
  const gp = (await sql(`SELECT * FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [C]))[0];
  const ga = (await auditOf('customer.grant', BILL))[0];
  check('given by a billing admin: a ₹0 manual payment, marked as the console\'s, linked in the audit log', g.ok && gp && gp.provider === 'manual' && +gp.amount === 0
    && gp.status === 'paid' && gp.created_by === BILL && !gp.captured_at && ga.detail.payment_id === gp.id && ga.detail.plan === 'm3', { g, gp, ga });
  check('…never counted as money received', +(await customers(RO, { q: C })).rows[0].revenue === 0);
  check('a plan that isn\'t a paid plan: refused', (await act(BILL, C, 'grant', 'x x x', { plan: 'trial' })).code === 'REFUSED');

  const t0 = (await sub(A)).trial_ends_at;
  const ext = await act(BILL, A, 'extend', 'Setup took longer', { days: 7 });
  check('extend a trial by 7 days', ext.ok && ext.extended === 'trial' && days(t0, (await sub(A)).trial_ends_at) === 7, ext);
  const f0 = (await sub(F)).period_end;
  const extF = await act(ADM, F, 'extend', 'Outage credit', { days: 10 });
  check('extend a paid plan by 10 days (the plan, not the trial)', extF.ok && extF.extended === 'plan' && days(f0, (await sub(F)).period_end) === 10, extF);
  await sql(`UPDATE public.hangtag_subscriptions SET autopay_status = 'active', autopay_provider = 'razorpay', autopay_subscription_id = 'sub_E', autopay_authorized_at = NOW() WHERE owner_id = $1`, [E]);
  const extE = await act(BILL, E, 'extend', 'Asked for more time', { days: 5 });
  check('a trial AutoPay will charge at its end can\'t be extended here (the provider\'s charge date wouldn\'t move) — refused and logged',
    extE.ok === false && /AutoPay/.test(extE.message) && (await auditOf('customer.extend', BILL)).some((x) => !x.ok && x.target_id === E), extE);
  const badDays = [await act(BILL, A, 'extend', 'x x x', { days: 0 }), await act(BILL, A, 'extend', 'x x x', { days: 91 }), await act(BILL, A, 'extend', 'x x x', { days: 'abc' })];
  check('extend by 1 to 90 days only', badDays.every((r) => r.code === 'REFUSED' && /1 to 90/.test(r.message)), badDays);

  const so = await act(SUP, A, 'sign_out', 'Lost phone');
  const left = await sql(`SELECT user_id FROM auth.sessions ORDER BY user_id`);
  check('end every sign-in of a shop (support): the owner\'s 2 and the team member\'s 1 — another shop\'s stays', so.ok && so.sessions_ended === 3
    && left.length === 1 && left[0].user_id === B && (await auditOf('customer.sign_out', SUP))[0].detail.sessions_ended === 3, { so, left });
  const unk = await act(SUPER, A, 'delete', 'x x x'), onMember = await act(SUPER, M, 'suspend', 'x x x');
  check('no other action exists (no deleting a shop); a team member can\'t be acted on as a shop', unk.code === 'P0001' && onMember.code === 'P0002', { unk, onMember });
}

console.log('=== subscriptions ===');
{
  const s = await subscriptions(RO);
  check('every shop with a plan record (6), soonest ending first', s.total === 6 && !s.rows.some((x) => x.state === 'none') && s.rows[0].owner_id === D, s.rows && s.rows.map((x) => [x.shop_name, x.access_until]));
  check('the lists: past due = D (AutoPay retrying); cancelled = none', JSON.stringify(ids(await subscriptions(RO, { list: 'past_due' }))) === JSON.stringify([D])
    && (await subscriptions(RO, { list: 'cancelled' })).total === 0 && s.counts.trial === 2 && s.counts.expired === 0 && s.counts.active === 4, s.counts);
  const d = await val(RO, `SELECT public.hangtag_platform_subscription($1)`, [B]);
  check('a plan in full: Monthly at 999, its period, the next charge, the mandate at the provider, both payments; no wallet', d.subscription.plan.label === 'Monthly'
    && +d.subscription.plan.price === 999 && d.subscription.autopay.subscription_id === 'sub_B' && d.subscription.autopay.status === 'active' && !!d.subscription.next_charge_at
    && d.payments.length === 2 && d.subscription.wallet_used === null && d.can.subscriptions === false, d);
}

console.log('=== payments ===');
{
  const p = await payments(RO);
  check('every plan payment, with each status counted; refunds aren\'t recorded by Hangtag (always 0, said so)', p.total === 5 && p.counts.captured === 1 && p.counts.pending === 1
    && p.counts.failed === 1 && p.counts.granted === 2 && p.counts.refunded === 0 && p.refunds_recorded === false && +p.captured_amount === 999, p.counts);
  const failed = await payments(RO, { status: 'failed' });
  check('failed: D\'s payment, with the shop', failed.total === 1 && failed.rows[0].owner_id === D && failed.rows[0].shop_name === 'Dune Books', failed.rows);
  const one = async (q) => (await payments(RO, { q })).rows.map((x) => x.owner_id);
  check('search: the provider\'s payment or order reference, the shop\'s phone, a payment id', JSON.stringify(await one('pay_b1')) === JSON.stringify([B])
    && JSON.stringify(await one('order_d1')) === JSON.stringify([D]) && JSON.stringify(await one('9123456780')) === JSON.stringify([B, B])
    && JSON.stringify(await one(failed.rows[0].id.slice(0, 8))) === JSON.stringify([D]));
  const recent = await payments(RO, { status: 'failed', days: 7 }), old = await payments(RO, { to: new Date(Date.now() - 3 * 86400000).toISOString() });
  check('by date: the last 7 days, or up to a day', recent.total === 1 && old.total === 0, { recent: recent.total, old: old.total });
  check('dates the wrong way round: refused in words', (await payments(RO, { from: new Date().toISOString(), to: new Date(Date.now() - 86400000).toISOString() })).code === 'P0001');
  const det = await val(RO, `SELECT public.hangtag_platform_payment($1)`, [p.rows.find((x) => x.provider_payment_id === 'pay_B1').id]);
  check('a payment\'s detail: the shop, the plan now, what happened (created → captured)', det.status === 'captured' && det.customer.shop_name === 'Bloom Florist'
    && det.subscription.state === 'paid_active' && det.activity.map((x) => x.kind).join() === 'created,captured', det);
  const flat = JSON.stringify(det).toLowerCase();
  check('…its safe fields only: no card, token, secret, key or signature', !/card|token|secret|signature|password|"key"|api_key/.test(flat), Object.keys(det));
  const granted = (await payments(RO, { status: 'granted', q: C })).rows[0];
  const gd = await val(RO, `SELECT public.hangtag_platform_payment($1)`, [granted.id]);
  check('a plan given from the console: its payment shows it, and the audited action that made it', gd.by_console === true && gd.status === 'granted'
    && gd.activity.some((x) => x.kind === 'customer.grant' && x.detail === 'Launch partner'), gd.activity);
  check('an unknown payment: "No such payment"', (await val(RO, `SELECT public.hangtag_platform_payment($1)`, [id(98)])).code === 'P0002');
}

console.log('=== the dashboard agrees with the lists it opens ===');
{
  const d = await val(RO, `SELECT public.hangtag_platform_dashboard()`);
  const c = await customers(RO);
  check('each customer count on the dashboard is the size of the list it opens', same(d.customers, c.counts), { dash: d.customers, list: c.counts });
  check('payment failures (7 days) = the payments list filtered "failed" over 7 days', +d.revenue.failed_7d === (await payments(RO, { status: 'failed', days: 7 })).total);
}

console.log('=== the migration again, and the report ===');
{
  let err = null;
  try { await db.exec(MIG_X); await db.exec(MIG_X); } catch (e) { err = e.message; }
  const again = await customers(SUPER);
  check('the migration runs again over live data: nothing lost', err === null && again.total === 8 && (await auditOf('customer.suspend', ADM)).length === 2, err);
  const rep = (await db.query(NEW.slice(NEW.lastIndexOf('SELECT check_name')))).rows;
  const mine = rep.filter((r) => r.check_name && /Platform Console: customers|reach the console only|keeps its reason/.test(r.check_name));
  check('report: 77 rows, all ok (incl. the console\'s functions, its shop rows closed to the app, every action with its reason, before and after)',
    rep.length === 77 && rep.every((r) => r.ok) && mine.length === 3, rep.filter((r) => !r.ok));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
