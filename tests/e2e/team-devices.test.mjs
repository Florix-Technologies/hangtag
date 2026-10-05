// Team access end to end in Chrome: the owner adds a cashier and shows a sign-in QR; a second phone opens the QR's link,
// is signed in as the cashier with its own device key, sells (the owner sees the bill after a download), can't edit
// products (hidden in the app AND refused by the database); the owner revokes the phone and the cashier's next request
// signs it out with "Device revoked". Also: a staff password sign-in on the Staff tab registers the phone once (signing out
// and in again reuses its key), a used QR code is refused plainly, and the owner's app shows nothing new but the team.
// Also (review fixes): a QR link opened where someone is signed in asks first; the cashier can't rewrite or remove the
// owner's bill, keeps a cash drawer in the account menu, and its phone downloads only what changed; resetting access
// without a password signs the phone out and kills the old password; a role with no screen sees a plain note.
// The database is PGlite running the real schema.sql behind the multi-user PostgREST stand-in (tests/helpers/pg-rest.mjs):
// each request runs as its token's user with its headers, so hangtag_shop_id() checks the device key for real. The team
// Edge Function is stubbed at /functions/v1/team, written like supabase/functions/team/index.ts (service role = pg.db,
// the same core.js for checks, tokens, hashes and rows).
import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import H from '../helpers/env.mjs';
import { createPgRest, CORS } from '../helpers/pg-rest.mjs';
import * as core from '../../supabase/functions/team/core.js';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const OWNER = 'aaaaaaaa-0000-4000-8000-00000000a0a1', EMAIL = 'owner.team@example.com', OTHER = 'bbbbbbbb-0000-4000-8000-00000000b0b1';
// a second shop's owner exists too, so requests without a user token run signed out (as on the real server)
const pg = await createPgRest(H.SCHEMA_PATH, { uid: OWNER, email: EMAIL, users: [{ id: OTHER, email: 'other.shop@example.com' }] });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, business_type, onboarded_at) VALUES ($1,$2,'Asha Owner','Aura Threads','9876543210','Pune','Maharashtra','Clothing boutique',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [OWNER, EMAIL]);
const q = async (sql, p = []) => (await pg.db.query(sql, p)).rows;

