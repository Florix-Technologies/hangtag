// Team access in the app: the permission lists (the same as the database's and the team function's), roles offered per
// business, staff sign-in rules, who may do what (features/shop/services/access.js, with a fake teamService), this phone's
// device key (kept per member, put away on sign-out, forgotten when revoked), the x-hangtag-device header on every request,
// the team client's calls and the upload queue's permission rules. Run: npm run test:unit
import fs from 'fs';
import path from 'path';
import { store } from '../../src/shared/state/store.js';
import { override } from '../../src/shared/di/services.js';
import { memStorage, installFakeDom } from '../helpers/fake-env.mjs';
import { CANCEL_BILL, EDITABLE_PERMISSIONS, MEMBER_ROLES, PERMISSIONS, PERMISSION_LABELS, ROLE_DEFAULTS, TAB_PERMISSIONS, roleCan, missingFor,
  permissionsFor, roleLabel, tabAllowed } from '../../src/domain/shop/permissions.js';
import { ROLE_SUGGESTIONS, businessKind, roleSuggestionsFor } from '../../src/domain/shop/capabilities.js';
import * as permissionsModule from '../../src/domain/shop/permissions.js';
import { STAFF_DOMAIN, checkNewMember, checkStaffSignIn, cleanShopCode, newPasswordError, shopCode, staffEmail } from '../../src/domain/shop/staff.js';
import * as core from '../../supabase/functions/team/core.js';
import { ACCESS_LOST_TEXT, can, canAny, clearAccess, currentPerms, currentRole, denied, isMember, missingPerms, notAllowedText, refreshAccess, setAccess, signedInAs } from '../../src/features/shop/services/access.js';
import { deviceIdNow, deviceKeyNow, deviceUser, forgetDevice, putDeviceAway, setDevice, thisDevice, useDeviceOf } from '../../src/features/auth/services/device.js';
import { DEVICE_HEADER, withDeviceHeader } from '../../src/infrastructure/supabase/client.js';
import { createTeamClient } from '../../src/infrastructure/team/team-client.js';
import { createCloudGateway } from '../../src/infrastructure/supabase/cloud-gateway.js';
import { failureAction, uploadAllowed, UPLOAD_PERMISSIONS } from '../../src/domain/sync/queue-rules.js';
import { tabOpen } from '../../src/features/shop/components/access-ui.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (a) => [...a].sort();
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../..');
const SHOP = 'ab12cd34-ef56-4789-9abc-def012345678', MEMBER = '0f0e0d0c-0b0a-4909-8807-060504030201';

