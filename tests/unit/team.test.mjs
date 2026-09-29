// team Edge Function (supabase/functions/team): request checks per action, the staff sign-in address and shop code,
// random tokens and device keys, SHA-256, the fresh-sign-in rule, the rows it writes, enrollment tokens, and the default
// permissions (the same lists as the database). Also: the function decides "owner" from the database, never trusts a
// shop id from the request, keeps only hashes, and the send-receipt / payment-gateway functions act for the shop
// (a team member sends and takes payments for its shop, with its permission). Run: npm run test:unit
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { BAN_FOREVER, LIMITS, PERMISSIONS, ROLES, ROLE_DEFAULTS, STAFF_DOMAIN, USERNAME, deviceRow, enrollmentRow, freshSession, jwtClaims, memberRow,
  newDeviceId, newDeviceKey, newPassword, newToken, publicMember, redeemable, revokePatch, sha256Hex, shopCode, passwordSignInAt, staffEmail, accessResetPatch, latest,
  validateRequest } from '../../supabase/functions/team/core.js';
import { allowedToSend, SEND_PERMISSION } from '../../supabase/functions/send-receipt/core.js';
import { allowedToPay, ACTION_PERMISSIONS, permissionFor } from '../../supabase/functions/payment-gateway/core.js';

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SHOP = 'ab12cd34-ef56-4789-9abc-def012345678', MEMBER = '0f0e0d0c-0b0a-4909-8807-060504030201';

// ---------- permissions ----------
check('16 permissions, the owner has all of them', PERMISSIONS.length === 16 && eq(ROLE_DEFAULTS.owner, PERMISSIONS) && new Set(PERMISSIONS).size === 16);
check('manager: everything but managing users and devices', eq(ROLE_DEFAULTS.manager, PERMISSIONS.filter((p) => !['manage_users', 'manage_devices'].includes(p))));
check('cashier, server and kitchen defaults as planned',
  eq([...ROLE_DEFAULTS.cashier].sort(), ['apply_discount', 'collect_credit', 'create_order', 'create_sale', 'manage_tables', 'perform_return', 'send_to_kitchen', 'view_products'])
  && eq([...ROLE_DEFAULTS.server].sort(), ['create_order', 'manage_tables', 'send_to_kitchen', 'view_products']) && eq(ROLE_DEFAULTS.kitchen, ['manage_kitchen']));
check('a member is never the owner', eq(ROLES, ['manager', 'cashier', 'server', 'kitchen']) && !ROLES.includes('owner'));
// the database's copy (schema.sql public.hangtag_default_permissions) lists the same permissions per role
{
  const sql = read('supabase/schema.sql');
  const fn = sql.slice(sql.indexOf('FUNCTION public.hangtag_default_permissions'), sql.indexOf('FUNCTION public.hangtag_request_device'));
  const lists = {};
  for (const m of fn.matchAll(/WHEN '(\w+)' THEN ARRAY\[([^\]]*)\]/g)) lists[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  check('schema.sql hangtag_default_permissions has the same lists', ['owner', 'manager', 'cashier', 'server', 'kitchen'].every((r) => eq([...(lists[r] || [])].sort(), [...ROLE_DEFAULTS[r]].sort())), lists);
}
// the app's copy, once it exists (src/domain/shop/permissions.js)
if (fs.existsSync(path.join(ROOT, 'src/domain/shop/permissions.js'))) {
  const P = await import('../../src/domain/shop/permissions.js');
  check('src/domain/shop/permissions.js has the same permissions and defaults', eq([...P.PERMISSIONS].sort(), [...PERMISSIONS].sort())
    && ['owner', 'manager', 'cashier', 'server', 'kitchen'].every((r) => eq([...(P.ROLE_DEFAULTS[r] || [])].sort(), [...ROLE_DEFAULTS[r]].sort())));
}

// ---------- staff sign-in ----------
check('the shop code is the first 10 hex digits of the shop id', shopCode(SHOP) === 'ab12cd34ef' && shopCode(SHOP.toUpperCase()) === 'ab12cd34ef');
check('a staff sign-in address can never receive mail', staffEmail('ravi', 'ab12cd34ef') === 'ravi.ab12cd34ef@staff.hangtag.invalid' && STAFF_DOMAIN.endsWith('.invalid'));
check('usernames: 3-30 of a-z 0-9 . _ -', USERNAME.test('ravi.k_2') && !USERNAME.test('ab') && !USERNAME.test('Ravi') && !USERNAME.test('a b c') && !USERNAME.test('x'.repeat(31)));

