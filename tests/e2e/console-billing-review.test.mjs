// The Platform Console's billing review (Payments → Billing review) in Chrome, against PGlite running the real schema.sql
// and the post-repair migration (the console's functions check the role in the database on every call). Checked: the
// billing health (mode, AutoPay's readiness, the last reconciliation, whether money and time agree); the money kept for
// review with its shop; one settled with a reason by a billing admin (gone from the list, in the audit log with before and
// after); a support admin sees the list but can't settle (the database refuses; nothing changes); and on a database
// without the migration the panel says what it needs instead of failing.
// Run: node tests/run.mjs tests/e2e/console-billing-review.test.mjs
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
import { seedProfile, sleep } from '../helpers/app.mjs';
import { createReport } from '../helpers/report.mjs';

const R = createReport();
await H.ensureServer();
const MIG = fs.readFileSync(new URL('../../supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql', import.meta.url), 'utf8');
const OWNER = 'dddddddd-0000-0000-0000-000000000001', BILL = 'dddddddd-0000-0000-0000-000000000012', SUP = 'dddddddd-0000-0000-0000-000000000013';
const users = [{ id: BILL, email: 'billing@hangtag.test' }, { id: SUP, email: 'support@hangtag.test' }];
const pg = await createPgRest(H.SCHEMA_PATH, { uid: OWNER, email: 'owner@shop.test', users });
await pg.db.exec(MIG);
await seedProfile(pg, OWNER, 'owner@shop.test', { shop_name: 'Aura Threads' });
const sql = async (q, p = []) => (await pg.db.query(q, p)).rows;   // the SQL Editor (trusted)
await sql(`INSERT INTO public.hangtag_platform_staff (user_id, role) VALUES ($1, 'billing_admin'), ($2, 'support_admin')`, [BILL, SUP]);
await sql(`SELECT public.hangtag_subscription_ensure($1)`, [OWNER]);
// two items for review, as the subscription functions open them
await sql(`SELECT public.hangtag_billing_exception_open('razorpay', 'refund', 'rfnd_E2E1', $1, NULL, 999, '{"status":"processed"}', 'pay_E2E9')`, [OWNER]);
await sql(`SELECT public.hangtag_billing_exception_open('razorpay', 'unknown_mandate_charge', 'pay_E2E7', NULL, NULL, 999, '{"subscription":"sub_E2E"}', 'pay_E2E7')`);
// a database without the migration, for the last check
const bare = await createPgRest(H.SCHEMA_PATH, { uid: OWNER, email: 'owner@shop.test', users });
await bare.db.query(`INSERT INTO public.hangtag_platform_staff (user_id, role) VALUES ($1, 'billing_admin')`, [BILL]);

