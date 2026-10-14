// The live incident of 2026-10-13, reproduced end to end in Chrome with the real app and the real supabase-js (the version
// index.html pins), against PGlite running the real schema.sql behind the PostgREST stand-in (row security on):
//   1. two shops; the signed-in owner (A) downloads only its own records;
//   2. the first migration's six "Public access to …" policies come back (always true, as on the live project from 20:44
//      IST): the app's full download now brings shop B's products onto A's device, then stops at the settings — the
//      server answers the single-row read with 200 and one row per shop, and supabase-js refuses it itself (PGRST116) —
//      "Pull from Supabase failed", and the diagnostics say which read: "more than one row (table:hangtag_meta)". The bills
//      download on its own (a team member's phone runs it outside the full download too) brings shop B's bill as well;
//   3. the six are dropped again (the containment of 23:45 IST): the next full download succeeds, nothing new is
//      reported, and A's device holds A's records only — B's product and bill are gone from it, A's settings and logo stay.
// Run: node tests/run.mjs tests/e2e/open-policies-incident.test.mjs
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const A_ID = 'aaaaaaaa-0000-0000-0000-00000000a013', B_ID = 'bbbbbbbb-0000-0000-0000-00000000b013';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: A_ID, email: 'owner-a@example.com', users: [{ id: B_ID, email: 'owner-b@example.com' }] });
const SIX = ['hangtag_products', 'hangtag_sizes', 'hangtag_images', 'hangtag_sales', 'hangtag_sale_items', 'hangtag_meta'];

// both shops, written as the database owner (no row security), each row naming its shop
for (const [id, shop, prefix, product, name] of [[A_ID, 'Aura Threads', 'AAA', 'pa', 'Kurta of shop A'], [B_ID, 'Other Shop', 'BBB', 'pb', 'Saree of shop B']]) {
  await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, business_type, onboarded_at)
    VALUES ($1, $2, 'Owner', $3, '9876543210', '12 MG Road', 'Pune', 'Maharashtra', 'retail', now())
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, address = EXCLUDED.address, city = EXCLUDED.city,
      state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [id, id === A_ID ? 'owner-a@example.com' : 'owner-b@example.com', shop]);
  await pg.db.query(`INSERT INTO public.hangtag_products (owner_id, id, name, price, options) VALUES ($1, $2, $3, 500, '{"opts":[]}')`, [id, product, name]);
  await pg.db.query(`INSERT INTO public.hangtag_variants (owner_id, id, product_id, option_values) VALUES ($1, $2, $3, '[]')`, [id, product + ':', product]);
  await pg.db.query(`INSERT INTO public.hangtag_meta (owner_id, key, value) VALUES ($1, 'settings', $2), ($1, 'logo', $3)`,
    [id, JSON.stringify({ prefix }), JSON.stringify({ data: 'data:image/png;base64,' + (id === A_ID ? 'QUFB' : 'QkJC') })]);
}
await pg.db.query(`INSERT INTO public.hangtag_sales (owner_id, id, timestamp, subtotal, total, payment_method) VALUES ($1, 'sale-of-shop-b', 1790000000000, 500, 500, 'cash')`, [B_ID]);

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('dialog', (d) => d.accept());
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r))) r.abort(); return; }
  r.continue();
});
/* what the server answered to the settings read: its status and how many rows it sent (never the rows themselves) */
const settingsReads = [];
A.on('response', async (res) => {
  if (res.request().method() !== 'GET' || !/\/rest\/v1\/hangtag_meta\?/.test(res.url()) || !/key=eq\.settings/.test(res.url())) return;
  let rows = null; try { const b = JSON.parse(await res.text()); rows = Array.isArray(b) ? b.length : null; } catch { rows = null; }
  settingsReads.push({ status: res.status(), rows });
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session(A_ID)));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; }
/* no request of the page in flight: the stand-in runs each one as the signed-in role, so a policy change waits for quiet */
const quiet = () => A.waitForNetworkIdle({ idleTime: 300, timeout: 10000 }).catch(() => {});
/* what A's device holds of the six tables' records */
const device = () => run(`return { products: products().map(p => p.id).sort(), bills: Object.values(remoteDays).flatMap(d => d.sales.map(s => s.id)).sort(),
  prefix: settings.prefix, logo: String(logo || '').slice(-4), lastSyncAt: lastSyncAt || 0 }`);