// ---------- requests ----------
let r = validateRequest({ action: 'create_member', name: '  Ravi   Kumar ', username: ' Ravi.K ', role: 'cashier', password: 'secret123', shop_id: 'someone-else', user_id: MEMBER });
check('create_member: name, username (lower case), role, password — a shop id or user id in the request is ignored',
  eq(r, { ok: true, action: 'create_member', name: 'Ravi Kumar', username: 'ravi.k', role: 'cashier', password: 'secret123' }), r);
check('create_member without a password (QR sign-in only)', validateRequest({ action: 'create_member', name: 'A', username: 'abc', role: 'kitchen' }).password === null);
check('create_member refuses a bad name, username, role or password',
  validateRequest({ action: 'create_member', name: ' ', username: 'abc', role: 'cashier' }).error === 'bad_name'
  && validateRequest({ action: 'create_member', name: 'x'.repeat(81), username: 'abc', role: 'cashier' }).error === 'bad_name'
  && validateRequest({ action: 'create_member', name: 'A', username: 'a!', role: 'cashier' }).error === 'bad_username'
  && validateRequest({ action: 'create_member', name: 'A', username: 'abc', role: 'owner' }).error === 'bad_role'
  && validateRequest({ action: 'create_member', name: 'A', username: 'abc', role: 'cashier', password: 'short' }).error === 'bad_password'
  && validateRequest({ action: 'create_member', name: 'A', username: 'abc', role: 'cashier', password: 'x'.repeat(73) }).error === 'bad_password');
r = validateRequest({ action: 'update_member', user_id: MEMBER.toUpperCase(), role: 'manager', status: 'disabled' });
check('update_member: the member, and only what changes', eq(r, { ok: true, action: 'update_member', userId: MEMBER, role: 'manager', status: 'disabled' }), r);
check('update_member needs a member and something to change; the role is never owner; status active / disabled',
  validateRequest({ action: 'update_member', user_id: 'nope', role: 'manager' }).status === 400 && validateRequest({ action: 'update_member', user_id: MEMBER }).error === 'bad_request'
  && validateRequest({ action: 'update_member', user_id: MEMBER, role: 'owner' }).error === 'bad_role' && validateRequest({ action: 'update_member', user_id: MEMBER, status: 'banned' }).error === 'bad_status');
check('reset_access (password optional), remove_member, enroll_start name a member',
  eq(validateRequest({ action: 'reset_access', user_id: MEMBER }), { ok: true, action: 'reset_access', userId: MEMBER, password: null })
  && validateRequest({ action: 'reset_access', user_id: MEMBER, password: 'newpass99' }).password === 'newpass99'
  && eq(validateRequest({ action: 'remove_member', user_id: MEMBER }), { ok: true, action: 'remove_member', userId: MEMBER })
  && eq(validateRequest({ action: 'enroll_start', user_id: MEMBER }), { ok: true, action: 'enroll_start', userId: MEMBER })
  && validateRequest({ action: 'enroll_start' }).status === 400);
const tok = newToken();
r = validateRequest({ action: 'enroll_redeem', token: tok, device_name: '  Counter   phone ', platform: 'Android <script>' });
check('enroll_redeem: the token and a name for the phone (platform as plain text)', eq(r, { ok: true, action: 'enroll_redeem', token: tok, deviceName: 'Counter phone', platform: 'Android script' }), r);
check('enroll_redeem refuses anything that isn\'t a token, or no phone name', validateRequest({ action: 'enroll_redeem', token: 'abc', device_name: 'x' }).error === 'bad_token'
  && validateRequest({ action: 'enroll_redeem', token: tok + '=', device_name: 'x' }).error === 'bad_token' && validateRequest({ action: 'enroll_redeem', token: tok }).error === 'bad_device'
  && validateRequest({ action: 'enroll_redeem', token: tok, device_name: 'x'.repeat(61) }).error === 'bad_device');
