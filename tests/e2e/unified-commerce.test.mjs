// Unified commerce, end to end in Chrome: an online-store order placed through the shop's mobile store (the database's
// hangtag_place_mobile_order) reserves its stock; the Stock page shows it; the till can't sell it to a counter customer
// (the database would refuse that bill) and says why; billing the order itself takes its reservation and frees it; the
// counter bill and the order's bill both reach the cloud; Reports, Home and the Hangtag Agent show sales by channel.
// The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000a3', EMAIL = 'ownerunified@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;

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
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
check('signed in and connected', await until('sbStatus==="connected"'));

await run(`saveCapabilities({uses_mobile_store:true,uses_sales_orders:true});
  openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";edCombos()[0].cell.stock="5";saveEditor();closeModal();await flushSbQueue()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id');
const token = (await pg.db.query(`SELECT store_token FROM public.hangtag_profiles WHERE id = $1`, [UID])).rows[0].store_token;

console.log('--- an online-store order reserves stock ---');
const placed = (await pg.db.query(`SELECT public.hangtag_place_mobile_order($1, $2::jsonb, $3::jsonb, $4) AS r`, [token, JSON.stringify([{ v: KURTA, q: 2 }]), JSON.stringify({ name: 'Meera', phone: '9876543210' }), 'checkout_unified_test_0001'])).rows[0].r;
check('the customer\'s order is placed through the mobile store', placed && placed.ok === true && /^SO-|^MO-|^[A-Z]+-/.test(placed.order_no || ''), placed);
await run('await pullFromSupabase(false)');
check('...the shop sees it (an online-store order)', await until('Object.values(orders).some(o=>o&&o.source==="customer"&&o.kind==="sales")'));
const OID = await run('return Object.values(orders).find(o=>o&&o.source==="customer").id');
await run('setTab("stock");chooseSubview("stock","levels");renderAll()'); await sleep(300);
check('Stock: 5 in hand · 2 reserved for online orders', /5 in hand · 2 reserved for online orders/.test(await text(`[data-reserved]`) ? await text('#stockBody') : ''), (await text('#stockBody') || '').slice(0, 300));

console.log('--- the counter can\'t sell what is reserved ---');
await run('setTab("sell");renderAll();cart=[];');
await run(`for(let i=0;i<3;i++) addOne(${JSON.stringify(KURTA)})`);
check('3 can be sold at the counter (5 less the 2 reserved)', await run(`return cartQtyV(${JSON.stringify(KURTA)})===3&&availOf(${JSON.stringify(KURTA)})===0`));
await run(`addOne(${JSON.stringify(KURTA)})`); await sleep(200);
check('...a 4th is refused, saying why', /the rest \(2\) is reserved for online orders/.test(await text('#toastHost') || '') && await run(`return cartQtyV(${JSON.stringify(KURTA)})===3`), await text('#toastHost'));
const S1 = await run('const s=await checkout("cash");closeSheets();closeModal();await flushSbQueue();return s&&s.no');
check('the counter bill (3) is made and accepted by the database', /^INV-/.test(S1 || '') && (await q(`SELECT count(*)::int AS n FROM public.hangtag_sales WHERE bill_no = $1`, [S1]))[0].n === 1, S1);

console.log('--- billing the online order takes its own reservation ---');
const oc = await run(`await new Promise(r=>setTimeout(r,700));const r=orderToCart(${JSON.stringify(OID)});return r.error||r.lines.map(l=>l.q).join()`);
check('the order goes on the bill: its 2 Kurtas (reserved for it)', oc === '2', oc);
const S2 = await run('const s=await checkout("cash");closeSheets();closeModal();await flushSbQueue();return s&&{no:s.no,order:s.order}');
check('...billed, tied to the order, accepted by the database', S2 && S2.order === OID && (await q(`SELECT order_id FROM public.hangtag_sales WHERE bill_no = $1`, [S2.no]))[0]?.order_id === OID, S2);
check('...nothing is reserved any more (here and in the database)', await run('return reservedAll().size===0') && +(await pg.db.query(`SELECT public.hangtag_mobile_reserved($1,$2) AS n`, [UID, KURTA])).rows[0].n === 0);

console.log('--- sales by channel ---');
await run('prefs.period="today";setTab("report");renderAll()'); await sleep(300);
const rows = await A.$$eval('#channelCard [data-channel]', (l) => l.map((r) => [r.dataset.channel, r.querySelector('b').textContent]));
check('Reports: Counter ₹3,000 and Online store ₹2,000', JSON.stringify(rows) === JSON.stringify([['counter', '₹3,000'], ['online', '₹2,000']]), rows);
await run('setTab("home");renderAll()'); await sleep(250);
check('Home → Today: by channel', /Counter ₹3,000/.test(await text('#homeBody .hchan') || '') && /Online store ₹2,000/.test(await text('#homeBody .hchan') || ''), await text('#homeBody .hchan'));
check('the Agent: today\'s sales by channel', /By channel: Counter ₹3,000, Online store ₹2,000\./.test(await run('return appAgentToolHost().callTool("get_today_sales",{}).content[0].text')));

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
