// The Platform Console in Chrome (Phase 55), against PGlite running the real schema.sql (row security, the console's own
// functions checking the role on every call). Checked: /platform/ without a session goes to the sign-in page; an account
// without a console role sees "no access" with its own account id (and the attempt is in the audit log); a super admin gets
// the shell (all seventeen sections), the dashboard's real totals, a campaign's cap changed (audited), a section of a later
// release said plainly, the audit log, and signs out; a billing admin's menu has no Audit Log or Settings and those routes
// are refused; the console's session is not the shop app's; the layout fits a desktop, a tablet and a phone.
// Run: node tests/run.mjs tests/e2e/platform-console.test.mjs
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
import { seedProfile, sleep } from '../helpers/app.mjs';
import { createReport } from '../helpers/report.mjs';

const R = createReport();
await H.ensureServer();
const OWNER = 'cccccccc-0000-0000-0000-000000000001', SUPER = 'cccccccc-0000-0000-0000-000000000011', BILL = 'cccccccc-0000-0000-0000-000000000012', NOSTAFF = 'cccccccc-0000-0000-0000-000000000013';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: OWNER, email: 'owner@shop.test', users: [
  { id: SUPER, email: 'boss@hangtag.test' }, { id: BILL, email: 'billing@hangtag.test' }, { id: NOSTAFF, email: 'someone@example.test' }] });
await seedProfile(pg, OWNER, 'owner@shop.test', { shop_name: 'Aura Threads' });
const sql = async (q, p = []) => (await pg.db.query(q, p)).rows;   // the SQL Editor (trusted)
await sql(`INSERT INTO public.hangtag_platform_staff (user_id, role, display_name) VALUES ($1, 'super_admin', 'Boss'), ($2, 'billing_admin', NULL)`, [SUPER, BILL]);
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
  R.check('the dashboard: the database\'s totals (1 shop set up, on a trial) and the launch offer\'s counter against its cap',
    /Shops set up 1/.test(dash || '') && /On a trial 1/.test(dash || '') && /Launch offer LAUNCH100 0 of 100 redeemed/.test(dash || '') && /100 left/.test(dash || ''), dash);
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

R.section('the audit log, a section of a later release, signing out');
{
  const { P } = SA;
  await P.goto(BASE + '#/audit'); await until(P, () => !!document.querySelector('.pc-table tbody tr'));
  const log = await text(P, '#pcMain');
  R.check('the audit log: the change (max_uses: 100 → 150), the sign-in, the refused attempt', /Changed a campaign/.test(log || '') && /max_uses: 100 → 150/.test(log || '')
    && /Signed in to the console/.test(log || '') && /Opened the console without a role/.test(log || ''), log);
  await P.goto(BASE + '#/customers'); await until(P, () => /later release/.test(document.querySelector('#pcMain').innerText));
  R.check('Customers (a later release): said plainly, no sample figures', /comes in a later release/.test(await text(P, '#pcMain') || '') && !(await P.$('#pcMain .pc-tile')));
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
  await ctx.close();
}

await R.done(async () => { await browser.close(); await pg.close?.(); });