check('register_device: a name for the phone', eq(validateRequest({ action: 'register_device', device_name: 'Tab' }), { ok: true, action: 'register_device', deviceName: 'Tab', platform: null }));
check('revoke_device / remove_device: the device id', eq(validateRequest({ action: 'revoke_device', device_id: 'dev_12345678' }), { ok: true, action: 'revoke_device', deviceId: 'dev_12345678' })
  && validateRequest({ action: 'remove_device', device_id: 'x' }).status === 400 && validateRequest({ action: 'remove_device', device_id: "d'; drop table x;--" }).status === 400);
check('bad requests refused', validateRequest(null).status === 400 && validateRequest('x').status === 400 && validateRequest({ action: 'make_owner' }).error === 'bad_request');

// ---------- tokens, keys, hashes ----------
const b64url = /^[A-Za-z0-9_-]+$/;
const toks = new Set(Array.from({ length: 50 }, newToken));
check('enrollment tokens: 32 random bytes as base64url (43 characters), never the same twice', toks.size === 50 && [...toks].every((t) => t.length === 43 && b64url.test(t)));
check('device keys: 32 random bytes too; device ids fit the database (8-64 of A-Z a-z 0-9 _ -)', newDeviceKey().length === 43 && /^[A-Za-z0-9_-]{8,64}$/.test(newDeviceId()) && newDeviceId() !== newDeviceId());
check('a member added without a password gets one nobody knows', newPassword().length === 32 && newPassword() !== newPassword());
check('SHA-256 as hex, the same as Node and the database', (await sha256Hex('abc')) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  && (await sha256Hex('ключ ✓')) === crypto.createHash('sha256').update('ключ ✓', 'utf8').digest('hex'));

// ---------- a fresh sign-in ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (c) => 'Bearer ' + b64({ alg: 'HS256' }) + '.' + b64(c) + '.sig';
const now = Date.parse('2026-09-28T10:00:00Z'), s = now / 1000;
check('claims are read from the token (with non-ASCII text)', eq(jwtClaims(jwt({ sub: 'u1', name: 'Ravi ✓' })), { sub: 'u1', name: 'Ravi ✓' }) && jwtClaims('Bearer nope') === null && jwtClaims('') === null);
check('password sign-in time: the token\'s "password" method only (never when the token was issued, never a QR / link sign-in)',
  passwordSignInAt({ amr: [{ method: 'password', timestamp: 100 }], iat: 900 }) === 100 && passwordSignInAt({ amr: [{ method: 'otp', timestamp: 50 }, { method: 'password', timestamp: 70 }] }) === 70
  && passwordSignInAt({ iat: 900 }) === null && passwordSignInAt({ amr: [{ method: 'magiclink', timestamp: 100 }], iat: 900 }) === null && passwordSignInAt({}) === null && passwordSignInAt(null) === null);
check('fresh: a password sign-in within 10 minutes', freshSession(jwtClaims(jwt({ amr: [{ method: 'password', timestamp: s - 120 }], iat: s })), now)
  && !freshSession(jwtClaims(jwt({ amr: [{ method: 'password', timestamp: s - 11 * 60 }], iat: s })), now)
  && !freshSession({ iat: s - 60 }, now) && !freshSession({ amr: [{ method: 'otp', timestamp: s - 60 }], iat: s }, now) && !freshSession(null, now) && LIMITS.freshMinutes === 10);
check('…and made after the owner last reset access or revoked a phone (an old session refreshed later doesn\'t count)',
  !freshSession({ amr: [{ method: 'password', timestamp: s - 120 }] }, now, { after: new Date(now - 60000).toISOString() })
  && freshSession({ amr: [{ method: 'password', timestamp: s - 30 }] }, now, { after: new Date(now - 60000).toISOString() })
  && !freshSession({ amr: [{ method: 'password', timestamp: s - 30 }] }, now, { after: now - 10000 }) && freshSession({ amr: [{ method: 'password', timestamp: s - 30 }] }, now, { after: null })
  && latest(null, '2026-09-28T09:00:00Z', '2026-09-28T09:30:00Z') === Date.parse('2026-09-28T09:30:00Z') && latest(null, undefined) === null);