// ---------- the permission lists: app = database = team function ----------
{
  const sql = fs.readFileSync(path.join(ROOT, 'supabase/schema.sql'), 'utf8');
  const fn = sql.slice(sql.indexOf('FUNCTION public.hangtag_default_permissions'), sql.indexOf('FUNCTION public.hangtag_request_device'));
  const lists = {};
  for (const m of fn.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)) lists[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  check('schema.sql hangtag_default_permissions: the same roles and lists as domain/shop/permissions.js',
    eq(sorted(Object.keys(lists)), sorted(Object.keys(ROLE_DEFAULTS))) && Object.keys(ROLE_DEFAULTS).every((r) => eq(sorted(lists[r]), sorted(ROLE_DEFAULTS[r]))), lists);
  check('the owner has every permission in the database too', eq(sorted(lists.owner || []), sorted(PERMISSIONS)));
  check('the team function has the same permissions, defaults and member roles', eq(core.PERMISSIONS, PERMISSIONS)
    && Object.keys(ROLE_DEFAULTS).every((r) => eq(sorted(core.ROLE_DEFAULTS[r]), sorted(ROLE_DEFAULTS[r]))) && eq(core.ROLES, MEMBER_ROLES));
  // every permission the database's row security asks for is one the app knows
  const s5 = sql.slice(sql.indexOf('-- 5. Row Level Security'), sql.indexOf('-- 6. Realtime'));
  const used = new Set([...s5.matchAll(/\('hangtag_\w+',\s*'([^']*)',\s*'([^']*)'\)/g)].flatMap((m) => [...m[1].split(','), ...m[2].split(/[,|]/)]).filter((p) => p && p !== '-' && p !== 'owner'));
  check('every permission in section 5 is one of the 16', used.size > 5 && [...used].every((p) => PERMISSIONS.includes(p)), [...used]);
  // the app's upload rules ask for the same permission the database checks for that table
  // (the write rule is "add|change|remove" where they differ; an upload adds its record, so it is the "add" part)
  const rule = (t) => { const m = new RegExp(`\\('${t}',\\s*'([^']*)',\\s*'([^']*)'\\)`).exec(s5); return m ? m[2].split('|')[0].split(',') : null; };
  const change = (t) => { const m = new RegExp(`\\('${t}',\\s*'([^']*)',\\s*'([^']*)'\\)`).exec(s5); return m ? m[2].split('|') : null; };
  check('upload permissions match the database: bills, returns, products, customers, settings, cash',
    eq(sorted(UPLOAD_PERMISSIONS.sale), sorted(rule('hangtag_sales'))) && eq(sorted(UPLOAD_PERMISSIONS.return), sorted(rule('hangtag_returns')))
    && eq(sorted(UPLOAD_PERMISSIONS.prod), sorted(rule('hangtag_products'))) && eq(sorted(UPLOAD_PERMISSIONS.cust), sorted(rule('hangtag_customers')))
    && eq(sorted(UPLOAD_PERMISSIONS.settings), sorted(rule('hangtag_meta'))) && eq(sorted(UPLOAD_PERMISSIONS.event), sorted(rule('hangtag_events')))
    && eq(sorted(UPLOAD_PERMISSIONS.move), sorted(rule('hangtag_stock_moves'))) && eq(sorted(UPLOAD_PERMISSIONS.cashmove), sorted(rule('hangtag_cash_moves'))));
  check('history: a member adds bills, lines, payments, returns; only the owner removes them; stock records change only with stock adjustments',
    ['hangtag_sales', 'hangtag_sale_items', 'hangtag_payments', 'hangtag_returns', 'hangtag_return_items'].every((t) => change(t).length === 3 && change(t)[2] === 'owner')
    && change('hangtag_stock_moves')[2] === 'manage_inventory' && CANCEL_BILL.every((p) => change('hangtag_sales')[1].split(',').includes(p)));
  check('cancelling a bill needs the same permissions in the app and in the database (perform_return or manage_settings)', eq(sorted(UPLOAD_PERMISSIONS.void), sorted(CANCEL_BILL))
    && /public\.hangtag_can\('perform_return'\) OR public\.hangtag_can\('manage_settings'\)/.test(sql));
  check('the database checks discounts too (apply_discount), in the RPC and for direct writes', /hangtag_member_write_check/.test(sql) && /NOT public\.hangtag_can\('apply_discount'\)/.test(sql));
}
check('"can" is exported once in the whole app (the test API reaches it by name): the domain\'s is roleCan', !('can' in permissionsModule) && typeof roleCan === 'function');
check('the Roles & permissions grid: everything but the team, devices and seeing products (every member may see them; the database lets them)',
  !EDITABLE_PERMISSIONS.includes('view_products') && !EDITABLE_PERMISSIONS.includes('manage_users') && EDITABLE_PERMISSIONS.length === PERMISSIONS.length - 3);
check('every permission has a label', PERMISSIONS.every((p) => typeof PERMISSION_LABELS[p] === 'string' && PERMISSION_LABELS[p].length > 3));

// ---------- roles and permissions (pure) ----------
check('owner: everything, whatever the overrides say', eq(permissionsFor('owner', { owner: [] }), PERMISSIONS) && roleCan('owner', [], 'manage_users'));
check('a role without the shop\'s own list gets the defaults', eq(permissionsFor('cashier', {}), ROLE_DEFAULTS.cashier) && eq(permissionsFor('cashier', null), ROLE_DEFAULTS.cashier));
check('the shop\'s own list replaces the defaults (unknown permissions dropped, the database order)',
  eq(permissionsFor('cashier', { cashier: ['view_reports', 'create_sale', 'fly'] }), ['create_sale', 'view_reports']));
