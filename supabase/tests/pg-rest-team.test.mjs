// The browser tests' PostgREST + Auth stand-in (tests/helpers/pg-rest.mjs) with a team: each request runs as the user
// its bearer token names, with request.headers set (so a staff phone's x-hangtag-device reaches hangtag_shop_id()); the
// password and refresh grants and /auth/v1/verify sign in the right user; single-owner tests keep working unchanged.
// Driven with fake puppeteer requests (no browser). Run: npm run test:db
import crypto from 'crypto';
import { createPgRest } from '../../tests/helpers/pg-rest.mjs';

const SCHEMA = new URL('../schema.sql', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const A = 'aaaaaaaa-0000-4000-8000-000000000001', CA = 'aaaaaaaa-0000-4000-8000-000000000002', OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const KEY = 'device-key-of-ravi-0123456789abcdefghij';
const BASE = 'https://proj.supabase.co';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 500) : '')); };

/* a puppeteer-like request; call(pg, …) answers it and returns { status, body } */
async function call(pg, path, { method = 'GET', token, key, body, headers = {} } = {}) {
  let out = null;
  const h = { accept: 'application/json', apikey: 'publishable', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(key ? { 'x-hangtag-device': key } : {}), ...headers };
  const req = { url: () => BASE + path, method: () => method, headers: () => h, postData: () => (body === undefined ? undefined : JSON.stringify(body)),
    respond: (x) => { out = x; }, abort: () => { out = { status: 0, body: '' }; } };
  const handled = await pg.handle(req);
  if (!handled) return { status: -1 };
  return { status: out.status, body: out.body ? JSON.parse(out.body) : null };
}

const pg = await createPgRest(SCHEMA, { uid: A, email: 'owner@shop.in',
  users: [{ id: CA, email: 'ravi.aaaaaaaa00@staff.hangtag.invalid', password: 'secret123', meta: { full_name: 'Ravi', staff: true, shop_id: A } }] });
