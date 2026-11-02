// The Platform Console in Chrome (Phase 55), against PGlite running the real schema.sql (row security, the console's own
// functions checking the role on every call). Checked: /platform/ without a session goes to the sign-in page; an account
// without a console role sees "no access" with its own account id (and the attempt is in the audit log); a super admin gets
// the shell (all seventeen sections), the dashboard's real totals, a campaign's cap changed (audited), a section of a later
// release said plainly, the audit log, and signs out; a billing admin's menu has no Audit Log or Settings and those routes
// are refused; the console's session is not the shop app's; the layout fits a desktop, a tablet and a phone.
// Phase 56: the dashboard's counts open their lists; Customers searched by phone, a shop's page (ten tabs), suspended and
// restored through the database's preview and a reason (audited); Subscriptions and Payments with their lists; a billing
// admin sees no Suspend button and the database refuses it anyway (logged); Customers on a phone.
// Run: node tests/run.mjs tests/e2e/platform-console.test.mjs
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
import { seedProfile, sleep } from '../helpers/app.mjs';
import { createReport } from '../helpers/report.mjs';
import { layoutIssues } from '../helpers/responsive.mjs';

const R = createReport();
await H.ensureServer();
const OWNER = 'cccccccc-0000-0000-0000-000000000001', SUPER = 'cccccccc-0000-0000-0000-000000000011', BILL = 'cccccccc-0000-0000-0000-000000000012', NOSTAFF = 'cccccccc-0000-0000-0000-000000000013';
const PAID = 'cccccccc-0000-0000-0000-000000000002', ENDED = 'cccccccc-0000-0000-0000-000000000003';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: OWNER, email: 'owner@shop.test', users: [
  { id: SUPER, email: 'boss@hangtag.test' }, { id: BILL, email: 'billing@hangtag.test' }, { id: NOSTAFF, email: 'someone@example.test' },
  { id: PAID, email: 'bloom@shop.test' }, { id: ENDED, email: 'cobalt@shop.test' }] });
await seedProfile(pg, OWNER, 'owner@shop.test', { shop_name: 'Aura Threads' });
await seedProfile(pg, PAID, 'bloom@shop.test', { shop_name: 'Bloom Florist', phone: '9123456780', gstin: null });
await seedProfile(pg, ENDED, 'cobalt@shop.test', { shop_name: 'Cobalt Tools', phone: '9000000003', gstin: null });
const sql = async (q, p = []) => (await pg.db.query(q, p)).rows;   // the SQL Editor (trusted)
await sql(`INSERT INTO public.hangtag_platform_staff (user_id, role, display_name) VALUES ($1, 'super_admin', 'Boss'), ($2, 'billing_admin', NULL)`, [SUPER, BILL]);
// three shops: on a trial; paying (a month given, then a payment the provider captured); a trial that ended, its payment failed
for (const o of [OWNER, PAID, ENDED]) await sql(`SELECT public.hangtag_subscription_ensure($1)`, [o]);
await sql(`SELECT public.hangtag_admin_grant($1, 'm1', 'seed')`, [PAID]);
await sql(`INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, amount, provider, provider_payment_id, status, kind, paid_at, captured_at)
  VALUES ($1, 'm1', 999, 999, 'razorpay', 'pay_E2E1', 'paid', 'one_time', NOW(), NOW())`, [PAID]);
await sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = NOW() - interval '40 days', trial_ends_at = NOW() - interval '10 days' WHERE owner_id = $1`, [ENDED]);
await sql(`INSERT INTO public.hangtag_subscription_payments (owner_id, plan_code, price, amount, provider, provider_order_id, status, created_at)
  VALUES ($1, 'm1', 999, 999, 'razorpay', 'order_E2E_F', 'failed', NOW() - interval '1 day')`, [ENDED]);
const suspended = async (o) => (await sql(`SELECT suspended FROM public.hangtag_subscriptions WHERE owner_id = $1`, [o]))[0].suspended;
const previewShown = (P) => until(P, () => /What happens/.test((document.querySelector('.pc-conseq') || {}).innerText || ''));
const BASE = H.BASE_URL + '/platform/';

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function open(width = 1280, height = 900) {
  const ctx = await browser.createBrowserContext(), page = await ctx.newPage();
  await page.setViewport({ width, height });
  page.on('pageerror', (e) => R.problem(`[pageerror] ${e.message}`));
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    const u = r.url();
    if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, {}))) r.abort(); return; }
    if (/fonts\.(googleapis|gstatic)\.com/.test(u)) return r.respond({ status: 200, contentType: 'text/css', body: '' });
    r.continue();
  });
  return { ctx, page };
}
const text = (P, sel) => P.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const until = async (P, fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await P.evaluate(fn).catch(() => false)) return true; await sleep(120); } return false; };
async function signIn(P, email) {
  await P.goto(BASE + 'login/', { waitUntil: 'networkidle0' });
  await until(P, () => !!document.querySelector('#pcLogin'));
  await P.type('#pcLogin input[name="email"]', email);
  await P.type('#pcLogin input[name="password"]', 'any-password');
  await P.click('#pcLogin button[type="submit"]');
}
const audit = (action, actor) => sql(`SELECT * FROM public.hangtag_platform_audit WHERE action = $1 AND actor = $2`, [action, actor]);

R.section('the guard: no session → sign in; an account without a role → no access');
{
  const { ctx, page: P } = await open();
  await P.goto(BASE, { waitUntil: 'networkidle0' });
  R.check('/platform/ without a session goes to the sign-in page', await until(P, () => location.pathname.endsWith('/platform/login/') && !!document.querySelector('#pcLogin')), P.url());
  R.check('…which says it is for Hangtag\'s own team, with email + password and Google', /For Hangtag's own team/.test(await text(P, '.pc-auth-card') || '') && !!(await P.$('[data-pc="google"]')));
  await signIn(P, 'someone@example.test');
  R.check('an account without a console role: "No access to the console" and its own account id to give a super admin',
    await until(P, () => /No access to the console/.test(document.body.innerText)) && (await text(P, '#pcId')) === NOSTAFF, await text(P, '.pc-auth-card'));
  R.check('…the attempt is in the audit log (once), as refused', (await audit('console.denied', NOSTAFF)).length === 1 && (await audit('console.denied', NOSTAFF))[0].ok === false);
  await P.goto(BASE + '#/settings', { waitUntil: 'networkidle0' });
  R.check('…and opening a section directly still shows no access (nothing of the console is drawn)', await until(P, () => /No access to the console/.test(document.body.innerText)) && !(await P.$('.pc-nav')));
  await ctx.close();
}

R.section('a super admin: the shell, every section, the real totals');
let SA;
{
  const { ctx, page: P } = await open();
  SA = { ctx, P };
  await signIn(P, 'boss@hangtag.test');
  R.check('signed in: straight into the console (#/dashboard)', await until(P, () => location.pathname.endsWith('/platform/') && !!document.querySelector('.pc-app') && location.hash === '#/dashboard'), P.url());
  R.check('…the sign-in is in the audit log', (await audit('console.sign_in', SUPER)).length === 1);
  const nav = await P.$$eval('.pc-nav a', (l) => l.map((a) => a.textContent.replace(/Later$/, '').trim()));
  R.check('the menu: all seventeen sections in order', nav.join('|') === 'Dashboard|Customers|Subscriptions|Payments|Promotions|Referrals|Wallet|Communications|Usage & Health|Inventory|Errors & Diagnostics|Growth|Employees|Incentives|Reports|Audit Log|Settings', nav);
  R.check('the top bar: the role from the database and the account', /Super admin/.test(await text(P, '.pc-me') || '') && /Boss/.test(await text(P, '.pc-me') || ''), await text(P, '.pc-me'));
  await until(P, () => !!document.querySelector('.pc-tile'));
  const dash = await text(P, '#pcMain');
  R.check('the dashboard: the database\'s totals (3 shops set up: 1 on a trial, 1 paying, 1 ended; 1 failed payment) and the launch offer\'s counter against its cap',
    /Shops set up 3/.test(dash || '') && /Trials 1/.test(dash || '') && /Active 1/.test(dash || '') && /Expired 1/.test(dash || '') && /Payment failures, 7 days 1/.test(dash || '')
    && /Launch offer LAUNCH100 0 of 100 redeemed/.test(dash || '') && /100 left/.test(dash || ''), dash);
  await P.screenshot({ path: H.ARTIFACTS + '/pc1_dashboard_desktop.png', fullPage: true });
  const shopSession = await P.evaluate(() => [localStorage.getItem('hangtag-auth'), !!localStorage.getItem('hangtag-platform-auth')]);
  R.check('the console\'s session is its own (the shop app\'s sign-in is untouched)', shopSession[0] === null && shopSession[1] === true, shopSession);
}

R.section('Promotions: a campaign\'s cap changed, checked and audited');
{
  const { P } = SA;
  await P.goto(BASE + '#/promotions'); await until(P, () => !!document.querySelector('[data-pc-edit="campaign:LAUNCH100"]'));
  R.check('the plans and the campaigns from the database', /Monthly/.test(await text(P, '#pcMain') || '') && /12 Months/.test(await text(P, '#pcMain') || '') && /Launch offer/.test(await text(P, '#pcMain') || ''));
  await P.click('[data-pc-edit="campaign:LAUNCH100"]'); await sleep(200);
  await P.$eval('[data-pc-form="campaign:LAUNCH100"] input[name="max_uses"]', (e) => { e.value = '150'; });
  await P.click('[data-pc-form="campaign:LAUNCH100"] button[type="submit"]');
  R.check('saved: the cap is 150 in the database, and the page says it is in the audit log', await until(P, () => /Saved\. The change is in the audit log/.test(document.body.innerText))
    && (await sql(`SELECT max_uses FROM public.hangtag_promo_codes WHERE code = 'LAUNCH100'`))[0].max_uses === 150);
  const a = (await audit('promotion.update', SUPER))[0];
  R.check('…the audit log keeps who, the role, before and after', a && a.actor_role === 'super_admin' && a.detail.before.max_uses === 100 && a.detail.after.max_uses === 150, a);
  await P.click('[data-pc-edit="campaign:LAUNCH100"]'); await sleep(200);
  await P.$eval('[data-pc-form="campaign:LAUNCH100"] input[name="value"]', (e) => { e.value = 'abc'; });
  await P.click('[data-pc-form="campaign:LAUNCH100"] button[type="submit"]');
  R.check('a wrong value is refused by the database, with words that say so', await until(P, () => /Check the values/.test(document.body.innerText)), await text(P, '#pcMain .pc-msg'));
}

R.section('Customers: from the dashboard to the list, a shop\'s page, suspended and restored (previewed, with a reason, audited)');
{
  const { P } = SA;
  await P.goto(BASE + '#/dashboard'); await until(P, () => !!document.querySelector('a.pc-tile-link'));
  await P.click('a.pc-tile-link[href="#/customers?filter=active"]');
  R.check('the dashboard\'s "Active" opens Customers filtered Active: the paying shop only', await until(P, () => location.hash === '#/customers?filter=active'
    && document.querySelectorAll('#pcRes tbody tr').length === 1 && /Bloom Florist/.test(document.querySelector('#pcRes').innerText)
    && document.querySelector('[data-pc-list="active"]').getAttribute('aria-pressed') === 'true'), await text(P, '#pcMain'));
  await P.click('[data-pc-list="all"]');
  R.check('All: every shop and the sign-up that never set one up (4), each with its plan, AutoPay, stock and errors', await until(P, () => document.querySelectorAll('#pcRes tbody tr').length === 4)
    && /Trial/.test(await text(P, '#pcRes') || '') && /Setup not finished/.test(await text(P, '#pcRes') || ''), await text(P, '#pcRes'));
  await P.type('.pc-tools input[name="q"]', '98765 43210');
  R.check('search by phone (any spacing) finds the shop; the address keeps the search', await until(P, () => document.querySelectorAll('#pcRes tbody tr').length === 1
    && /Aura Threads/.test(document.querySelector('#pcRes').innerText) && /q=98765/.test(location.hash)), await text(P, '#pcRes'));
  await P.click(`[data-pc-open="${OWNER}"]`, { count: 2 });
  await until(P, () => !!document.querySelector('.pc-panel [role="tab"]'));
  await sleep(300);
  R.check('a double-click on a shop opens its page once and keeps it open (the second click doesn\'t close it)',
    (await P.$$eval('.pc-panel-wrap', (l) => l.length)) === 1);
  const tabs = await P.$$eval('.pc-panel [role="tab"]', (l) => l.map((b) => b.textContent));
  R.check('the shop\'s page: ten tabs, its overview from its own records', tabs.join('|') === 'Overview|Subscription|Payments|Usage|Inventory|Communications|Errors|Referrals|Wallet|Activity'
    && /owner@shop\.test/.test(await text(P, '.pc-panel') || '') && /9876543210/.test(await text(P, '.pc-panel') || ''), tabs);
  await P.click('[data-pc-tab="wallet"]');
  R.check('…the wallet: said plainly that there is none (no made-up balance)', await until(P, () => /no wallet or credit ledger yet/.test(document.querySelector('.pc-tabpanel').innerText)));
  await P.click('[data-pc-act="suspend"]'); await previewShown(P);
  const conseq = await text(P, '.pc-conseq');
  R.check('Suspend: the database\'s preview says exactly what will happen — and nothing has changed yet', /Trial → Suspended/.test(conseq || '') && /can't bill or change anything/.test(conseq || '')
    && !(await suspended(OWNER)), conseq);
  R.check('…the button waits for a reason', await P.$eval('[data-pc-go]', (b) => b.disabled));
  await P.type('.pc-confirm textarea[name="reason"]', 'Chargeback on the last payment');
  await P.click('[data-pc-go]');
  R.check('…suspended: in the database, and the page says the audit log has it', await until(P, () => /Done: suspend/.test(document.querySelector('.pc-panel').innerText)) && (await suspended(OWNER)) === true);
  const a = (await audit('customer.suspend', SUPER))[0];
  R.check('…the audit log: who, the shop, before, after and the reason', a && a.target_id === OWNER && a.ok && a.detail.reason === 'Chargeback on the last payment'
    && a.detail.before.state === 'trial_active' && a.detail.after.state === 'suspended', a);
  await P.click('[data-pc-act="restore"]'); await previewShown(P);
  await P.type('.pc-confirm textarea[name="reason"]', 'Resolved with the bank');
  await P.click('[data-pc-go]');
  R.check('Restore: open again, audited', await until(P, () => /Done: restore/.test(document.querySelector('.pc-panel').innerText)) && (await suspended(OWNER)) === false
    && (await audit('customer.restore', SUPER)).length === 1);
  const unnamed = (await layoutIssues(P, {})).filter((x) => x.kind === 'unnamed');
  R.check('every control of the list and the shop\'s page has a name a screen reader can say', unnamed.length === 0, unnamed);
  await P.screenshot({ path: H.ARTIFACTS + '/pc3_customer_desktop.png' });
  await P.keyboard.press('Escape');
  R.check('Escape closes the shop\'s page', await until(P, () => !document.querySelector('.pc-panel')));
}

R.section('Subscriptions and Payments');
{
  const { P } = SA;
  await P.goto(BASE + '#/subscriptions'); await until(P, () => document.querySelectorAll('#pcRes tbody tr').length > 0);
  R.check('Subscriptions: every shop with a plan (3): plan, status, AutoPay, the latest payment', (await P.$$eval('#pcRes tbody tr', (l) => l.length)) === 3
    && /Bloom Florist/.test(await text(P, '#pcRes') || '') && /Captured/.test(await text(P, '#pcRes') || ''), await text(P, '#pcRes'));
  await P.click('[data-pc-list="expired"]');
  R.check('…"Expired": the shop whose trial ended', await until(P, () => document.querySelectorAll('#pcRes tbody tr').length === 1 && /Cobalt Tools/.test(document.querySelector('#pcRes').innerText)));
  await P.goto(BASE + '#/dashboard'); await until(P, () => !!document.querySelector('a.pc-tile-link[href="#/payments?status=failed&days=7"]'));
  await P.click('a.pc-tile-link[href="#/payments?status=failed&days=7"]');
  R.check('the dashboard\'s payment failures open Payments: failed, last 7 days — the one failed payment', await until(P, () => location.hash === '#/payments?status=failed&days=7'
    && document.querySelectorAll('#pcRes tbody tr').length === 1 && /Cobalt Tools/.test(document.querySelector('#pcRes').innerText) && /Last 7 days/.test(document.querySelector('#pcChips').innerText)),
  await text(P, '#pcMain'));
  await P.click('[data-pc-days-clear]'); await until(P, () => !document.querySelector('[data-pc-days-clear]') && !document.querySelector('#pcRes.pc-busy'));
  await P.click('[data-pc-list="captured"]');
  await until(P, () => /pay_E2E1/.test(document.querySelector('#pcRes').innerText));
  await P.click('#pcRes [data-pc-open]');
  await until(P, () => /Provider payment reference/.test((document.querySelector('.pc-panel') || {}).innerText || ''));
  const pd = await text(P, '.pc-panel');
  R.check('a captured payment: amount, plan, the provider\'s reference, the shop — and nothing secret', /pay_E2E1/.test(pd || '') && /Bloom Florist/.test(pd || '') && /Captured/.test(pd || '')
    && !/token|secret|card number/i.test((pd || '').replace(/keeps no card numbers, tokens or keys/i, '')), pd);
  await P.keyboard.press('Escape');
  await P.click('[data-pc-list="refunded"]');
  R.check('"Refunded": said plainly that refunds are made at the provider (no invented rows)', await until(P, () => /doesn't record refunds/.test(document.querySelector('#pcRes').innerText)));
}

R.section('the audit log, a section of a later release, signing out');
{
  const { P } = SA;
  await P.goto(BASE + '#/audit'); await until(P, () => !!document.querySelector('.pc-table tbody tr'));
  const log = await text(P, '#pcMain');
  R.check('the audit log: the change (max_uses: 100 → 150), the sign-in, the refused attempt', /Changed a campaign/.test(log || '') && /max_uses: 100 → 150/.test(log || '')
    && /Signed in to the console/.test(log || '') && /Opened the console without a role/.test(log || '')
    && /Suspended a shop/.test(log || '') && /Reason: Chargeback on the last payment/.test(log || ''), log);
  await P.goto(BASE + '#/referrals'); await until(P, () => /later release/.test(document.querySelector('#pcMain').innerText));
  R.check('Referrals (a later release): said plainly, no sample figures', /comes in a later release/.test(await text(P, '#pcMain') || '') && !(await P.$('#pcMain .pc-tile')));
  await P.click('[data-pc="signout"]');
  R.check('sign out: back to the sign-in page, the console\'s session gone', await until(P, () => location.pathname.endsWith('/platform/login/') && !!document.querySelector('#pcLogin'))
    && await P.evaluate(() => !localStorage.getItem('hangtag-platform-auth')));
  await SA.ctx.close();
}

R.section('a billing admin: only their sections');
{
  const { ctx, page: P } = await open();
  await signIn(P, 'billing@hangtag.test');
  await until(P, () => !!document.querySelector('.pc-nav'));
  const nav = await P.$$eval('.pc-nav a', (l) => l.map((a) => a.getAttribute('href')));
  R.check('the menu has Promotions and Payments, not Audit Log, Settings or Errors & Diagnostics', nav.includes('#/promotions') && nav.includes('#/payments')
    && !nav.includes('#/audit') && !nav.includes('#/settings') && !nav.includes('#/diagnostics'), nav);
  await P.goto(BASE + '#/audit'); await sleep(400);
  R.check('typing #/audit: "Your role (Billing admin) can\'t open Audit Log." — nothing of it loaded', await until(P, () => /can't open Audit Log/.test(document.querySelector('#pcMain').innerText))
    && /Billing admin/.test(await text(P, '#pcMain') || '') && !(await P.$('#pcMain .pc-table')));
  const direct = await P.evaluate(async (u) => { const s = JSON.parse(localStorage.getItem('hangtag-platform-auth')); const r = await fetch(u + '/rest/v1/rpc/hangtag_platform_audit_list', { method: 'POST',
    headers: { apikey: 'x', Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' }, body: '{"p_limit":5}' }); return r.status; }, 'https://wcorlmgkwcahyfastjoz.supabase.co');
  R.check('…and asking the database directly is refused too (the role is checked there)', direct >= 400, direct);

  R.section('the layout: desktop, tablet, phone');
  await P.goto(BASE + '#/dashboard'); await until(P, () => !!document.querySelector('.pc-tile'));
  for (const [w, h] of [[1280, 900], [768, 1024], [390, 844]]) {
    await P.setViewport({ width: w, height: h }); await sleep(250);
    const m = await P.evaluate(() => { const nav = document.querySelector('.pc-nav'), r = nav.getBoundingClientRect(); return { over: document.documentElement.scrollWidth > window.innerWidth + 1,
      navShown: r.right > 0 && getComputedStyle(nav).visibility !== 'hidden', menu: getComputedStyle(document.querySelector('.pc-menu')).display !== 'none' }; });
    R.check(`${w}px: nothing wider than the screen; ${w < 720 ? 'the sections behind the menu button' : 'the side bar shown'}`, !m.over && (w < 720 ? !m.navShown && m.menu : m.navShown && !m.menu), m);
  }
  await P.click('[data-pc="menu"]'); await sleep(350);
  const opened = await P.evaluate(() => ({ shown: document.querySelector('.pc-nav').getBoundingClientRect().left >= 0, expanded: document.querySelector('.pc-menu').getAttribute('aria-expanded') }));
  R.check('phone: the menu button opens the sections (aria-expanded)', opened.shown && opened.expanded === 'true', opened);
  await P.screenshot({ path: H.ARTIFACTS + '/pc2_drawer_phone.png' });
  const big = await P.$$eval('.pc-nav a', (l) => l.every((a) => a.getBoundingClientRect().height >= 40));
  R.check('…each section a large enough touch target', big);
  await P.click('.pc-nav a[href="#/promotions"]'); await sleep(400);
  R.check('…choosing one opens it and closes the drawer', await until(P, () => location.hash === '#/promotions' && !document.querySelector('.pc-app').classList.contains('nav-open')));

  R.section('a billing admin on a shop\'s page; Customers on a phone');
  await P.goto(BASE + '#/customers'); await until(P, () => !!document.querySelector(`[data-pc-open="${OWNER}"]`));
  const lay = await P.evaluate(() => ({ over: document.documentElement.scrollWidth > window.innerWidth + 1, head: getComputedStyle(document.querySelector('#pcRes thead')).display }));
  R.check('phone: Customers fits the screen, each shop a card', !lay.over && lay.head === 'none', lay);
  await P.screenshot({ path: H.ARTIFACTS + '/pc4_customers_phone.png' });
  await P.click(`[data-pc-open="${OWNER}"]`); await until(P, () => !!document.querySelector('.pc-panel [role="tab"]'));
  const pw = await P.evaluate(() => ({ w: document.querySelector('.pc-panel').getBoundingClientRect().width, vw: window.innerWidth }));
  R.check('phone: a shop\'s page takes the whole screen', Math.abs(pw.w - pw.vw) <= 1, pw);
  const acts = await P.$$eval('.pc-panel [data-pc-act]', (l) => l.map((b) => b.dataset.pcAct));
  R.check('a billing admin may give or extend a plan — no Suspend, no End all sign-ins', acts.join() === 'grant,extend', acts);
  await P.click('[data-pc-tab="inventory"]');
  R.check('…the tabs keep their height on a phone, however long the page (each one tappable)', await P.$eval('.pc-panel .pc-tabs', (e) => e.getBoundingClientRect().height >= 40));
  R.check('…and the shop\'s inventory isn\'t theirs to see', await until(P, () => /can't see inventory/.test(document.querySelector('.pc-tabpanel').innerText)));
  const forced = await P.evaluate(async (u, owner) => { const s = JSON.parse(localStorage.getItem('hangtag-platform-auth')); const r = await fetch(u + '/rest/v1/rpc/hangtag_platform_customer_action', { method: 'POST',
    headers: { apikey: 'x', Authorization: 'Bearer ' + s.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_owner: owner, p_action: 'suspend', p_reason: 'trying anyway' }) }); return r.json(); },
  'https://wcorlmgkwcahyfastjoz.supabase.co', OWNER);
  R.check('…asking the database to suspend anyway: refused there, the attempt in the audit log, the shop untouched', forced && forced.ok === false && forced.code === 'DENIED'
    && (await audit('customer.suspend', BILL)).length === 1 && (await audit('customer.suspend', BILL))[0].ok === false && !(await suspended(OWNER)), forced);
  const t0 = (await sql(`SELECT trial_ends_at FROM public.hangtag_subscriptions WHERE owner_id = $1`, [OWNER]))[0].trial_ends_at;
  await P.click('[data-pc-act="extend"]'); await previewShown(P);
  R.check('Extend (billing admin): the preview gives the new end of the trial, 7 days later', /The trial ends .* instead of .* \(\+7 days\)/.test(await text(P, '.pc-conseq') || ''), await text(P, '.pc-conseq'));
  await P.type('.pc-confirm textarea[name="reason"]', 'Setup took longer');
  await P.click('[data-pc-go]');
  await until(P, () => /Done: extend/.test(document.querySelector('.pc-panel').innerText));
  const t1 = (await sql(`SELECT trial_ends_at FROM public.hangtag_subscriptions WHERE owner_id = $1`, [OWNER]))[0].trial_ends_at;
  R.check('…the trial ends 7 days later in the database, audited', Math.round((new Date(t1) - new Date(t0)) / 86400000) === 7 && (await audit('customer.extend', BILL)).length === 1, { t0, t1 });
  await ctx.close();
}

R.section('clickjacking: never inside another site\'s frame (a host that sends no frame headers too)');
{
  const page = await browser.newPage();   // (no page-error listener: the framed app stops itself on purpose)
  await page.setContent(`<iframe id="c" src="${H.BASE_URL}/platform/login/" width="800" height="500"></iframe><iframe id="s" src="${H.BASE_URL}/" width="800" height="500"></iframe>`);
  const inside = async (id) => {
    const f = await (await page.$('#' + id)).contentFrame();
    for (let i = 0; i < 80; i++) { const t = await f.evaluate(() => document.body && document.body.innerText).catch(() => ''); if (/inside another website/.test(t || '')) return t; await sleep(150); }
    return f.evaluate(() => document.body && document.body.innerText).catch(() => '');
  };
  const c = await inside('c'), s = await inside('s');
  R.check('the console framed by another site: it refuses and says why — no sign-in form drawn', /can't open inside another website/.test(c || '') && !/Password/.test(c || ''), c);
  R.check('the shop app framed by another site: the same', /can't open inside another website/.test(s || ''), s);
  await page.close();
}

await R.done(async () => { await browser.close(); await pg.close?.(); });