check('an unknown role may do nothing', eq(permissionsFor('juggler', {}), []) && !roleCan('juggler', {}, 'create_sale'));
check('can(role, list | overrides, p)', roleCan('cashier', ROLE_DEFAULTS.cashier, 'create_sale') && !roleCan('cashier', ROLE_DEFAULTS.cashier, 'manage_products')
  && roleCan('cashier', { cashier: ['manage_products'] }, 'manage_products') && !roleCan('cashier', { cashier: ['manage_products'] }, 'create_sale'));
check('missing permissions of a cashier', eq(missingFor(ROLE_DEFAULTS.cashier), PERMISSIONS.filter((p) => !ROLE_DEFAULTS.cashier.includes(p))) && missingFor(PERMISSIONS).length === 0);
check('role labels', roleLabel('cashier') === 'Cashier' && roleLabel('owner') === 'Owner' && roleLabel('stock_keeper') === 'Stock keeper' && roleLabel('') === '');
check('tabs: a cashier sells and can find bills, stock, products and customers, not reports; kitchen sees none of them',
  tabAllowed('sell', ROLE_DEFAULTS.cashier) && tabAllowed('bills', ROLE_DEFAULTS.cashier) && tabAllowed('stock', ROLE_DEFAULTS.cashier) && !tabAllowed('report', ROLE_DEFAULTS.cashier)
  && ['sell', 'bills', 'stock', 'report', 'products', 'customers', 'home', 'orders', 'tables'].every((t) => !tabAllowed(t, ROLE_DEFAULTS.kitchen)) && tabAllowed('kitchen', ROLE_DEFAULTS.kitchen)
  && Object.keys(TAB_PERMISSIONS).length === 10);
check('roles offered: restaurants get server and kitchen, shops manager and cashier',
  eq(roleSuggestionsFor('restaurant'), ['manager', 'cashier', 'server', 'kitchen']) && eq(roleSuggestionsFor('Hotel / Restaurant'), ROLE_SUGGESTIONS.restaurant)
  && eq(roleSuggestionsFor('Clothing boutique'), ['manager', 'cashier']) && eq(roleSuggestionsFor(''), ['manager', 'cashier']) && eq(roleSuggestionsFor(undefined), ['manager', 'cashier']));
check('old business types count as retail; other stays other', ['Clothing boutique', 'Pop-up or exhibition stall', 'Retail store', 'Online seller', 'Wholesale'].every((t) => businessKind(t) === 'retail')
  && businessKind('Other') === 'other' && businessKind('grocery') === 'grocery' && businessKind('electronics') === 'electronics' && businessKind(null) === 'retail');

// ---------- staff sign-in (the same address as the team function) ----------
check('shop code and staff address match the team function', shopCode(SHOP) === core.shopCode(SHOP) && staffEmail('ravi', 'ab12cd34ef') === core.staffEmail('ravi', 'ab12cd34ef')
  && STAFF_DOMAIN === core.STAFF_DOMAIN && cleanShopCode(' AB12-CD34 EF ') === 'ab12cd34ef');
check('staff sign-in form: shop code, username, password', checkStaffSignIn({ code: 'ab12cd34ef', username: 'ravi', password: 'x' }) === null
  && checkStaffSignIn({ code: 'ab12', username: 'ravi', password: 'x' }).field === 'code' && checkStaffSignIn({ code: 'ab12cd34ef', username: 'R a', password: 'x' }).field === 'username'
  && checkStaffSignIn({ code: 'ab12cd34ef', username: 'ravi', password: '' }).field === 'password');
