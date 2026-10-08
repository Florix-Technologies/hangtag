// The Platform Console's own logic (Phase 55): the sections and their guard come from the permissions the DATABASE returned
// (never an email, never the browser's guess); a role's menu matches what the database lets it do; the dashboard shows only
// what the server counted; the console's link to the database maps refusals to plain codes and reaches only the console's
// functions; its pages are separate from the shop app (their own session, kept out of the shop app's bundle and test hook,
// no indexing, the same strict content policy).
// Run: node tests/unit/platform-console.test.mjs
import { readFileSync } from 'node:fs';
import { AUDIT_LABELS, NAV, ROLES, ROLE_LABELS, auditChanges, can, dashboardTiles, guard, navFor, offerProgress, routeOf, staffOf } from '../../src/domain/platform/console.js';
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
  const fn = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.hangtag_platform_permissions'), SQL.indexOf('-- (internal) the caller\'s console role'));
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
  check('the guard: a section opens only with its permission', guard('audit', permsOf('admin')) === 'ok' && guard('audit', permsOf('billing_admin')) === 'denied' && guard('settings', []) === 'denied' && guard('x', permsOf('super_admin')) === 'denied');
  const me = staffOf({ staff: true, role: 'billing_admin', permissions: ['dashboard.view', 7, null], account: 'u1' });
  check('the database\'s answer made safe: only text permissions; a claim of staff without a known role is not staff', me.staff && me.perms.join() === 'dashboard.view'
    && !staffOf({ staff: true, role: 'god', permissions: ['dashboard.view'] }).staff && !staffOf(null).staff && !staffOf({ staff: 'true', role: 'admin' }).staff);
}

console.log('=== the dashboard and the audit log ===');
{
  const tiles = dashboardTiles({ shops: { total: 12, new_7d: 2, new_30d: 5 }, subscriptions: { trial: 4, trial_ending: 1, autopay_setup: 2, active: 3, renewing: 0, expired: 2, suspended: 0, autopay_on: 3, autopay_failing: 1, autopay_cancelled: 1 },
    revenue: { month: 2997, month_count: 3, last_30d: 3996, autopay_30d: 999, failed_7d: 1 }, usage: { bills_24h: 40, shops_selling_7d: 6 } });
  const all = tiles.flatMap((g) => g.items);
  check('tiles show exactly what the server counted (no invented numbers): groups Shops, Plans, AutoPay, Money received, Usage', tiles.map((g) => g.group).join() === 'Shops,Plans,AutoPay,Money received,Usage'
    && all.find((t) => t.label === 'Shops set up').value === 12 && all.find((t) => t.label === 'This month').money === true && all.find((t) => t.label === 'This month').hint === '3 payments'
    && all.find((t) => t.label === 'Waiting for AutoPay').value === 2);
  check('…a missing figure is 0, never made up; no answer, no tiles', dashboardTiles({}).flatMap((g) => g.items).every((t) => t.value === 0) && dashboardTiles(null).length === 0);
  check('an offer\'s counter: 3 of 100 → 97 left', JSON.stringify(offerProgress({ redeemed: 3, cap: 100 })) === JSON.stringify({ redeemed: 3, cap: 100, left: 97, share: 0.03 }) && offerProgress({ redeemed: 5, cap: null }).left === null);
  check('the audit log says what changed', JSON.stringify(auditChanges({ before: { max_uses: 3, title: 'Launch offer', updated_at: 'a' }, after: { max_uses: 100, title: 'Launch offer', updated_at: 'b' } })) === JSON.stringify(['max_uses: 3 → 100'])
    && auditChanges({ after: { role: 'read_only', active: true } }).length === 2 && auditChanges(null).length === 0 && !!AUDIT_LABELS['staff.update']);
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
  check('…and never a table directly', !/\.from\(/.test(gw) && (gw.match(/rpc\("hangtag_platform_\w+"/g) || []).length >= 11);
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
