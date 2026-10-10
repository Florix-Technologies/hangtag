// The Platform Console's own logic (Phase 55): the sections and their guard come from the permissions the DATABASE returned
// (never an email, never the browser's guess); a role's menu matches what the database lets it do; the dashboard shows only
// what the server counted; the console's link to the database maps refusals to plain codes and reaches only the console's
// functions; its pages are separate from the shop app (their own session, kept out of the shop app's bundle and test hook,
// no indexing, the same strict content policy). Phase 56: Customers, Subscriptions and Payments — routes that keep their list
// in the address, the dashboard's counts opening their lists, the actions on a shop shown only to roles that may take them
// (the database checks again), their consequences in plain words from the database's preview.
// Run: node tests/unit/platform-console.test.mjs
import { readFileSync } from 'node:fs';
import { ACTIONS, AUDIT_LABELS, CUSTOMER_LISTS, NAV, PAYMENT_STATUSES, ROLES, ROLE_LABELS, SUBSCRIPTION_LISTS, actionConsequence, auditChanges, can, dashboardTiles, guard,
  navFor, offerProgress, routeHash, routeOf, routeQuery, shopActions, staffOf } from '../../src/domain/platform/console.js';
import { PlatformError, createPlatformGateway, platformError } from '../../src/infrastructure/supabase/platform-gateway.js';

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };
const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SQL = read('supabase/schema.sql');