check('add member form: name, username, role, optional password (same limits as the function)',
  checkNewMember({ name: 'Ravi', username: 'ravi', role: 'cashier' }) === null && checkNewMember({ name: ' ', username: 'ravi', role: 'cashier' }).field === 'name'
  && checkNewMember({ name: 'Ravi', username: 'Ravi K', role: 'cashier' }).field === 'username' && checkNewMember({ name: 'Ravi', username: 'ravi', role: 'owner' }).field === 'role'
  && checkNewMember({ name: 'Ravi', username: 'ravi', role: 'cashier', password: 'short' }).field === 'password'
  && core.validateRequest({ action: 'create_member', name: 'Ravi', username: 'ravi', role: 'cashier', password: 'short' }).error === 'bad_password'
  && newPasswordError('') === '' && !!newPasswordError('1234567'));

// ---------- access.js (who may do what), with a fake teamService ----------
const mem = memStorage();
installFakeDom();
let touch = { shopId: SHOP, role: 'cashier', deviceId: 'dev12345' }, roles = [], members = [{ userId: MEMBER, name: 'Ravi', username: 'ravi', role: 'cashier', status: 'active' }], touchErr = null;
const calls = [];
override({ teamService: {
  touch: async () => { calls.push('touch'); if (touchErr) throw touchErr; return touch; },
  members: async () => { calls.push('members'); return members; },
  roles: async () => { calls.push('roles'); return roles; },
} });
store.access = null; store.authUser = { id: SHOP, user_metadata: {} }; store.profile = { shop_name: 'Aura Threads' };
check('the owner: not a member, every permission, nothing hidden, every tab', !isMember() && currentRole() === 'owner' && eq(currentPerms(), PERMISSIONS)
  && PERMISSIONS.every(can) && missingPerms().length === 0 && signedInAs() === '' && ['sell', 'stock', 'report', 'products', 'customers'].every(tabOpen));
store.authUser = { id: MEMBER, user_metadata: { staff: true, full_name: 'Ravi K' } };
let r = await refreshAccess();
check('a member: the database says shop, role and device; its row and the shop\'s role lists give the permissions',
  r.ok && isMember() && currentRole() === 'cashier' && store.access.shopId === SHOP && store.access.deviceId === 'dev12345' && store.access.name === 'Ravi'
  && eq(store.access.perms, ROLE_DEFAULTS.cashier) && eq(calls, ['touch', 'members', 'roles']), store.access);
check('...kept on this device for the account (hangtag_access)', eq(JSON.parse(mem.mem.hangtag_access).perms, ROLE_DEFAULTS.cashier));
check('a cashier may sell and take returns, not edit products or see reports', can('create_sale') && can('perform_return') && !can('manage_products') && !can('view_reports')
  && canAny(['manage_products', 'create_sale']) && !canAny(['manage_products', 'view_reports']) && missingPerms().includes('manage_products') && !tabOpen('report') && tabOpen('sell'));
store.access.shopName = 'Aura Threads';
check('"Signed in as Ravi (Cashier) at Aura Threads"', signedInAs() === 'Ravi (Cashier) at Aura Threads', signedInAs());
check('a refusal says the role and whom to ask', notAllowedText('edit products') === "Your role (Cashier) can't edit products. Ask the owner." && /revoked/i.test(ACCESS_LOST_TEXT));
roles = [{ role: 'cashier', permissions: ['create_sale', 'view_reports'] }];
r = await refreshAccess();
check('the owner changed the cashier role: the next refresh picks it up', r.ok && can('view_reports') && !can('apply_discount') && tabOpen('report') && store.access.shopName === 'Aura Threads');
touch = { shopId: null, role: null, deviceId: null };
r = await refreshAccess();
check('revoked device / switched off: "lost" (the app signs out), the cached role is left for the caller to handle', r.ok === false && r.lost === true);
touch = { shopId: SHOP, role: 'cashier', deviceId: 'dev12345' }; touchErr = new Error('offline');
r = await refreshAccess();
check('offline: "couldn\'t ask", the role known before stays', r.ok === false && !r.lost && isMember() && can('create_sale'));
touchErr = null; touch = { shopId: MEMBER, role: 'owner', deviceId: null };
r = await refreshAccess();
check('the database says this account is an owner: access cleared (everything allowed)', r.ok && r.access === null && !isMember() && can('manage_products') && !('hangtag_access' in mem.mem));
clearAccess();