// ---------- rows and enrollment tokens ----------
check('member row: always active when added, with who added it and whether the owner gave a password', eq(memberRow({ userId: MEMBER, shopId: SHOP, name: 'Ravi', username: 'ravi', role: 'cashier', createdBy: SHOP }),
  { user_id: MEMBER, shop_id: SHOP, name: 'Ravi', username: 'ravi', role: 'cashier', status: 'active', created_by: SHOP, password_signin: false })
  && memberRow({ userId: MEMBER, shopId: SHOP, name: 'R', username: 'r', role: 'cashier', passwordSignin: true }).password_signin === true);
const dr = deviceRow({ shopId: SHOP, userId: MEMBER, deviceId: 'dev_12345678', deviceName: 'Tab', platform: '', keyHash: 'a'.repeat(64), changedBy: MEMBER });
check('device row: the key\'s hash only, never the key; who added it', eq(dr, { owner_id: SHOP, id: 'dev_12345678', user_id: MEMBER, name: 'Tab', platform: null, status: 'active', key_hash: 'a'.repeat(64), changed_by: MEMBER }));
check('enrollment row: the token\'s hash only (the database sets the 10-minute expiry)', eq(enrollmentRow({ shopId: SHOP, userId: MEMBER, tokenHash: 'b'.repeat(64), createdBy: SHOP }),
  { owner_id: SHOP, user_id: MEMBER, token_hash: 'b'.repeat(64), created_by: SHOP }));
check('revoking sets the status, the time and who did it; a reset notes when', eq(revokePatch(now), { status: 'revoked', revoked_at: '2026-09-28T10:00:00.000Z' })
  && eq(revokePatch(now, SHOP), { status: 'revoked', revoked_at: '2026-09-28T10:00:00.000Z', changed_by: SHOP })
  && eq(accessResetPatch(now, SHOP), { access_reset_at: '2026-09-28T10:00:00.000Z', changed_by: SHOP }) && BAN_FOREVER === '876000h');
const exp = (min) => new Date(now + min * 60000).toISOString();
check('a token works once, within its 10 minutes', redeemable({ expires_at: exp(5), used_at: null }, now).ok === true
  && redeemable(null, now).status === 404 && redeemable({ expires_at: exp(5), used_at: exp(-1) }, now).error === 'used'
  && redeemable({ expires_at: exp(-1), used_at: null }, now).error === 'expired' && redeemable({ expires_at: 'garbage', used_at: null }, now).error === 'expired');
check('what the app sees of a member (no password, no key)', eq(Object.keys(publicMember({ user_id: MEMBER, shop_id: SHOP, name: 'R', username: 'r', role: 'cashier', status: 'active', key_hash: 'x' })).sort(),
  ['created_at', 'last_seen_at', 'name', 'role', 'status', 'user_id', 'username']) && publicMember(null) === null);

// ---------- the function itself ----------
const fn = read('supabase/functions/team/index.ts'), readme = read('supabase/functions/team/README.md');
check('deployed without JWT verification, so it checks every caller itself (getUser, then the database\'s role)', /--no-verify-jwt/.test(readme) && /db\.auth\.getUser\(\)/.test(fn)
  && /db\.rpc\("hangtag_role"\)/.test(fn) && /role !== "owner"/.test(fn) && fn.indexOf('role !== "owner"') < fn.indexOf('r.action === "create_member"'));