console.log('=== roles and sections ===');
{
  check('five roles, each with a name', ROLES.join() === 'super_admin,admin,billing_admin,support_admin,read_only' && ROLES.every((r) => ROLE_LABELS[r]));
  check('the seventeen sections, in the agreed order', NAV.map((n) => n.label).join('|') === 'Dashboard|Customers|Subscriptions|Payments|Promotions|Referrals|Wallet|Communications|Usage & Health|Inventory|Errors & Diagnostics|Growth|Employees|Incentives|Reports|Audit Log|Settings');
  // each role's permissions, as the database grants them (hangtag_platform_permissions)
  // (its latest definition: section 3x)
  const fn = SQL.slice(SQL.lastIndexOf('CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions'), SQL.indexOf('-- (end of the role permissions)'));
  const permsOf = (role) => { const m = new RegExp(`WHEN '${role}' THEN ARRAY\\[([^\\]]*)\\]`).exec(fn); return m ? [...m[1].matchAll(/'([a-z.]+)'/g)].map((x) => x[1]) : []; };
  check('every section\'s permission is one the database knows', NAV.every((n) => permsOf('super_admin').includes(n.perm)), NAV.filter((n) => !permsOf('super_admin').includes(n.perm)));
  const menu = Object.fromEntries(ROLES.map((r) => [r, navFor(permsOf(r)).map((n) => n.id)]));
  check('super admin: every section', menu.super_admin.length === 17);
  check('admin: every section (settings to view, staff to manage)', menu.admin.length === 17 && can(permsOf('admin'), 'staff.manage') && !can(permsOf('admin'), 'settings.manage'));
  check('billing admin: money and promotions — no audit log, no settings, no diagnostics', menu.billing_admin.includes('promotions') && menu.billing_admin.includes('payments')
    && !menu.billing_admin.includes('audit') && !menu.billing_admin.includes('settings') && !menu.billing_admin.includes('diagnostics'), menu.billing_admin);
  check('support admin: customers, health, diagnostics — no promotions, no audit log', menu.support_admin.includes('diagnostics') && menu.support_admin.includes('health')
    && !menu.support_admin.includes('promotions') && !menu.support_admin.includes('audit'), menu.support_admin);
  check('read only: views only', permsOf('read_only').every((p) => p.endsWith('.view')) && menu.read_only.includes('dashboard') && !menu.read_only.includes('settings'), menu.read_only);
  check('an unknown role or no permissions: no sections', navFor([]).length === 0 && navFor(null).length === 0 && permsOf('owner').length === 0);
  check('routes: "#/promotions" → promotions; unknown, empty or crafted → the dashboard', routeOf('#/promotions') === 'promotions' && routeOf('#/audit/') === 'audit' && routeOf('') === 'dashboard'
    && routeOf('#/nope') === 'dashboard' && routeOf('#/audit/../settings') === 'dashboard' && routeOf('javascript:alert(1)') === 'dashboard');
  check('a list in the address: "#/customers?filter=active" → customers, { filter: active }; only known settings, plain values',
    routeOf('#/customers?filter=active') === 'customers' && JSON.stringify(routeQuery('#/customers?filter=active&evil=1')) === '{"filter":"active"}'
    && JSON.stringify(routeQuery('#/payments?status=failed&days=7')) === '{"status":"failed","days":"7"}' && JSON.stringify(routeQuery('#/customers?filter=<script>')) === '{}'
    && routeOf('#/customers?filter=<x>') === 'dashboard' && JSON.stringify(routeQuery('#/nope?filter=active')) === '{}'
    && routeQuery('#/customers?q=asha%20rao').q === 'asha rao');
  check('…and back: the address of a list ("all" and empty settings left out; a search encoded)', routeHash('customers', { filter: 'active' }) === '#/customers?filter=active'
    && routeHash('customers', { filter: 'all', q: '' }) === '#/customers' && routeHash('payments', { status: 'failed', days: 7 }) === '#/payments?status=failed&days=7'
    && routeOf(routeHash('customers', { q: "o'neil (x)" })) === 'customers' && routeQuery(routeHash('customers', { q: "o'neil (x)" })).q === "o'neil (x)");
  check('the lists and statuses the database knows (3x)', CUSTOMER_LISTS.map(([k]) => k).join() === 'all,trial,active,payment_failed,expiring,expired,suspended,inactive'
    && SUBSCRIPTION_LISTS.map(([k]) => k).join() === 'all,trial,active,payment_failed,past_due,cancelled,expired,suspended'
    && PAYMENT_STATUSES.map(([k]) => k).join() === 'all,captured,pending,failed,refunded,cancelled,expired,granted,free'
    && CUSTOMER_LISTS.every(([k]) => k === 'all' || SQL.includes(`WHEN '${k}' THEN`)) && SUBSCRIPTION_LISTS.every(([k]) => k === 'all' || SQL.includes(`WHEN '${k}' THEN`)));
  check('the guard: a section opens only with its permission', guard('audit', permsOf('admin')) === 'ok' && guard('audit', permsOf('billing_admin')) === 'denied' && guard('settings', []) === 'denied' && guard('x', permsOf('super_admin')) === 'denied');
  const me = staffOf({ staff: true, role: 'billing_admin', permissions: ['dashboard.view', 7, null], account: 'u1' });
  check('the database\'s answer made safe: only text permissions; a claim of staff without a known role is not staff', me.staff && me.perms.join() === 'dashboard.view'
    && !staffOf({ staff: true, role: 'god', permissions: ['dashboard.view'] }).staff && !staffOf(null).staff && !staffOf({ staff: 'true', role: 'admin' }).staff);
}