// ---------- this phone's device key ----------
setDevice({ key: 'k'.repeat(43), id: 'dev12345' }, MEMBER);
check('a new key: active, with its id and member', deviceKeyNow() === 'k'.repeat(43) && deviceIdNow() === 'dev12345' && deviceUser() === MEMBER);
check('the same member signs in again: its key stays active', useDeviceOf(MEMBER) === true && deviceKeyNow() === 'k'.repeat(43));
putDeviceAway();
check('sign-out: the key is put away for the member and no longer sent', deviceKeyNow() === '' && deviceUser() === '' && !!mem.mem['hangtag_dev_' + MEMBER + '_hangtag_device_key']);
check('another account signs in: no key for it', useDeviceOf(SHOP) === false && deviceKeyNow() === '');
check('the member signs in again on this phone: its own key comes back (no new QR, no new device)', useDeviceOf(MEMBER) === true && deviceKeyNow() === 'k'.repeat(43) && deviceIdNow() === 'dev12345' && deviceUser() === MEMBER);
setDevice({ key: 'j'.repeat(43), id: 'devother1' }, 'other-member');
useDeviceOf(MEMBER);
check('two members on one phone: each keeps its own key', deviceKeyNow() === 'k'.repeat(43) && !!mem.mem['hangtag_dev_other-member_hangtag_device_key']);
forgetDevice();
check('revoked: the key is forgotten for good (not kept aside)', deviceKeyNow() === '' && !mem.mem['hangtag_dev_' + MEMBER + '_hangtag_device_key'] && useDeviceOf(MEMBER) === false);
setDevice({ key: 'q'.repeat(43), id: 'devnew123' }, '');
check('a key enrolled before the sign-in finished belongs to whoever signs in next', useDeviceOf(MEMBER) === true && deviceUser() === MEMBER);
forgetDevice(MEMBER);
check('a name for this phone', typeof thisDevice().name === 'string' && thisDevice().name.length > 0 && thisDevice().name.length <= 60);

// ---------- the header on every request ----------
{
  const seen = [];
  const f = async (input, init) => { seen.push(new Headers((init && init.headers) || {})); return { ok: true }; };
  let key = '';
  const wrapped = withDeviceHeader(f, () => key);
  await wrapped('https://x/rest/v1/t', { headers: { Authorization: 'Bearer a', apikey: 'pk' } });
  key = 'd'.repeat(43);
  await wrapped('https://x/rest/v1/t', { headers: new Headers({ Authorization: 'Bearer a', apikey: 'pk' }) });
  await wrapped('https://x/functions/v1/team', { method: 'POST' });
  check('no key: no header; the request is passed on as it was', !seen[0].has(DEVICE_HEADER) && seen[0].get('authorization') === 'Bearer a');
  check('with a key: x-hangtag-device on every request, other headers kept (plain object or Headers)', seen[1].get(DEVICE_HEADER) === 'd'.repeat(43) && seen[1].get('apikey') === 'pk'
    && seen[2].get(DEVICE_HEADER) === 'd'.repeat(43));
}