const problems = () => run(`return getDiagnostics().map(e => ({ level: e.level, kind: e.kind, op: e.op || '', code: e.code || '', message: e.message }))`);

check('signed in as shop A and connected', await until('sbStatus==="connected"'), await run('return { sbStatus, sbErrorText, mode, signedIn: !!authUser, hash: location.hash, gate: (document.querySelector("#authScreen,#setupGate,[data-gate]")||{}).id || null }').catch(e => String(e)));
await until('!syncing && lastSyncAt');   // the app's own download at start has finished
await run('await pullFromSupabase(false)');
let d = await device();
check('1. with the shop policies: A\'s device holds A\'s product, A\'s settings and logo, and no bill of B', JSON.stringify(d.products) === '["pa"]' && d.prefix === 'AAA'
  && d.logo === 'QUFB' && !d.bills.includes('sale-of-shop-b'), d);

console.log('--- the six "Public access" policies come back (as on 2026-10-13, 20:44 IST) ---');
await quiet();
for (const t of SIX) await pg.db.exec(`CREATE POLICY "Public access to ${t}" ON public.${t} FOR ALL USING (true) WITH CHECK (true)`);
await run('clearDiagnostics()');
settingsReads.length = 0;
const before = (await device()).lastSyncAt;
await run('await pullFromSupabase(false)');
d = await device();
const p1 = await problems();
check('2. the full download fails: "Pull from Supabase failed"', p1.some((e) => e.level === 'error' && /Pull from Supabase failed/.test(e.message)), p1);
check('…and the diagnostics name the read: a single-row read of table:hangtag_meta got more than one row (PGRST116), as a problem',
  p1.some((e) => e.level === 'error' && e.kind === 'more-than-one-row' && e.op === 'table:hangtag_meta' && e.code === 'PGRST116' && /more than one row \(table:hangtag_meta\)/.test(e.message)), p1);
check('…the server answered the settings read with 200 and one row per shop (2): supabase-js refused them itself, and no call failed',
  settingsReads.length > 0 && settingsReads.every((x) => x.status === 200 && x.rows === 2) && !p1.some((e) => e.kind === 'server-error' || e.kind === 'connection-failed'), { settingsReads, p1 });
check('…before stopping, it brought shop B\'s product onto A\'s device (what the open policies exposed)', d.products.includes('pb'), d);
check('…and it marked no full sync (it stopped at the settings)', d.lastSyncAt === before, d);
await run('openSettings("advanced")'); await sleep(400);
const shown = await A.$$eval('#diagBlk [data-diag-entry]', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
check('…and Settings → Advanced shows it as "more than one row (table:hangtag_meta)" with its code PGRST116',
  shown.some((t) => /more than one row \(table:hangtag_meta\)/.test(t) && /PGRST116/.test(t)), shown);
await run('await pullSales()');
d = await device();
check('…the bills download on its own is not stopped by that: it brings shop B\'s bill onto A\'s device too; A\'s settings and logo stay A\'s',
  d.bills.includes('sale-of-shop-b') && d.prefix === 'AAA' && d.logo === 'QUFB', d);

console.log('--- the six are dropped again (the containment, 2026-10-13 23:45 IST) ---');
await quiet();
for (const t of SIX) await pg.db.exec(`DROP POLICY IF EXISTS "Public access to ${t}" ON public.${t}`);
await run('clearDiagnostics()');
await run('await pullFromSupabase(false)');
d = await device();
const p2 = await problems();
check('3. the next full download succeeds: nothing new reported, the sync marked', p2.filter((e) => e.level !== 'info').length === 0 && d.lastSyncAt > before, { p2, d });
check('…and A\'s device holds A\'s records only: B\'s product and bill are gone, A\'s settings and logo stay', JSON.stringify(d.products) === '["pa"]' && !d.bills.includes('sale-of-shop-b')
  && d.prefix === 'AAA' && d.logo === 'QUFB', d);

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