console.log('=== the dashboard and the audit log ===');
{
  const D = { shops: { total: 12, new_7d: 2, new_30d: 5 }, customers: { all: 14, trial: 4, active: 3, payment_failed: 1, expiring: 2, expired: 2, suspended: 0, inactive: 5 },
    subscriptions: { autopay_setup: 2, renewing: 0, autopay_on: 3, autopay_failing: 1, autopay_cancelled: 1 },
    revenue: { month: 2997, month_count: 3, last_30d: 3996, autopay_30d: 999, failed_7d: 1 }, usage: { bills_24h: 40, shops_selling_7d: 6 } };
  const tiles = dashboardTiles(D, ['dashboard.view', 'customers.view', 'payments.view']);
  const all = tiles.flatMap((g) => g.items), t = (label) => all.find((x) => x.label === label);
  check('tiles show exactly what the server counted (no invented numbers): groups Customers, Shops, AutoPay, Money received, Usage', tiles.map((g) => g.group).join() === 'Customers,Shops,AutoPay,Money received,Usage'
    && t('Shops set up').value === 12 && t('This month').money === true && t('This month').hint === '3 payments' && t('Waiting for AutoPay').value === 2, tiles);
  check('the customer counts open the lists they counted: Active, Trials, Expiring, Expired → Customers; payment failures → Payments, failed, 7 days',
    t('Active').value === 3 && t('Active').href === '#/customers?filter=active' && t('Trials').href === '#/customers?filter=trial' && t('Expiring in 7 days').href === '#/customers?filter=expiring'
    && t('Expired').href === '#/customers?filter=expired' && t('Payment failures, 7 days').value === 1 && t('Payment failures, 7 days').href === '#/payments?status=failed&days=7'
    && t('All customers').href === '#/customers' && !t('This month').href, all.filter((x) => x.href).map((x) => x.href));
  check('…but no link to a section the role can\'t open', dashboardTiles(D, ['dashboard.view']).flatMap((g) => g.items).every((x) => !x.href));
  check('…a missing figure is 0, never made up; no answer, no tiles', dashboardTiles({}).flatMap((g) => g.items).every((x) => x.value === 0) && dashboardTiles(null).length === 0);
  check('an offer\'s counter: 3 of 100 → 97 left', JSON.stringify(offerProgress({ redeemed: 3, cap: 100 })) === JSON.stringify({ redeemed: 3, cap: 100, left: 97, share: 0.03 }) && offerProgress({ redeemed: 5, cap: null }).left === null);
  check('the audit log says what changed', JSON.stringify(auditChanges({ before: { max_uses: 3, title: 'Launch offer', updated_at: 'a' }, after: { max_uses: 100, title: 'Launch offer', updated_at: 'b' } })) === JSON.stringify(['max_uses: 3 → 100'])
    && auditChanges({ after: { role: 'read_only', active: true } }).length === 2 && auditChanges(null).length === 0 && !!AUDIT_LABELS['staff.update']
    && ['customer.suspend', 'customer.restore', 'customer.grant', 'customer.extend', 'customer.sign_out'].every((a) => AUDIT_LABELS[a]));
}