// ---------- the team client ----------
{
  const sent = [];
  const cloud = {
    callFunction: async (name, body) => { sent.push([name, body]);
      if (body.action === 'create_member') return { ok: true, user_id: MEMBER, shop_code: 'ab12cd34ef', username: body.username, member: { user_id: MEMBER, name: body.name, username: body.username, role: body.role, status: 'active' } };
      if (body.action === 'enroll_start') return { ok: true, token: 't'.repeat(43), expires_at: '2030-01-01T00:10:00Z' };
      if (body.action === 'enroll_redeem') return { ok: true, token_hash: 'th1', email: 'ravi.ab12cd34ef@staff.hangtag.invalid', device_id: 'dev1', device_key: 'key1', shop_name: 'Aura', role: 'cashier', name: 'Ravi', username: 'ravi' };
      if (body.action === 'update_member') return { ok: true, member: { user_id: body.user_id, status: body.status }, revoked: 2 };
      return { ok: true };
    },
    touchDevice: async () => ({ shopId: SHOP, role: 'cashier', deviceId: 'd' }), fetchMembers: async () => [], fetchDevices: async () => [], fetchRoles: async () => [],
    saveRole: async (x) => { sent.push(['saveRole', x]); },
  };
  const team = createTeamClient({ cloud });
  const made = await team.createMember({ name: 'Ravi', username: 'ravi', role: 'cashier' });
  const qr = await team.enrollStart(MEMBER);
  const j = await team.enrollRedeem({ token: 't'.repeat(43), deviceName: 'Android phone', platform: 'Android phone' });
  const up = await team.updateMember({ userId: MEMBER, status: 'disabled' });
  await team.revokeDevice('dev1'); await team.registerDevice({ deviceName: 'Chrome', platform: 'Windows PC' }); await team.saveRolePermissions('cashier', ['create_sale']);
  check('team client: every change goes to the team function with its field names (no password sent when none)',
    sent[0][0] === 'team' && eq(sent[0][1], { action: 'create_member', name: 'Ravi', username: 'ravi', role: 'cashier' }) && eq(sent[1][1], { action: 'enroll_start', user_id: MEMBER })
    && eq(sent[2][1], { action: 'enroll_redeem', token: 't'.repeat(43), device_name: 'Android phone', platform: 'Android phone' }) && eq(sent[3][1], { action: 'update_member', user_id: MEMBER, status: 'disabled' })
    && eq(sent[4][1], { action: 'revoke_device', device_id: 'dev1' }) && eq(sent[5][1], { action: 'register_device', device_name: 'Chrome', platform: 'Windows PC' })
    && eq(sent[6], ['saveRole', { role: 'cashier', permissions: ['create_sale'], label: undefined }]), sent);
  check('team client: answers in the app\'s names', made.userId === MEMBER && made.member.name === 'Ravi' && qr.token.length === 43 && qr.expiresAt === Date.parse('2030-01-01T00:10:00Z')
    && j.tokenHash === 'th1' && j.deviceKey === 'key1' && j.deviceId === 'dev1' && j.role === 'cashier' && up.revoked === 2);
}

// ---------- the gateway's team reads ----------
{
  const q = { data: null, error: null };
  const client = { rpc: async (fn) => ({ data: fn === 'hangtag_touch_device' ? { shop_id: SHOP, role: 'manager', device_id: 'dv' } : null, error: null }),
    from: () => { const b = { select: () => b, order: () => Promise.resolve({ data: [{ user_id: MEMBER, shop_id: SHOP, name: 'Ravi', username: 'ravi', role: 'cashier', status: 'active', last_seen_at: null }], error: null }) }; return b; } };
  const gw = createCloudGateway({ getClient: () => client, url: 'https://x.supabase.co/', key: 'pk', storageKey: 'k' });
  const t = await gw.touchDevice(), m = await gw.fetchMembers();
  check('gateway: touchDevice → { shopId, role, deviceId }; members as app records', eq(t, { shopId: SHOP, role: 'manager', deviceId: 'dv' }) && m[0].userId === MEMBER && m[0].shopId === SHOP && m[0].name === 'Ravi' && typeof gw.callFunction === 'function', [t, m]);
  const odd = createCloudGateway({ getClient: () => ({ rpc: async () => ({ data: [], error: null }) }), url: 'https://x', key: 'pk', storageKey: 'k' });
  check('gateway: an answer that isn\'t the function\'s (older database stand-in) means no shop', eq(await odd.touchDevice(), { shopId: null, role: null, deviceId: null }));
  void q;
}

// ---------- the upload queue ----------
const has = (list) => (p) => list.includes(p);
check('uploads a cashier may make: bills, returns (and their stock moves), customers, cash; not products, settings, logo, events',
  ['sale', 'void', 'return', 'move', 'cust', 'cashmove', 'dayclose'].every((type) => uploadAllowed({ type }, has(ROLE_DEFAULTS.cashier)))
  && ['prod', 'proddel', 'img', 'settings', 'logo', 'event', 'eventdel'].every((type) => !uploadAllowed({ type }, has(ROLE_DEFAULTS.cashier)))
  && !uploadAllowed({ type: 'move' }, has(ROLE_DEFAULTS.server)));