// ---------- the team Edge Function, stubbed like index.ts (service role: pg.db; checks, tokens, hashes: core.js) ----------
const teamCalls = [];
const reply = (r, status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
const refuse = (r, status, error, message) => reply(r, status, { ok: false, error, message });
async function insert(table, row) {
  const cols = Object.keys(row);
  return (await pg.db.query(`INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')}) RETURNING *`, cols.map((c) => row[c]))).rows[0];
}
const memberOf = async (shop, uid) => (await q(`SELECT * FROM public.hangtag_members WHERE shop_id = $1 AND user_id = $2`, [shop, uid]))[0];
const iso = (d) => (d instanceof Date ? d.toISOString() : d);
async function addDevice(m, v) {
  const n = +(await q(`SELECT count(*) AS n FROM public.hangtag_devices WHERE owner_id = $1 AND user_id = $2 AND status = 'active'`, [m.shop_id, m.user_id]))[0].n;
  if (n >= core.LIMITS.devicesPerMember) return null;
  const deviceId = core.newDeviceId(), key = core.newDeviceKey();
  await insert('hangtag_devices', core.deviceRow({ shopId: m.shop_id, userId: m.user_id, deviceId, deviceName: v.deviceName, platform: v.platform, keyHash: await core.sha256Hex(key), changedBy: m.user_id }));
  return { deviceId, key };
}
const shopName = async (shop) => ((await q(`SELECT shop_name FROM public.hangtag_profiles WHERE id = $1`, [shop]))[0] || {}).shop_name || null;
const teamFn = async (r) => {
  let body = {}; try { body = JSON.parse(r.postData() || '{}'); } catch { body = null; }
  const v = core.validateRequest(body);
  teamCalls.push(body && body.action);
  if (!v.ok) return refuse(r, v.status, v.error, v.message);
  const hdrs = r.headers();
  if (v.action === 'enroll_redeem') {
    const row = (await q(`SELECT * FROM public.hangtag_enrollments WHERE token_hash = $1`, [await core.sha256Hex(v.token)]))[0];
    const ok = core.redeemable(row && { ...row, used_at: iso(row.used_at), expires_at: iso(row.expires_at) }, Date.now());
    if (!ok.ok) return refuse(r, ok.status, ok.error, ok.message);
    const m = await memberOf(row.owner_id, row.user_id);
    if (!m || m.status !== 'active') return refuse(r, 403, 'disabled', 'This team member can\'t sign in. Ask the owner.');
    const used = await q(`UPDATE public.hangtag_enrollments SET used_at = now() WHERE id = $1 AND used_at IS NULL AND expires_at > now() RETURNING id`, [row.id]);
    if (!used.length) return refuse(r, 410, 'used', 'This QR code was used already. Ask the owner for a new one.');
    const dev = await addDevice(m, v);
    if (!dev) return refuse(r, 409, 'too_many_devices', 'Too many devices.');
    await q(`UPDATE public.hangtag_enrollments SET device_id = $2 WHERE id = $1`, [row.id, dev.deviceId]);
    const email = (await q(`SELECT email FROM auth.users WHERE id = $1`, [m.user_id]))[0].email;
    return reply(r, 200, { ok: true, token_hash: pg.magicLink(email), email, device_id: dev.deviceId, device_key: dev.key, shop_name: await shopName(m.shop_id),
      shop_code: core.shopCode(m.shop_id), role: m.role, name: m.name, username: m.username });
  }
  const auth = hdrs['authorization'], sub = pg.subOf(auth);
  if (!sub) return refuse(r, 401, 'unauthorized', 'Sign in first.');
  if (v.action === 'register_device') {
    const m = (await q(`SELECT * FROM public.hangtag_members WHERE user_id = $1`, [sub]))[0];
    if (!m) return refuse(r, 403, 'not_member', 'Only team members add their phones here.');
    if (m.status !== 'active') return refuse(r, 403, 'disabled', 'This team member can\'t sign in. Ask the owner.');
    if (!m.password_signin) return refuse(r, 403, 'qr_only', 'This team member signs in with a QR code from the owner.');
    const rv = (await q(`SELECT max(revoked_at) AS t FROM public.hangtag_devices WHERE owner_id = $1 AND user_id = $2`, [m.shop_id, m.user_id]))[0].t;
    if (!core.freshSession(core.jwtClaims(auth), Date.now(), { after: core.latest(iso(m.access_reset_at), iso(rv)) })) return refuse(r, 401, 'stale_session', 'Sign in again with your password to add this phone.');
    const dev = await addDevice(m, v);
    return reply(r, 200, { ok: true, device_id: dev.deviceId, device_key: dev.key, shop_name: await shopName(m.shop_id), shop_code: core.shopCode(m.shop_id), role: m.role, name: m.name, username: m.username });
  }
  // the owner, as the database sees the caller (its own session and headers)
  const role = (await pg.as('SELECT public.hangtag_role() AS r', [], sub, hdrs)).rows[0].r;
  if (role !== 'owner') return refuse(r, 403, 'forbidden', 'Only the shop\'s owner can manage the team.');
  const shop = sub;
  if (v.action === 'create_member') {
    if ((await q(`SELECT 1 FROM public.hangtag_members WHERE shop_id = $1 AND username = $2`, [shop, v.username])).length) return refuse(r, 409, 'username_taken', 'That username is taken in this shop. Choose another.');
    const code = core.shopCode(shop), id = crypto.randomUUID();
    await pg.addUser({ id, email: core.staffEmail(v.username, code), password: v.password || core.newPassword(), meta: { full_name: v.name, staff: true, shop_id: shop } });
    const m = await insert('hangtag_members', core.memberRow({ userId: id, shopId: shop, name: v.name, username: v.username, role: v.role, createdBy: sub, passwordSignin: !!v.password }));
    return reply(r, 200, { ok: true, user_id: id, shop_code: code, username: v.username, member: core.publicMember({ ...m, created_at: iso(m.created_at), last_seen_at: iso(m.last_seen_at) }) });
  }
  if (v.action === 'revoke_device' || v.action === 'remove_device') {
    if (v.action === 'remove_device') await q(`UPDATE public.hangtag_devices SET changed_by = $3 WHERE owner_id = $1 AND id = $2`, [shop, v.deviceId, sub]);
    const rows = v.action === 'revoke_device'
      ? await q(`UPDATE public.hangtag_devices SET status = 'revoked', revoked_at = now(), changed_by = $3 WHERE owner_id = $1 AND id = $2 AND status = 'active' RETURNING id, user_id`, [shop, v.deviceId, sub])
      : await q(`DELETE FROM public.hangtag_devices WHERE owner_id = $1 AND id = $2 RETURNING id, user_id`, [shop, v.deviceId]);
    if (!rows.length && !(await q(`SELECT 1 FROM public.hangtag_devices WHERE owner_id = $1 AND id = $2`, [shop, v.deviceId])).length) return refuse(r, 404, 'not_found', 'That device wasn\'t found.');
    if (rows.length && v.action === 'revoke_device') await q(`UPDATE public.hangtag_members SET access_reset_at = now(), changed_by = $3 WHERE shop_id = $1 AND user_id = $2`, [shop, rows[0].user_id, sub]);
    return reply(r, 200, { ok: true, device_id: v.deviceId, sessions_ended: false });
  }
  const m = await memberOf(shop, v.userId);
  if (!m) return refuse(r, 404, 'not_found', 'That team member wasn\'t found.');
  if (v.action === 'enroll_start') {
    const token = core.newToken();
    await q(`DELETE FROM public.hangtag_enrollments WHERE owner_id = $1 AND user_id = $2 AND used_at IS NULL`, [shop, m.user_id]);
    const row = await insert('hangtag_enrollments', core.enrollmentRow({ shopId: shop, userId: m.user_id, tokenHash: await core.sha256Hex(token), createdBy: sub }));
    return reply(r, 200, { ok: true, token, expires_at: iso(row.expires_at) });
  }
  if (v.action === 'update_member') {
    const up = (await q(`UPDATE public.hangtag_members SET name = COALESCE($3, name), role = COALESCE($4, role), status = COALESCE($5, status), changed_by = $6 WHERE shop_id = $1 AND user_id = $2 RETURNING *`,
      [shop, m.user_id, v.name ?? null, v.role ?? null, v.status ?? null, sub]))[0];
    const revoked = v.status === 'disabled' ? (await q(`UPDATE public.hangtag_devices SET status = 'revoked', revoked_at = now(), changed_by = $3 WHERE owner_id = $1 AND user_id = $2 AND status = 'active' RETURNING id`, [shop, m.user_id, sub])).length : 0;
    return reply(r, 200, { ok: true, member: core.publicMember({ ...up, created_at: iso(up.created_at), last_seen_at: iso(up.last_seen_at) }), revoked });
  }
  if (v.action === 'reset_access') {
    pg.setPassword(m.user_id, v.password || core.newPassword());   // the old password always stops working
    const revoked = (await q(`UPDATE public.hangtag_devices SET status = 'revoked', revoked_at = now(), changed_by = $3 WHERE owner_id = $1 AND user_id = $2 AND status = 'active' RETURNING id`, [shop, m.user_id, sub])).length;
    await q(`UPDATE public.hangtag_members SET access_reset_at = now(), password_signin = $3, changed_by = $4 WHERE shop_id = $1 AND user_id = $2`, [shop, m.user_id, !!v.password, sub]);
    return reply(r, 200, { ok: true, revoked, password_changed: true, password_set: !!v.password, sessions_ended: false });
  }
  if (v.action === 'remove_member') { await q(`DELETE FROM auth.users WHERE id = $1`, [m.user_id]); return reply(r, 200, { ok: true, user_id: m.user_id }); }
  return refuse(r, 400, 'bad_request', 'Unknown action.');
};
// the other functions a till asks on connect: not set up here
const notSetUp = (r) => { const b = JSON.parse(r.postData() || '{}'); if (b.action === 'channels') return reply(r, 200, { ok: true, channels: { email: false, whatsapp: false, sms: false } }); return reply(r, 200, { ok: false, error: 'not_configured', message: 'Not set up.' }); };
const FUNCTIONS = { '/functions/v1/team': teamFn, '/functions/v1/payment-gateway': notSetUp, '/functions/v1/send-receipt': notSetUp };

// ---------- browsers ----------
const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function phone(label, { session = null, width = 420, height = 880 } = {}) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage();
  await p.setViewport({ width, height });
  p.on('pageerror', (e) => { fails++; console.log(`[${label} pageerror]`, e.message); });
  p.on('dialog', (d) => d.accept(''));
  p.sbRequests = [];
  await p.setRequestInterception(true);
  p.on('request', async (r) => {
    const u = r.url();
    if (u.startsWith('http://localhost:3210/')) return (u.split('#')[0] === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
    if (u.includes('.supabase.co/')) {
      if (r.method() !== 'OPTIONS') p.sbRequests.push({ path: new URL(u).pathname, device: r.headers()['x-hangtag-device'] || '', sub: pg.subOf(r.headers()['authorization']) });
      if (!(await pg.handle(r, FUNCTIONS))) r.abort(); return;
    }
    r.continue();
  });
  if (session) await p.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost' && !sessionStorage.__seeded) { sessionStorage.__seeded = 1; localStorage.setItem('hangtag-auth', s); } }, JSON.stringify(session));
  p.run = (b) => p.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
  p.until = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await p.run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; };
  p.vis = (sel) => p.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
  p.text = (sel) => p.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
  const typeKeys = p.type.bind(p);
  p.fill = async (sel, v) => { await p.$eval(sel, (e) => { e.value = ''; }); await typeKeys(sel, v); };
  return p;
}