console.log('=== the actions on a shop ===');
{
  const fn = SQL.slice(SQL.lastIndexOf('CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions'), SQL.indexOf('-- (end of the role permissions)'));
  const permsOf = (role) => { const m = new RegExp(`WHEN '${role}' THEN ARRAY\\[([^\\]]*)\\]`).exec(fn); return m ? [...m[1].matchAll(/'([a-z.]+)'/g)].map((x) => x[1]) : []; };
  const shown = Object.fromEntries(ROLES.map((r) => [r, shopActions(permsOf(r), 'trial_active').join()]));
  check('the buttons a role sees follow the database\'s permissions: admins suspend, billing gives and extends plans, support ends sign-ins, read only nothing',
    shown.super_admin === 'suspend,grant,extend,sign_out' && shown.admin === 'suspend,grant,extend,sign_out' && shown.billing_admin === 'grant,extend'
    && shown.support_admin === 'sign_out' && shown.read_only === '', shown);
  check('…restore only for a suspended shop; a sign-up that never set up a shop: only ending its sign-ins', shopActions(permsOf('admin'), 'suspended').join() === 'restore,grant,extend,sign_out'
    && shopActions(permsOf('super_admin'), 'none').join() === 'sign_out' && shopActions([], 'trial_active').length === 0);
  const perm = (a) => new RegExp(`WHEN '${a}' THEN '${ACTIONS[a].perm.replace('.', '\\.')}'`).test(SQL);
  check('each action\'s permission is the one the database checks', Object.keys(ACTIONS).every(perm), Object.keys(ACTIONS).filter((a) => !perm(a)));
  const day = (v) => String(v).slice(0, 10);
  const sus = actionConsequence('suspend', { before: { state: 'paid_active', access: true, autopay_status: 'active' }, after: { state: 'suspended', access: false } }, { day, money: (v) => '₹' + v });
  check('the consequence of suspending, from the preview: the plan before → after, what the shop loses, AutoPay not stopped',
    /Paid plan → Suspended \(the shop can't use Hangtag\)/.test(sus[0]) && /can't bill or change anything/.test(sus[1]) && /AutoPay stays on/.test(sus[2]), sus);
  const ext = actionConsequence('extend', { extended: 'trial', days: 7, before: { state: 'trial_active', access: true, trial_ends_at: '2026-10-20T00:00:00Z' },
    after: { state: 'trial_active', access: true, trial_ends_at: '2026-10-27T00:00:00Z' } }, { day, money: (v) => '₹' + v });
  const gr = actionConsequence('grant', { before: { state: 'trial_expired', access: false }, after: { state: 'paid_active', access: true, period_end: '2027-01-09T00:00:00Z' } }, { day, money: (v) => '₹' + v });
  const so = actionConsequence('sign_out', { before: {}, after: {}, sessions_ended: 3, team: 1 }, { day, money: (v) => '₹' + v });
  check('…extending, giving a plan, ending sign-ins: exact dates and counts', ext.join(' ') === 'The trial ends 2026-10-27 instead of 2026-10-20 (+7 days).'
    && /Trial ended → Paid plan/.test(gr[0]) && /Paid until 2027-01-09/.test(gr[1]) && /₹0 manual payment/.test(gr[2])
    && /^3 sign-ins end now \(the owner's and the team's\)/.test(so[0]) && actionConsequence('suspend', null).length === 0, { ext, gr, so });
}

console.log('=== the console\'s link to the database ===');
{
  check('refusals become plain codes (never internal details)', platformError({ code: '42501', message: 'HANGTAG_PLATFORM_DENIED: x' }).code === 'DENIED'
    && platformError({ code: 'P0001', message: 'The cap can\'t be below the 3 already redeemed.' }).message === 'The cap can\'t be below the 3 already redeemed.'
    && platformError({ code: '23514', message: 'new row violates check constraint "x"' }).message === 'Check the values.'
    && platformError({ code: 'PGRST202', message: 'Could not find the function' }).code === 'OUTDATED'
    && platformError({ code: 'XX000', message: 'relation "secret" does not exist' }).code === 'UNKNOWN' && !/secret/.test(platformError({ code: 'XX000', message: 'relation "secret"' }).message));
  const calls = [];
  const client = { rpc: async (fn, args) => { calls.push([fn, args]); return fn === 'hangtag_platform_dashboard' ? { data: { ok: 1 }, error: null } : { data: null, error: { code: '42501', message: 'HANGTAG_PLATFORM_DENIED' } }; },
    auth: { getSession: async () => ({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async () => ({ data: null, error: { message: 'Invalid login credentials' } }), signOut: async () => ({}), signInWithOAuth: async () => ({ error: null }) } };
  const P = createPlatformGateway({ client });
  const d = await P.dashboard();
  let denied = null; try { await P.saveCampaign('LAUNCH100', { max_uses: 5 }); } catch (e) { denied = e; }
  let bad = null; try { await P.signInWithPassword('a@b.c', 'x'); } catch (e) { bad = e; }
  check('it calls only the console\'s functions, with the database\'s argument names', d.ok === 1 && calls[0][0] === 'hangtag_platform_dashboard'
    && calls[1][0] === 'hangtag_platform_campaign_save' && JSON.stringify(calls[1][1]) === JSON.stringify({ p_code: 'LAUNCH100', p_patch: { max_uses: 5 } }), calls);
  check('a refused call is a PlatformError DENIED; a wrong password says so plainly', denied instanceof PlatformError && denied.code === 'DENIED' && bad && bad.code === 'AUTH' && /don't match/.test(bad.message), { denied, bad });
  const gw = read('src/infrastructure/supabase/platform-gateway.js');
  check('…and never a table directly', !/\.from\(/.test(gw) && (gw.match(/rpc\("hangtag_platform_\w+"/g) || []).length >= 18);
  const seen = [];
  const answers = { hangtag_platform_customers: { rows: [], total: 0 }, hangtag_platform_customer_action: null };
  const C2 = { rpc: async (fn, args) => { seen.push([fn, args]); return fn === 'hangtag_platform_customer_action'
    ? { data: args.p_owner === 'deny' ? { ok: false, code: 'DENIED', message: 'Your console role can\'t do this.' } : args.p_owner === 'no' ? { ok: false, code: 'REFUSED', message: 'This shop is already suspended.' }
      : { ok: true, dry_run: args.p_dry_run, before: {}, after: {} }, error: null } : { data: answers[fn] || {}, error: null }; }, auth: client.auth };
  const G2 = createPlatformGateway({ client: C2 });
  await G2.customers({ q: 'aura', list: 'trial', offset: 25 });
  const pv = await G2.customerAction('u1', 'suspend', { dryRun: true });
  let d2 = null, r2 = null;
  try { await G2.customerAction('deny', 'suspend', { reason: 'x x x' }); } catch (e) { d2 = e; }
  try { await G2.customerAction('no', 'suspend', { reason: 'x x x' }); } catch (e) { r2 = e; }
  await G2.payments({ status: 'failed', days: 7 });
  check('the lists and actions call the database with its argument names', JSON.stringify(seen[0]) === JSON.stringify(['hangtag_platform_customers', { p_query: 'aura', p_list: 'trial', p_sort: 'newest', p_limit: 25, p_offset: 25 }])
    && JSON.stringify(seen[1]) === JSON.stringify(['hangtag_platform_customer_action', { p_owner: 'u1', p_action: 'suspend', p_reason: null, p_args: {}, p_dry_run: true }])
    && JSON.stringify(seen[4][1]) === JSON.stringify({ p_query: null, p_status: 'failed', p_from: null, p_to: null, p_days: 7, p_limit: 25, p_offset: 0 }) && pv.dry_run === true, seen);
  check('a refused action (answered, so the database keeps its audit line) still becomes a PlatformError: DENIED, or REFUSED in the database\'s words',
    d2 instanceof PlatformError && d2.code === 'DENIED' && r2 instanceof PlatformError && r2.code === 'REFUSED' && /already suspended/.test(r2.message), { d2, r2 });
}

console.log('=== a surface of its own ===');
{
  const main = read('src/app/platform-main.js'), hook = read('src/app/test-hook.js'), build = read('scripts/build.mjs'), shop = read('index.html');
  check('its own session: a storage key that is not the shop app\'s', /PLATFORM_AUTH_KEY = "hangtag-platform-auth"/.test(main) && /storageKey: PLATFORM_AUTH_KEY/.test(main));
  check('it starts only on the console\'s pages; the shop app never loads it (kept out of the test hook, checked as a bundle of its own)',
    /surface === "platform" \|\| surface === "platform-login"/.test(main) && !/platform-main/.test(hook) && !/platform/.test(shop)
    && build.includes("r !== './platform-main.js'") && build.includes("path.join(ROOT, 'src/app/platform-main.js')"));
  for (const p of ['platform/index.html', 'platform/login/index.html']) {
    const h = read(p), csp = (shop.match(/<meta http-equiv="Content-Security-Policy"[^>]*>/) || [])[0];
    check(`${p}: the shop app's strict content policy, not indexed, no referrer, the console's own entry`, h.includes(csp) && /<meta name="robots" content="noindex, nofollow">/.test(h)
      && /<meta name="referrer" content="no-referrer">/.test(h) && /platform-main\.js"><\/script>/.test(h) && !/<script>(?!<)/.test(h.replace(/<script [^>]*><\/script>/g, '')));
  }
  check('no email decides access anywhere in the console', !/@hangtag|email\s*===|\.endsWith\(["']@/.test(read('src/features/platform/components/console-app.js') + read('src/domain/platform/console.js')));
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