check('the owner uploads everything; unknown kinds pass', Object.keys(UPLOAD_PERMISSIONS).every((type) => uploadAllowed({ type }, () => true)) && uploadAllowed({ type: 'catdel' }, () => false));
check('a refusal by row security: a member\'s goes to review; the owner\'s keeps retrying as before',
  failureAction('PERMISSION', 1, { member: true }) === 'review' && failureAction('PERMISSION', 1) === 'retry' && failureAction('PERMISSION', 5, { member: false }) === 'retry'
  && failureAction('VALIDATION', 1) === 'review' && failureAction('NETWORK', 9, { member: true }) === 'retry');

// ---------- a member's change the role can't make: refused before anything changes; one that still reaches the queue is kept for review ----------
{
  const { enqueue } = await import('../../src/features/sync/services/outbox.js');
  const { voidSale } = await import('../../src/features/sales/use-cases/checkout.js');
  const { saveEvent, deleteEvent } = await import('../../src/features/events/use-cases/manage-events.js');
  const { recordCashMove, closeDay, saveExpenseCats } = await import('../../src/features/finance/use-cases/cash-moves.js');
  const { recordReturn } = await import('../../src/features/returns/use-cases/record-return.js');
  Object.assign(store, { sbOfflineQueue: [], syncReview: [], settings: { expenseCats: ['Tea'] }, localDays: {}, remoteDays: { d: { sales: [{ id: 's1', t: 1, total: 100, items: [{ ln: 0, v: 'v1', p: 'p1', n: 'Tee', q: 1, price: 100 }] }], voids: [] } },
    returnsMap: {}, moves: {}, cashMoves: {}, dayCloses: {}, events: {}, catalog: { products: [] }, dev: 'dev1', _d: null });
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'custom', perms: ['view_products', 'create_sale'], overrides: {} });
  enqueue({ type: 'settings' });
  check('an upload the role can\'t make isn\'t dropped: it goes to the sync review with the reason (never sent, never lost)',
    store.sbOfflineQueue.length === 0 && store.syncReview.length === 1 && store.syncReview[0].item.type === 'settings' && /can't upload this/.test(store.syncReview[0].err) && store.syncReview[0].code === 'PERMISSION', store.syncReview);
  const days0 = JSON.stringify(store.remoteDays);
  const v = await voidSale('s1', 'Wrong items');
  check('cancelling a bill needs returns or settings: refused before the bill is touched', /can't cancel bills/.test(v.error || '') && JSON.stringify(store.remoteDays) === days0 && store.sbOfflineQueue.length === 0, v);
  const e1 = saveEvent({ name: 'Fair', start: '2026-10-01', end: '2026-10-02', place: '' }), e2 = deleteEvent('e1'), x = saveExpenseCats(['Tea', 'Rent']);
  check('events and expense categories are the shop\'s settings: refused for a cashier, nothing changed', /can't change events/.test(e1.error || '') && /can't change events/.test(e2.error || '')
    && /can't change the shop's settings/.test(x.error || '') && eq(store.events, {}) && eq(store.settings.expenseCats, ['Tea']), { e1, e2, x });
  const rt = recordReturn({ sid: 's1', picks: { 0: 1 }, mode: 'return', pay: 'cash' });
  check('a role without returns can\'t take one', /can't take returns/.test(rt.error || '') && eq(store.returnsMap, {}), rt);
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'custom', perms: ['view_products', 'view_reports'], overrides: {} });
  const c1 = recordCashMove({ type: 'in', amount: '50', reason: 'Change' }), c2 = closeDay({ counted: '0' });
  check('cash entries and closing the day need create_sale', /can't record cash/.test(c1.error || '') && /can't close the day/.test(c2.error || '') && eq(store.cashMoves, {}) && eq(store.dayCloses, {}), { c1, c2 });
  check('a denial names the role: denied(p) / denied([any of])', denied('create_sale', 'sell').error === "Your role (Custom) can't sell. Ask the owner." && denied(['create_sale', 'view_reports'], 'x') === null);
  clearAccess(); store.syncReview = [];
}