const owner = pg.session();
let r = await call(pg, '/rest/v1/hangtag_products', { method: 'POST', token: owner.access_token, body: { id: 'p1', name: 'Tee', price: 500 } });
check('the owner adds a product through the stand-in', r.status === 201, r);
await pg.db.query(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'Ravi', 'ravi', 'cashier')`, [CA, A]);
await pg.db.query(`INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, key_hash) VALUES ($1, 'dev-ravi-1', $2, 'Counter', $3)`, [A, CA, crypto.createHash('sha256').update(KEY).digest('hex')]);

console.log('=== signing in ===');
r = await call(pg, '/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'RAVI.aaaaaaaa00@staff.hangtag.invalid', password: 'secret123' } });
const staff = r.body;
check('password sign-in of a staff account gives that account\'s session', r.status === 200 && staff.user.id === CA && pg.subOf('Bearer ' + staff.access_token) === CA && staff.user.user_metadata.staff === true, r);
r = await call(pg, '/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'ravi.aaaaaaaa00@staff.hangtag.invalid', password: 'wrong-pass' } });
check('a wrong password is refused', r.status === 400 && r.body.error_code === 'invalid_credentials', r);
r = await call(pg, '/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'nobody@x.in', password: 'x' } });
check('…and an unknown email', r.status === 400, r);
r = await call(pg, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: staff.refresh_token } });
check('refreshing keeps the same account', r.status === 200 && r.body.user.id === CA && r.body.refresh_token === staff.refresh_token, r);
r = await call(pg, '/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: 'made-up' } });
check('an unknown refresh token is refused', r.status === 400, r);
r = await call(pg, '/auth/v1/user', { token: staff.access_token });
check('/auth/v1/user is the token\'s account', r.status === 200 && r.body.id === CA && r.body.email.startsWith('ravi.'), r);
const th = pg.magicLink('ravi.aaaaaaaa00@staff.hangtag.invalid');
r = await call(pg, '/auth/v1/verify', { method: 'POST', body: { type: 'magiclink', token_hash: th } });
check('verifyOtp with the one-time token hash (QR sign-in) signs in the staff account', r.status === 200 && r.body.user.id === CA, r);
r = await call(pg, '/auth/v1/verify', { method: 'POST', body: { type: 'magiclink', token_hash: th } });
check('…once only', r.status === 403, r);

console.log('=== requests run as the token\'s account, with its headers ===');
r = await call(pg, '/rest/v1/hangtag_products?select=id,name', { token: staff.access_token });
check('a staff token without the device key sees nothing', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, r);
r = await call(pg, '/rest/v1/hangtag_products?select=id,name', { token: staff.access_token, key: KEY });
check('with its device key it sees the shop\'s products', r.status === 200 && r.body.length === 1 && r.body[0].id === 'p1', r);
r = await call(pg, '/rest/v1/hangtag_products', { method: 'POST', token: staff.access_token, key: KEY, body: { id: 'p2', name: 'Cap', price: 1 } });
check('a cashier can\'t add a product (row security, 403)', r.status === 403 && r.body.code === '42501', r);
r = await call(pg, '/rest/v1/hangtag_customers', { method: 'POST', token: staff.access_token, key: KEY, body: { id: 'c1', name: 'Asha' } });
const c = (await pg.as(`SELECT owner_id::text AS o FROM public.hangtag_customers WHERE id = 'c1'`, [])).rows[0];
check('it adds a customer to the shop (owner_id = the owner)', r.status === 201 && c && c.o === A, { r, c });
r = await call(pg, '/rest/v1/rpc/hangtag_touch_device', { method: 'POST', token: staff.access_token, key: KEY, body: {} });
check('RPCs see the device too', r.status === 200 && r.body.shop_id === A && r.body.role === 'cashier' && r.body.device_id === 'dev-ravi-1', r);
r = await call(pg, '/rest/v1/hangtag_products?select=id', {});
check('with more than one account, a request without a user token is signed out (refused)', r.status === 403 || r.status === 400, r);
check('pg.as runs SQL as a member with its device headers', (await pg.as(`SELECT count(*)::int n FROM public.hangtag_products`, [], CA, { 'x-hangtag-device': KEY })).rows[0].n === 1
  && (await pg.as(`SELECT count(*)::int n FROM public.hangtag_products`, [], CA)).rows[0].n === 0);
await pg.addUser({ id: OTHER, email: 'other@shop.in', password: 'pw123456' });
r = await call(pg, '/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'other@shop.in', password: 'pw123456' } });
const other = r.body;
r = await call(pg, '/rest/v1/hangtag_products?select=id', { token: other.access_token });
check('an account added later signs in and sees only its own (empty) shop', other.user.id === OTHER && r.status === 200 && r.body.length === 0, r);
check('calls record who made them', pg.calls.some((x) => x.who === CA) && pg.calls.some((x) => x.who === A) && pg.calls.some((x) => x.who === null));

console.log('=== single-owner tests keep working ===');
{
  const solo = await createPgRest(SCHEMA, { uid: A, email: 'owner@shop.in' });
  r = await call(solo, '/auth/v1/token?grant_type=password', { method: 'POST', body: { email: 'whoever@x.in', password: 'x' } });
  check('any sign-in gives the owner\'s session (refresh token r1)', r.status === 200 && r.body.user.id === A && r.body.refresh_token === 'r1', r);
  r = await call(solo, '/rest/v1/hangtag_products', { method: 'POST', body: { id: 'p1', name: 'Tee', price: 500 } });
  const got = await call(solo, '/rest/v1/hangtag_products?select=id,owner_id');
  check('a request without a user token still runs as the owner', r.status === 201 && got.body.length === 1 && got.body[0].owner_id === A, { r, got });
  check('pg.as defaults to the owner', (await solo.as(`SELECT public.hangtag_shop_id()::text AS s`, [])).rows[0].s === A);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