try {
  // ================= the owner =================
  const A = await phone('owner', { session: pg.session(), width: 1180, height: 900 });
  await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  check('owner: signed in and connected', await A.until('sbStatus==="connected"'));
  check('owner: nothing hidden, every tab, no role marks on the page (unchanged for owners)', await A.run(`return !isMember()&&!document.documentElement.hasAttribute("data-noperm")&&!document.documentElement.hasAttribute("data-member")`)
    && await A.vis('.nav [data-tab="report"]') && await A.vis('.nav [data-tab="stock"]') && await A.run('return tabOpen("products")&&tabOpen("report")&&tabOpen("customers")'));
  check('owner: requests carry no device header (owners have none)', A.sbRequests.length > 0 && A.sbRequests.every((x) => !x.device));
  await A.run('loadExamples();await new Promise(r=>setTimeout(r,300));await flushSbQueue()');
  check('owner: products uploaded', +(await q(`SELECT count(*) AS n FROM public.hangtag_products WHERE owner_id = $1`, [OWNER]))[0].n === 10);

  console.log('--- the owner adds a cashier with a sign-in QR ---');
  await A.run('openSettings("devices")'); await sleep(200);
  check('Settings → Team & Devices shows the team with the shop code', await A.vis('#teamSec [data-team="open"]') && (await A.text('#teamSec')).includes(core.shopCode(OWNER)));
  await A.click('#teamSec [data-team="open"]');
  check('Team & devices opens (empty team)', await A.until('team&&!team.loading') && /No team members yet/.test(await A.text('.teamsheet') || ''));
  await A.click('[data-team="add"]'); await sleep(150);
  const roleOpts = await A.$$eval('#teamAddForm [name=role] option', (o) => o.map((x) => x.value));
  check('roles offered for a clothing shop: manager and cashier (cashier chosen)', JSON.stringify(roleOpts) === '["manager","cashier"]' && await A.$eval('#teamAddForm [name=role]', (s) => s.value) === 'cashier', roleOpts);
  await A.fill('#teamAddForm [name=name]', 'Ravi Kumar'); await A.fill('#teamAddForm [name=username]', 'Ravi');
  await A.click('#teamAddForm button[type=submit]');
  check('the QR appears with a 10-minute countdown', await A.until('document.querySelector(".enrollqr[data-enroll-url]")') && await A.vis('.enrollqr .qrbox svg')
    && /^(10:00|9:5\d)$/.test(await A.text('[data-countdown]') || ''), await A.text('.teamsheet'));
  const url = await A.$eval('.enrollqr', (e) => e.dataset.enrollUrl);
  const token = (/#enroll=([A-Za-z0-9_-]{43})$/.exec(url) || [])[1];
  check('the QR is <app>#enroll=<single-use code>: no password, no key', url.startsWith('http://localhost:3210/#enroll=') && !!token, url);
  const ravi = (await q(`SELECT * FROM public.hangtag_members WHERE shop_id = $1 AND username = 'ravi'`, [OWNER]))[0];
  check('the member exists: cashier, active, username in lower case', ravi && ravi.role === 'cashier' && ravi.status === 'active' && ravi.name === 'Ravi Kumar', ravi);
  const enr = (await q(`SELECT * FROM public.hangtag_enrollments WHERE user_id = $1`, [ravi.user_id]));
  check('only the code\'s hash is stored', enr.length === 1 && enr[0].token_hash === await core.sha256Hex(token) && !JSON.stringify(enr).includes(token));
  await A.screenshot({ path: H.ARTIFACTS + '/team1_owner_qr.png' });

  console.log('--- the cashier\'s phone opens the QR link ---');
  const B = await phone('cashier');
  await B.goto(url, { waitUntil: 'domcontentloaded' });
  check('the phone is signed in as the cashier and connected', await B.until('authUser&&sbStatus==="connected"&&products().length===10', 25000), await B.run('return {u:authUser&&authUser.email,s:sbStatus,a:access,err:document.getElementById("authErr").textContent}').catch((e) => e.message));
  check('the code left the address bar at once', await B.run('return location.hash===""'));
  const bKey = await B.run('return JSON.parse(localStorage.getItem("hangtag_device_key")||"null")');
  const dev = (await q(`SELECT * FROM public.hangtag_devices WHERE user_id = $1`, [ravi.user_id]));
  check('it has its own device key; the database keeps only its hash (active)', typeof bKey === 'string' && bKey.length === 43 && dev.length === 1 && dev[0].key_hash === await core.sha256Hex(bKey) && dev[0].status === 'active', dev);
  check('the code is used up', (await q(`SELECT used_at FROM public.hangtag_enrollments WHERE user_id = $1`, [ravi.user_id]))[0].used_at !== null);
  check('the app knows it is a cashier of Aura Threads', await B.run(`return isMember()&&access.role==="cashier"&&access.shopId===${JSON.stringify(OWNER)}&&signedInAs()==="Ravi Kumar (Cashier) at Aura Threads"`), await B.run('return access'));
  check('no shop setup screen for a member; the shop\'s own profile is used', await B.run('return document.getElementById("setupGate").hidden&&profile&&profile.shop_name==="Aura Threads"'));
  check('"Signed in as Ravi Kumar (Cashier) at Aura Threads" on the account button', (await B.$eval('#acctBtn', (b) => b.title)) === 'Signed in as Ravi Kumar (Cashier) at Aura Threads', await B.$eval('#acctBtn', (b) => b.title));
  const signedIn = B.sbRequests.filter((x) => x.sub === ravi.user_id && /^\/(rest|functions)\//.test(x.path));
  check('every request of the signed-in cashier carries its device key', signedIn.length > 3 && signedIn.every((x) => x.device === bKey), signedIn.filter((x) => x.device !== bKey).slice(0, 3));
  check('"last seen" of the phone and the member are kept (hangtag_touch_device)', (await q(`SELECT last_seen_at FROM public.hangtag_devices WHERE user_id = $1`, [ravi.user_id]))[0].last_seen_at !== null
    && (await q(`SELECT last_seen_at FROM public.hangtag_members WHERE user_id = $1`, [ravi.user_id]))[0].last_seen_at !== null);
  check('no live updates for a member\'s phone (it polls)', await B.run('return !sbRealtimeChannel'));

  console.log('--- what a cashier may and may not do ---');
  // the phone bar is the same for everyone (Home · Sell · Bills · Stock · More); the role decides what is in it and in More
  const cashierBar = await B.$$eval('.nav .navi.pb', (l) => l.filter((x) => x.getClientRects().length).map((x) => x.dataset.tab));
  check('cashier phone workflow: Home · Sell · Bills · Stock (to look stock up) and More; no Reports, no Products', JSON.stringify(cashierBar) === JSON.stringify(['home', 'sell', 'bills', 'stock'])
    && !(await B.vis('.nav [data-tab="report"]')) && !(await B.vis('.nav [data-tab="products"]'))
    && await B.run('return tabOpen("products")&&tabOpen("stock")&&tabOpen("customers")&&!tabOpen("report")'), cashierBar);
  await B.run('openNavMore()'); await sleep(150);
  check('...Customers is in the cashier\'s More, Reports is not', await B.vis('#modalHost .navsheet [data-tab="customers"]') && !(await B.vis('#modalHost .navsheet [data-tab="report"]')));
  await B.run('closeModal()');
  await B.run('setTab("report")'); await sleep(100);
  check('...and Reports can\'t be opened', (await B.run('return prefs.tab')) !== 'report');
  // The desktop workflow still exposes Products read-only; permission enforcement hides every write control there.
  await B.setViewport({ width: 800, height: 880 }); await B.run('renderAll();setTab("products")'); await sleep(200);
  check('Products: the Edit and Add buttons are hidden', await B.run('return document.querySelectorAll("#prodBody [data-editp]").length>0') && !(await B.vis('#prodBody [data-editp]')) && !(await B.vis('#prodBody [data-act="addp"]')));
  await B.run('openEditor("p1")'); await sleep(150);
  check('opening the product editor anyway is refused, with a plain reason', (await B.run('return editor')) === null && /can't add or edit products/.test(await B.text('#toastHost') || ''), await B.text('#toastHost'));
  const direct = await B.run(`const a=await sbClient.from("hangtag_products").insert({id:"hack1",name:"Hacked",price:1});const b=await sbClient.from("hangtag_products").update({name:"Hacked"}).eq("id","p1");return {a:a.error&&a.error.code,b:b.error&&b.error.code}`);
  const p1 = (await q(`SELECT name FROM public.hangtag_products WHERE owner_id = $1 AND id = 'p1'`, [OWNER]))[0];
  check('the database refuses a direct product write from the cashier (insert refused, update changes nothing)', direct.a === '42501' && p1.name !== 'Hacked'
    && !(await q(`SELECT 1 FROM public.hangtag_products WHERE id = 'hack1'`)).length, { direct, p1 });
  await B.setViewport({ width: 420, height: 880 }); await B.run('renderAll();setTab("sell")'); await sleep(150);
  await B.run(`const v=prod("p1").variants[0].id;addToLines(cart,v,1);await checkout("cash");closeSheets();await flushSbQueue()`);
  const sales = await q(`SELECT id, owner_id::text, total FROM public.hangtag_sales`);
  check('the cashier sells: the bill is saved in the owner\'s shop', sales.length === 1 && sales[0].owner_id === OWNER && (await B.run('return sbOfflineQueue.length')) === 0, sales);
  await A.run('await pullFromSupabase(false)');
  check('the owner sees the cashier\'s bill after a download', await A.run(`return D().sales.some(s=>s.id===${JSON.stringify(sales[0] && sales[0].id)})`));
  await B.screenshot({ path: H.ARTIFACTS + '/team2_cashier_phone.png' });

  console.log('--- the owner\'s bills are history for the cashier; the phone downloads only what changed ---');
  const ownerBill = await A.run(`const v=prod("p1").variants[0].id;addToLines(cart,v,1);const s=await checkout("cash");closeSheets();await flushSbQueue();return s&&s.id`);
  const tamper = await B.run(`const a=await sbClient.from("hangtag_sales").update({total:1,subtotal:1}).eq("id",${JSON.stringify(ownerBill)});
    const b=await sbClient.from("hangtag_sales").delete().eq("id",${JSON.stringify(ownerBill)}).select("id");
    const c=await sbClient.from("hangtag_payments").delete().eq("sale_id",${JSON.stringify(ownerBill)}).select("id");
    return {a:a.error&&a.error.code,b:(b.data||[]).length,c:(c.data||[]).length}`);
  const ob = (await q(`SELECT total, (SELECT count(*) FROM public.hangtag_payments p WHERE p.owner_id = s.owner_id AND p.sale_id = s.id)::int AS pays FROM public.hangtag_sales s WHERE id = $1`, [ownerBill]))[0];
  check('the cashier can\'t rewrite the owner\'s bill (refused) nor remove it or its payment (nothing removed)', !!ownerBill && tamper.a === '42501' && tamper.b === 0 && tamper.c === 0 && ob && +ob.total > 1 && ob.pays === 1, { tamper, ob });
  await B.run('await memberPoll()');
  check('the cashier\'s phone picks up the owner\'s new bill on its next check', await B.run(`return D().sales.some(s=>s.id===${JSON.stringify(ownerBill)})`));
  await pg.as(`INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c-poll', 'Neha', '9811111111')`, [], OWNER);
  B.sbRequests.length = 0;
  await B.run('await memberPoll()');
  const polled = B.sbRequests.map((x) => x.path);
  check('…and after a new customer only the customers: one small question, no photos, products or bills downloaded again',
    await B.run('return !!customers["c-poll"]') && polled.includes('/rest/v1/rpc/hangtag_shop_changes') && polled.includes('/rest/v1/hangtag_customers')
    && !polled.some((p) => /hangtag_(images|products|variants|sales|sale_items|payments|stock_moves)$/.test(p)), polled);
  B.sbRequests.length = 0;
  await B.run('await memberPoll()');
  check('nothing new: the check downloads nothing', B.sbRequests.every((x) => /rpc\/hangtag_(touch_device|shop_changes|purchase_changes|order_changes|biz_changes)$|hangtag_(members|roles)$/.test(x.path)), B.sbRequests.map((x) => x.path));

  console.log('--- the cashier\'s cash drawer (no Reports tab) ---');
  await B.click('#acctBtn'); await sleep(100);
  check('the account menu has the cash drawer: opening float, cash in, cash out, expense, close the day', await B.vis('#acctMenu [data-am="cash:in"]') && await B.vis('#acctMenu [data-am="cash:close"]'));
  await B.click('#acctMenu [data-am="cash:in"]'); await sleep(150);
  await B.fill('#cashForm [name=amount]', '200'); await B.fill('#cashForm [name=reason]', 'Change from the bank');
  await B.click('#cashForm button[type=submit]');
  check('the cashier records cash in: saved in the shop', await B.until('!sbOfflineQueue.length&&Object.keys(cashMoves||{}).length>0')
    && (await q(`SELECT owner_id::text AS o, amount FROM public.hangtag_cash_moves WHERE reason = 'Change from the bank'`)).some((x) => x.o === OWNER && +x.amount === 200));

  console.log('--- the owner revokes the phone ---');
  await A.run('openTeam("members")'); await A.until('team&&!team.loading&&team.devices.length===1');
  check('the owner sees Ravi\'s phone, active, last seen', /Active · last seen/.test(await A.text(`[data-device="${dev[0].id}"]`) || ''), await A.text(`[data-device="${dev[0].id}"]`));
  await A.click(`[data-team="revoke:${dev[0].id}"]`); await sleep(100);
  check('revoking asks for a second tap', /Tap again/.test(await A.text(`[data-team="revoke:${dev[0].id}"]`) || ''));
  await A.click(`[data-team="revoke:${dev[0].id}"]`);
  check('the device is revoked in the database', await A.until('team&&!team.busy&&team.devices[0]&&team.devices[0].status==="revoked"') && (await q(`SELECT status FROM public.hangtag_devices WHERE id = $1`, [dev[0].id]))[0].status === 'revoked');
  const second = await B.run(`const v=prod("p1").variants[0].id;addToLines(cart,v,1);const s=await checkout("cash");closeSheets();await flushSbQueue();return s&&s.id`);
  check('the cashier rings up another bill (saved on the phone first)', !!second);
  check('the cashier\'s next request fails and the phone is signed out: "Device revoked"', await B.until('!authUser&&!document.getElementById("authGate").hidden', 15000)
    && /Device revoked/.test(await B.text('#authErr') || ''), await B.text('#authErr'));
  check('its key is forgotten; the unsent bill stays on the phone for the member', await B.run('return localStorage.getItem("hangtag_device_key")===null&&JSON.parse(localStorage.getItem("hangtag_sb_queue")||"[]").some(x=>x.type==="sale")'));
  check('nothing reached the shop from the revoked phone', (await q(`SELECT count(*) AS n FROM public.hangtag_sales WHERE id = $1`, [second]))[0].n == 0);
  await B.screenshot({ path: H.ARTIFACTS + '/team3_revoked.png' });

  console.log('--- a used QR code is refused plainly ---');
  const C = await phone('used-qr');
  await C.goto(url, { waitUntil: 'domcontentloaded' });
  check('"This QR code was used already", on the Staff tab, nobody signed in', await C.until('!document.getElementById("authErr").hidden') && /used already/.test(await C.text('#authErr') || '')
    && await C.run('return !authUser&&emailMode==="staff"&&localStorage.getItem("hangtag_device_key")===null'), await C.text('#authErr'));

  console.log('--- a QR link opened where someone is signed in asks first ---');
  const tok2 = await A.run(`return (await teamService().enrollStart(${JSON.stringify(ravi.user_id)})).token`);
  await A.goto('http://localhost:3210/#enroll=' + tok2, { waitUntil: 'domcontentloaded' });
  check('the owner\'s till asks before joining another shop as a team member (nothing redeemed yet)', await A.until('!document.getElementById("enrollAsk").hidden', 15000)
    && (await A.text('#authMsg') || '').includes(EMAIL) && (await q(`SELECT used_at FROM public.hangtag_enrollments WHERE token_hash = $1`, [await core.sha256Hex(tok2)]))[0].used_at === null, await A.text('#authMsg'));
  await A.click('#enrollNo');
  check('"Cancel, stay signed in": the owner stays signed in; the code is still unused', await A.until(`authUser&&authUser.email===${JSON.stringify(EMAIL)}&&document.getElementById("authGate").hidden&&sbStatus==="connected"`, 15000)
    && !(await A.run('return isMember()')) && (await q(`SELECT used_at FROM public.hangtag_enrollments WHERE token_hash = $1`, [await core.sha256Hex(tok2)]))[0].used_at === null);

  console.log('--- staff password sign-in: the phone is registered once ---');
  await A.run(`await teamService().createMember({name:"Meera",username:"meera",role:"manager",password:"counter-pass-1"})`);
  const meera = (await q(`SELECT user_id FROM public.hangtag_members WHERE username = 'meera'`))[0].user_id;
  const D = await phone('manager');
  await D.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' });
  await D.until('!document.getElementById("authForms").hidden');
  check('the sign-in screen has a secondary Staff sign-in link and no mode tabs', await D.vis('#staffSwitch [data-switchto="staff"]') && !(await D.$('[data-authtab]')));
  await D.click('#staffSwitch [data-switchto="staff"]'); await sleep(100);
  check('Staff: shop code, username and password; no Google, no email', await D.vis('#staffShop') && await D.vis('#staffUser') && await D.vis('#staffPass') && !(await D.vis('#authEmail')) && !(await D.vis('[data-provider="google"]')));
  await D.fill('#staffShop', core.shopCode(OWNER).toUpperCase()); await D.fill('#staffUser', 'meera'); await D.fill('#staffPass', 'wrong-pass-9');
  await D.click('#staffSubmit');
  check('a wrong password: plain message', await D.until('!document.getElementById("authErr").hidden') && (await D.text('#authErr')) === 'Wrong shop code, username or password.', await D.text('#authErr'));
  await D.fill('#staffPass', 'counter-pass-1'); await D.click('#staffSubmit');
  check('the right one: signed in as the manager, this phone registered', await D.until('authUser&&sbStatus==="connected"&&isMember()', 20000) && await D.run('return access.role==="manager"')
    && +(await q(`SELECT count(*) AS n FROM public.hangtag_devices WHERE user_id = $1`, [meera]))[0].n === 1, await D.text('#authErr'));
  // on a phone Reports is under More (the bar is Home · Sell · Stock)
  await D.click('.nav [data-navmore]'); await sleep(200);
  const reportInMore = await D.vis('.navsheet [data-tab="report"]');
  await D.run('closeModal()'); await sleep(100);
  const managerAccess = { report: reportInMore, permissions: await D.run('return {products:can("manage_products"),users:can("manage_users")}'), settings: await D.run('openSettings("devices");return {team:!!document.getElementById("teamSec"),you:!!document.getElementById("kvRole"),sub:document.getElementById("setSub").textContent}') };
  check('a manager sees Reports and can edit products, but has no Team & devices', managerAccess.report && managerAccess.permissions.products && !managerAccess.permissions.users
    && !managerAccess.settings.team && managerAccess.settings.you && /Signed in as Meera \(Manager\) at Aura Threads/.test(managerAccess.settings.sub), managerAccess);
  await D.run('closeSettings();await requestSignOut()'); await sleep(300);
  check('signing out puts the key away (not sent any more)', await D.run('return !authUser&&localStorage.getItem("hangtag_device_key")===null'));
  await D.click('#staffSwitch [data-switchto="staff"]'); await sleep(100);
  await D.fill('#staffShop', core.shopCode(OWNER)); await D.fill('#staffUser', 'meera'); await D.fill('#staffPass', 'counter-pass-1'); await D.click('#staffSubmit');
  check('signing in again reuses the phone\'s key: no second device', await D.until('authUser&&sbStatus==="connected"&&isMember()', 20000)
    && +(await q(`SELECT count(*) AS n FROM public.hangtag_devices WHERE user_id = $1`, [meera]))[0].n === 1 && teamCalls.filter((x) => x === 'register_device').length === 1, teamCalls);

  console.log('--- the owner switches the manager off, then removes her ---');
  await A.run('openTeam("members")'); await A.until('team&&!team.loading&&team.members.length===2');
  await A.click(`[data-team="disable:${meera}"]`); await sleep(80); await A.click(`[data-team="disable:${meera}"]`);
  check('disabled: the member is off and every phone of hers is revoked', await A.until(`team&&!team.busy&&team.members.some(m=>m.userId===${JSON.stringify(meera)}&&m.status==="disabled")`)
    && (await q(`SELECT status FROM public.hangtag_members WHERE user_id = $1`, [meera]))[0].status === 'disabled'
    && (await q(`SELECT status FROM public.hangtag_devices WHERE user_id = $1`, [meera])).every((d) => d.status === 'revoked'));
  await D.run('await memberPoll()');
  check('her phone finds out on its next check and signs out', await D.until('!authUser&&!document.getElementById("authGate").hidden') && /Device revoked/.test(await D.text('#authErr') || ''));
  await A.click(`[data-team="remove:${meera}"]`); await sleep(80); await A.click(`[data-team="remove:${meera}"]`);
  check('removed: her account and member row are gone', await A.until(`team&&!team.busy&&!team.members.some(m=>m.userId===${JSON.stringify(meera)})`)
    && !(await q(`SELECT 1 FROM public.hangtag_members WHERE user_id = $1`, [meera])).length);

  console.log('--- roles & permissions ---');
  await A.run('openTeam("roles")'); await A.until('team&&!team.loading');
  check('Roles & permissions: a grid for manager and cashier', await A.vis('.rolegrid') && (await A.$$eval('.rolegrid thead th', (t) => t.map((x) => x.textContent))).join() === 'Permission,Manager,Cashier');
  await A.click('[data-perm="cashier:view_reports"]'); await sleep(50);
  await A.click('[data-team="saveroles"]');
  check('saved to hangtag_roles for this shop', await A.until('team&&!team.busy&&!team.draft') && ((await q(`SELECT permissions FROM public.hangtag_roles WHERE owner_id = $1 AND role = 'cashier'`, [OWNER]))[0] || {}).permissions.includes('view_reports'));
  await A.screenshot({ path: H.ARTIFACTS + '/team4_roles.png' });

  const staffSignIn = async (p, user, pw) => { await p.until('!document.getElementById("authForms").hidden'); await p.click('#staffSwitch [data-switchto="staff"]'); await sleep(80);
    await p.fill('#staffShop', core.shopCode(OWNER)); await p.fill('#staffUser', user); await p.fill('#staffPass', pw); await p.click('#staffSubmit'); };
  console.log('--- reset access without a password: the phone is signed out and the old password dies ---');
  await A.run(`await teamService().createMember({name:"Sunil",username:"sunil",role:"cashier",password:"sunil-pass-1"})`);
  const sunil = (await q(`SELECT user_id FROM public.hangtag_members WHERE username = 'sunil'`))[0].user_id;
  const E = await phone('sunil');
  await E.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' });
  await staffSignIn(E, 'sunil', 'sunil-pass-1');
  check('Sunil signs in through Staff sign-in and the phone is registered', await E.until('authUser&&sbStatus==="connected"&&isMember()', 20000));
  await A.run('openTeam("members")'); await A.until('team&&!team.loading&&team.members.some(m=>m.username==="sunil")');
  await A.click(`[data-team="reset:${sunil}"]`); await sleep(80); await A.click(`[data-team="reset:${sunil}"]`);
  check('the owner resets his access (no new password)', await A.until('team&&!team.busy') && (await q(`SELECT status FROM public.hangtag_devices WHERE user_id = $1`, [sunil])).every((d) => d.status === 'revoked'));
  const sm = (await q(`SELECT password_signin, access_reset_at FROM public.hangtag_members WHERE user_id = $1`, [sunil]))[0];
  const rl = (await q(`SELECT action, user_id::text AS u FROM public.hangtag_audit_log WHERE entity = 'members' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [sunil]))[0];
  check('…noted in the database (QR only from now on, when) and in the audit log as a reset by the owner', sm.password_signin === false && !!sm.access_reset_at && rl && rl.action === 'reset' && rl.u === OWNER, { sm, rl });
  await E.run('await memberPoll()');
  check('his phone is signed out on its next check ("Device revoked")', await E.until('!authUser&&!document.getElementById("authGate").hidden') && /Device revoked/.test(await E.text('#authErr') || ''));
  const regs = teamCalls.filter((x) => x === 'register_device').length;
  await staffSignIn(E, 'sunil', 'sunil-pass-1');
  check('his old password no longer signs in (and no phone is added)', await E.until('!document.getElementById("authErr").hidden&&/Wrong shop code/.test(document.getElementById("authErr").textContent)')
    && await E.run('return !authUser') && teamCalls.filter((x) => x === 'register_device').length === regs, await E.text('#authErr'));

  console.log('--- a role with no screen yet sees a plain note ---');
  await A.run(`await teamService().createMember({name:"Kiran",username:"kiran",role:"kitchen",password:"kitchen-pass-1"})`);
  const F = await phone('kitchen');
  await F.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' });
  await staffSignIn(F, 'kiran', 'kitchen-pass-1');
  check('kitchen: signed in, no tab, no till: "Nothing to open here yet"', await F.until('authUser&&sbStatus==="connected"&&isMember()&&!$("#v-none").hidden', 20000) && await F.vis('#v-none')
    && !(await F.vis('#v-sell')) && !(await F.vis('.nav [data-tab="sell"]')) && !(await F.vis('#billBar')) && /Nothing to open here yet/.test(await F.text('#v-none') || ''));
} catch (e) { fails++; console.log('FAIL exception', e && e.stack || e); }
finally { await browser.close(); }
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