check('the shop is the owner\'s own account (never a shop id from the request)', /const shopId: string = user\.id;/.test(fn) && !/body\.shop_id|r\.shopId/.test(fn));
check('the caller\'s device key goes along to the database (x-hangtag-device), and the browser may send it', /"x-hangtag-device": deviceKey/.test(fn) && /Allow-Headers[^\n]*x-hangtag-device/.test(fn));
check('only hashes are stored: sha256Hex of the token and of the device key', /tokenHash: await sha256Hex\(token\)/.test(fn) && /keyHash: await sha256Hex\(key\)/.test(fn) && /eq\("token_hash", tokenHash\)/.test(fn));
check('a QR token is used once (only while unused and unexpired), before the device is made', /\.is\("used_at", null\)\s*\n?\s*\.gt\("expires_at"/.test(fn) && fn.indexOf('.is("used_at", null)') < fn.indexOf('addDevice(m, r)'));
check('the one-time sign-in is a magic link\'s hashed token (no email sent); a phone registered by password needs a fresh sign-in', /generateLink\(\{ type: "magiclink", email \}\)/.test(fn) && /hashed_token/.test(fn)
  && /freshSession\(jwtClaims\(auth\), Date\.now\(\), \{ after \}\)/.test(fn) && /!m\.password_signin/.test(fn) && /latest\(m\.access_reset_at, /.test(fn));
check('disabling bans the account, revokes its devices and ends its sign-ins; reset_access revokes every device, ends the sign-ins and always replaces the password',
  /ban_duration: r\.status === "disabled" \? BAN_FOREVER : "none"/.test(fn) && /revokeAll\(shopId, m\.user_id, user\.id\)/.test(fn)
  && /password: r\.password \|\| newPassword\(\)/.test(fn) && (fn.match(/hangtag_end_sessions/g) || []).length >= 2 && /accessReset\(shopId, data\[0\]\.user_id, user\.id\)/.test(fn));
check('every change names who made it (changed_by), for the audit log', /changed_by: user\.id/.test(fn) && /revokePatch\(Date\.now\(\), user\.id\)/.test(fn) && /changedBy: m\.user_id/.test(fn));
check('new staff accounts: the staff address, confirmed, marked staff with their shop', /createUser\(\{ email: staffEmail\(r\.username, code\)/.test(fn) && /email_confirm: true/.test(fn) && /staff: true, shop_id: shopId/.test(fn));

// ---------- send-receipt and payment-gateway act for the shop ----------
const owner = { id: SHOP, email: 'owner@shop.in' }, staff = { id: MEMBER, email: 'ravi.ab12cd34ef@staff.hangtag.invalid' };
check('sending: a team member may send when its shop\'s owner is listed (by email or id); not when nobody of the shop is',
  allowedToSend(staff, { SEND_ALLOWED_USERS: 'owner@shop.in' }, owner) && allowedToSend(staff, { SEND_ALLOWED_USERS: SHOP }, owner)
  && !allowedToSend(staff, { SEND_ALLOWED_USERS: 'other@shop.in' }, owner) && !allowedToSend(staff, { SEND_ALLOWED_USERS: 'owner@shop.in' }, null)
  && allowedToSend(owner, { SEND_ALLOWED_USERS: 'owner@shop.in' }) && !allowedToSend(staff, {}, owner) && SEND_PERMISSION === 'create_sale');
check('payments: the same for PAYMENT_ALLOWED_USERS', allowedToPay(staff, { PAYMENT_ALLOWED_USERS: 'OWNER@shop.in' }, owner) && !allowedToPay(staff, { PAYMENT_ALLOWED_USERS: 'x@y.z' }, owner)
  && !allowedToPay(null, { PAYMENT_ALLOWED_USERS: '*' }, owner));
check('each payment action needs its permission from a member (refunds and settling unmatched money perform_return; seeing it view_reports); an unknown action the most',
  permissionFor('create') === 'create_sale' && permissionFor('refund_return') === 'perform_return' && permissionFor('resolve') === 'perform_return' && permissionFor('unmatched') === 'view_reports' && permissionFor('config') === null
  && permissionFor('nope') === 'manage_settings' && Object.keys(ACTION_PERMISSIONS).length === 8);
for (const name of ['send-receipt', 'payment-gateway']) {
  const src = read(`supabase/functions/${name}/index.ts`);
  const after = src.slice(src.indexOf('db.rpc("hangtag_shop_id")'));
  check(`${name}: the shop comes from the database with the caller's session and device key; every owner_id is the shop, never user.id`,
    /"x-hangtag-device": device/.test(src) && src.includes('db.rpc("hangtag_shop_id")') && !/owner_id", user\.id|ownerId: user\.id|owner_id: user\.id|eq\("id", user\.id\)/.test(src)
    && /getUserById\(shopId\)/.test(src) && /db\.rpc\("hangtag_can"/.test(after) && /Allow-Headers[^\n]*x-hangtag-device/.test(src));
}
check('extract-bill lets the browser send the device key', /Allow-Headers[^\n]*x-hangtag-device/.test(read('supabase/functions/extract-bill/index.ts')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