// ---------- a member's phone asks what changed, and downloads only that ----------
{
  const { pullShopChanges, forgetShopChanges } = await import('../../src/features/sync/services/pull.js');
  const asked = [];
  let marks = { catalog: 'c1', images: 'i1', moves: 'm1', returns: 'r1', customers: 'u1', events: 'e1', cash: 'k1', settings: 's1', sales: '2|t1|0', sales_count: 2, sales_since: '2026-09-29T10:00:00.123456+05:30', sales_voids: '0' };
  const bill = (id, t) => ({ id, t, dev: 'd2', items: [{ ln: 0, v: 'v1', p: 'p1', n: 'Tee', q: 1, price: 100 }], total: 100 });
  const fake = new Proxy({
    auth: { getSession: async () => ({ data: { session: { user: { id: MEMBER } } } }) },
    shopChanges: async () => { asked.push('changes'); return { ...marks }; },
    purchaseChanges: async () => { asked.push('pchanges'); return 'p1'; },
    fetchSalesSince: async (iso) => { asked.push('since:' + iso); return [bill('s3', 3)]; },
    fetchVoidedSales: async () => { asked.push('voids'); return [{ id: 's1', reason: 'Duplicate' }]; },
    fetchCustomers: async () => { asked.push('customers'); return [{ id: 'c1', name: 'Asha' }]; },
    fetchSales: async () => { asked.push('ALL SALES'); return [bill('s1', 1), bill('s2', 2), bill('s3', 3)]; },
  }, { get: (o, k) => (k in o ? o[k] : async () => { asked.push('other:' + String(k)); return k === 'fetchSettings' ? null : k === 'fetchLogo' ? '' : []; }) });
  override({ cloud: fake });
  Object.assign(store, { sbClient: {}, sbStatus: 'connected', sbOfflineQueue: [], customers: {}, imgs: { p1: 'data:x' }, returnsMap: {}, localDays: {},
    remoteDays: { a: { date: 'x', dev: 'd1', chunk: 0, sales: [bill('s1', 1), bill('s2', 2)], voids: [] } } });
  setAccess({ userId: MEMBER, shopId: SHOP, role: 'cashier', perms: ROLE_DEFAULTS.cashier, overrides: {} });
  forgetShopChanges();
  await pullShopChanges();   // not known yet: one full download, which notes the marks first
  asked.length = 0;
  let got = await pullShopChanges();
  check('nothing changed: one small question, nothing downloaded', eq(got, []) && eq(asked, ['changes', 'pchanges']), asked);
  marks = { ...marks, customers: 'u2', sales: '3|t2|123', sales_count: 3, sales_since: '2026-09-29T10:05:00+05:30', sales_voids: '123' };
  asked.length = 0;
  got = await pullShopChanges();
  const ids = []; Object.values(store.remoteDays).forEach((d) => d.sales.forEach((s) => ids.push(s.id)));
  check('a new customer, a new bill and a cancelled one: just those parts (bills saved since the last look, with a 2-minute margin; no photos, no catalog, no full download)',
    eq(got, ['customers', 'sales']) && asked.includes('customers') && asked.includes('since:2026-09-29T04:28:00.123Z') && asked.includes('voids') && !asked.includes('ALL SALES')
    && !asked.some((x) => /fetchImages|fetchProducts/.test(x)) && eq(ids.sort(), ['s1', 's2', 's3']) && Object.values(store.remoteDays).some((d) => d.voids.includes('s1'))
    && store.imgs.p1 === 'data:x' && !!store.customers.c1, asked);
  marks = { ...marks, sales: '5|t3|123', sales_count: 5, sales_since: '2026-09-29T10:06:00+05:30' };
  asked.length = 0;
  await pullShopChanges();
  check('this phone\'s copy doesn\'t add up to the cloud\'s count (e.g. a very long upload): it downloads the bills once in full', asked.includes('ALL SALES'), asked);
  clearAccess();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