const BASE = H.BASE_URL + '/platform/';
const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function open(db = pg) {
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('pageerror', (e) => R.problem(`[pageerror] ${e.message}`));
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    const u = r.url();
    if (u.includes('.supabase.co/')) { if (!(await db.handle(r, {}))) r.abort(); return; }
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });
  return { ctx, page };
}
const until = async (P, fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await P.evaluate(fn).catch(() => false)) return true; await sleep(120); } return false; };
const panel = (P) => P.$eval('.pc-panel', (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => '');
async function signInTo(P, email) {
  await P.goto(BASE + 'login/', { waitUntil: 'networkidle0' });
  await until(P, () => !!document.querySelector('#pcLogin'));
  await P.type('#pcLogin input[name="email"]', email);
  await P.type('#pcLogin input[name="password"]', 'any-password');
  await P.click('#pcLogin button[type="submit"]');
  await until(P, () => !!document.querySelector('.pc-nav'));
  await P.goto(BASE + '#/payments');
  await until(P, () => !!document.querySelector('[data-pc-review]'));
  await P.click('[data-pc-review]');
}

R.section('a billing admin: the health, the items, one settled');
{
  const { ctx, page: P } = await open();
  await signInTo(P, 'billing@hangtag.test');
  R.check('Payments → Billing review opens a panel with the billing health: live mode, AutoPay off and not proven, no reconciliation yet, money and time agree',
    await until(P, () => /Billing mode/.test((document.querySelector('.pc-panel') || {}).innerText || '')) && /Live/.test(await panel(P))
    && /Off · not proven/.test(await panel(P)) && /None yet/.test(await panel(P)) && /Money and time agree\s*Yes/.test(await panel(P)), await panel(P));
  const text = await panel(P);
  R.check('…the two items waiting, each with its kind, amount, shop (or "No shop known") and the provider\'s payment', /Waiting for review \(2\)/.test(text) && /Refund/.test(text)
    && /Charge on an unknown AutoPay/.test(text) && /Aura Threads/.test(text) && /No shop known/.test(text) && /pay_E2E9/.test(text), text);
  const refundId = (await sql(`SELECT id FROM public.hangtag_billing_exceptions WHERE ref = 'rfnd_E2E1'`))[0].id;
  await P.type(`[data-pc-settle="${refundId}"] input[name="why"]`, 'Refunded in the Razorpay dashboard');
  await P.click(`[data-pc-settle="${refundId}"] button[type="submit"]`);
  R.check('settled with a reason: gone from the list (one left)', await until(P, () => /Waiting for review \(1\)/.test((document.querySelector('.pc-panel') || {}).innerText || '')), await panel(P));
  const row = (await sql(`SELECT * FROM public.hangtag_billing_exceptions WHERE id = $1`, [refundId]))[0];
  const audit = (await sql(`SELECT * FROM public.hangtag_platform_audit WHERE action = 'billing.exception_resolve'`))[0];
  R.check('…in the database: settled by that admin with the reason; in the audit log with who, the role, before and after', row.status === 'resolved'
    && row.resolution === 'Refunded in the Razorpay dashboard' && row.resolved_by === BILL && audit && audit.actor === BILL && audit.actor_role === 'billing_admin'
    && audit.detail.before.status === 'open' && audit.detail.after.status === 'resolved', { row, audit });
  await P.click('[data-pc-review-all]');
  R.check('…"Show settled ones too": it is listed with how it was settled', await until(P, () => /Settled: Refunded in the Razorpay dashboard/.test((document.querySelector('.pc-panel') || {}).innerText || '')), await panel(P));
  await ctx.close();
}

R.section('a support admin: sees, can\'t settle');
{
  const { ctx, page: P } = await open();
  await signInTo(P, 'support@hangtag.test');
  await until(P, () => /Waiting for review/.test((document.querySelector('.pc-panel') || {}).innerText || ''));
  const id = (await sql(`SELECT id FROM public.hangtag_billing_exceptions WHERE ref = 'pay_E2E7'`))[0].id;
  await P.type(`[data-pc-settle="${id}"] input[name="why"]`, 'trying anyway');
  await P.click(`[data-pc-settle="${id}"] button[type="submit"]`);
  R.check('the list is shown; settling is refused by the database ("can\'t settle billing items") and the item stays open',
    await until(P, () => /can't settle billing items/.test((document.querySelector('.pc-review-msg') || {}).innerText || ''))
    && (await sql(`SELECT status FROM public.hangtag_billing_exceptions WHERE id = $1`, [id]))[0].status === 'open', await panel(P));
  await ctx.close();
}

R.section('a database without the post-repair migration');
{
  const { ctx, page: P } = await open(bare);
  await signInTo(P, 'billing@hangtag.test');
  R.check('the panel says it needs the post-repair database migration (and the page keeps working)', await until(P, () => /needs the post-repair database migration/.test((document.querySelector('.pc-panel') || {}).innerText || ''))
    && !!(await P.$('#pcRes')), await panel(P));
  await ctx.close();
}

await browser.close();
R.done();
