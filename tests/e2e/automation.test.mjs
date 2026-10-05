// Automation, end to end in Chrome: Settings → Automation (rules with Off / Ask me first / Automatically, saved with the
// shop's settings), Approvals from Home (a reorder draft and a payment reminder wait for a person's OK; Dismiss keeps a
// finding away for a while; Approve saves a draft purchase order — not sent — or opens WhatsApp with the reminder written,
// for the person to send), automatic reorder drafts (one open draft per supplier, never doubled), the automation log on
// the screen and in the cloud (hangtag_meta "autolog:<device>"), and who sees it. The database is PGlite running the real
// schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000a7', EMAIL = 'ownerauto@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
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
const vis = (sel) => A.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
const home = async () => { await run('closeModal();setTab("home");renderAll()'); await sleep(250); };
const approvals = () => A.$$eval('#modalHost [data-appr]', (l) => l.map((x) => x.dataset.appr.split(':')[0]));
check('signed in and connected', await until('sbStatus==="connected"'));

// purchase orders on; Dupatta bought from Lakshmi Textiles, then sold out; Riya owes ₹600 and Arjun ₹300 on bills of 8 days ago
await run(`saveCapabilities({uses_purchase_orders:true});
  openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Dupatta";editor.price="500";editor.cost="250";saveEditor();
  saveSupplier({name:"Lakshmi Textiles",phone:"9876500001"});saveCustomer({name:"Riya",phone:"98765 43210",email:""});saveCustomer({name:"Arjun",phone:"91234 56789",email:""});closeModal();await flushSbQueue()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), DUP = await run('return products().find(p=>p.name==="Dupatta").variants[0].id');
const SUP = await run('return suppliersList().find(s=>s.name==="Lakshmi Textiles").id');
await run(`savePurchase({supplierId:${JSON.stringify(SUP)},invoiceNo:"LT-1",lines:[{v:${JSON.stringify(DUP)},q:"2",cost:"250"}],paid:"500",method:"cash"});await flushSbQueue()`);
/* a bill (made `ago` days back: the clock is moved only while the bill is made) */
const sell = (lines, pay, who, ago = 0) => run(`await new Promise(r=>setTimeout(r,700));setTab("sell");${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));const real=Date.now;${ago ? `lastCheckout=0;Date.now=()=>real()-${ago}*864e5;` : ''}const p=checkout(${pay});Date.now=real;const s=await p;closeModal();closeSheets();return s&&s.no`);
await sell([DUP, DUP], '"cash"');
await sell([KURTA], '[{method:"cash",amount:400},{method:"due",amount:600}]', 'Riya', 8);
await sell([KURTA], '[{method:"cash",amount:700},{method:"due",amount:300}]', 'Arjun', 8);
await run('await flushSbQueue()');

console.log('--- Settings → Automation ---');
await run('openSettings("automation")'); await sleep(400);
const pol = await A.$$eval('#autoForm input[type=radio]:checked', (l) => Object.fromEntries(l.map((x) => [x.name, x.value])));
check('three rules with their defaults: ask before drafting or reminding, check UPI automatically, reminders after 7 days', JSON.stringify(pol) === JSON.stringify({ reorder: 'ask', dues: 'ask', upi: 'auto' })
  && (await A.$eval('#autoForm [name="dueDays"]', (e) => e.value)) === '7', pol);
check('a payment reminder can\'t be made automatic (no such choice)', !(await A.$('#autoForm input[name="dues"][value="auto"]')) && /never sends anything to a customer or supplier on its own/.test(await text('#autoForm') || ''));
check('the activity log is empty to start with', /Nothing yet/.test(await text('#autoLogBlk') || ''));

console.log('--- approvals ---');
await run('window.__opened=[];window.open=(u)=>{window.__opened.push(u);return {}}');
await home();
check('Home → Needs attention: 3 automations waiting for your OK', /3 automations waiting for your OK/.test(await text('#homeBody [data-attn="approvals"]') || ''), await text('#homeBody [data-attn="approvals"]'));
await A.click('#homeBody [data-attn="approvals"] button'); await sleep(300);
check('Approvals: a draft purchase order for Lakshmi Textiles, and reminders to Riya (₹600) and Arjun (₹300), each with its own button and Dismiss',
  JSON.stringify((await approvals()).sort()) === '["dues","dues","reorder"]' && /Draft a purchase order for Lakshmi Textiles/.test(await text('#modalHost') || '') && /Dupatta × \d+/.test(await text('#modalHost') || '')
  && /Remind Riya about ₹600/.test(await text('#modalHost') || '') && /Remind Arjun about ₹300/.test(await text('#modalHost') || '') && /1 bill unpaid · the oldest 8 days/.test(await text('#modalHost') || '')
  && await vis('#modalHost [data-autoapprove^="reorder:"]') && (await A.$$('#modalHost [data-autodismiss]')).length === 3);
const ARJUN = await run('return Object.values(customers).find(c=>c.name==="Arjun").id'), RIYA = await run('return Object.values(customers).find(c=>c.name==="Riya").id');
await A.click(`#modalHost [data-autodismiss="dues:${ARJUN}"]`); await sleep(300);
check('Dismiss Arjun\'s: two left, nothing sent or saved', (await approvals()).length === 2 && !/Arjun/.test(await text('#modalHost') || '') && (await run('return window.__opened')).length === 0 && await run('return poList().length') === 0);
await A.click(`#modalHost [data-autoapprove="dues:${RIYA}"]`); await sleep(300);
const url = (await run('return window.__opened'))[0] || '';
check('Open WhatsApp for Riya: the reminder written, to her number — the person sends it', /^https:\/\/wa\.me\/919876543210\?text=/.test(url) && /friendly reminder from Aura Threads: ₹600 is due on your account \(bill INV-000002\), unpaid for 8 days/.test(decodeURIComponent(url.split('text=')[1] || '')), url);
await A.click('#modalHost [data-autoapprove^="reorder:"]'); await sleep(400);
const po = await run('const p=poList()[0];return p&&{no:p.no,status:p.status,source:p.source,sup:p.supplierId}');
check('Save draft: a draft purchase order for Lakshmi Textiles (not sent)', po && po.status === 'draft' && po.source === 'reorder' && po.sup === SUP, po);
check('...nothing left waiting', /Nothing is waiting/.test(await text('#modalHost') || ''));
await home();
check('...and Home no longer asks (dismissed and approved ones stay away for a while)', !(await A.$('#homeBody [data-attn="approvals"]')));

console.log('--- automatically ---');
await run('openSettings("automation")'); await sleep(300);
await A.click('#autoForm input[name="reorder"][value="auto"]');
await A.$eval('#autoForm [name="dueDays"]', (e) => { e.value = '10'; });
await A.click('#autoForm button[type="submit"]'); await sleep(300);
check('saved with the shop\'s settings: reorder drafts automatically, reminders after 10 days', await run('return settings.automation.reorder==="auto"&&settings.automation.dueDays===10'));
check('...an open draft for the supplier is never doubled', await run('await runAutomation({online:true});return poList().length') === 1);
await run(`setPOStatus(poList()[0].id,"cancelled")`);
const n1 = await run('const n=await runAutomation({online:true});return {n,len:poList().length,drafts:poList().filter(p=>p.status==="draft").length}');
check('...with no open draft, one is made by itself (still a draft, not sent)', n1.n === 1 && n1.len === 2 && n1.drafts === 1, n1);
check('...and running again makes no other', await run('await runAutomation({online:true});return poList().filter(p=>p.status==="draft").length') === 1);

console.log('--- the log ---');
await run('openSettings("automation")'); await sleep(300);
const log = await A.$$eval('#autoLogBlk [data-autolog]', (l) => l.map((x) => x.dataset.autolog));
check('the activity: done automatically, two policy changes, approved twice, dismissed once (newest first)', log[0] === 'auto' && log.filter((x) => x === 'auto').length === 1 && log.filter((x) => x === 'policy').length === 2 && log.filter((x) => x === 'approved').length === 2 && log.filter((x) => x === 'dismissed').length === 1, log);
check('...in words: what, and who', /Drafted purchase order PO-\d+ for Lakshmi Textiles \(1 product\)\. Not sent\./.test(await text('#autoLogBlk') || '') && /Reorder drafts: Ask me first → Automatically/.test(await text('#autoLogBlk') || '')
  && /Payment reminder to Riya opened in WhatsApp/.test(await text('#autoLogBlk') || ''));
await run('await flushSbQueue()');
const cloud = await q(`SELECT key, jsonb_array_length(value -> 'entries') AS n FROM public.hangtag_meta WHERE key LIKE 'autolog:%'`);
const st = (await q(`SELECT value -> 'automation' AS a FROM public.hangtag_meta WHERE key = 'settings'`))[0];
check('in the cloud: this device\'s log (one row per device) and the policies with the settings', cloud.length === 1 && cloud[0].n === log.length && st && st.a && st.a.reorder === 'auto' && st.a.dueDays === 10, { cloud, st });

console.log('--- who ---');
await run('window.__owner=access;access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Aura Threads"};renderAll()');
check('a cashier has no Automation settings (and no purchase-order approvals)', await run('return !settingsSections().some(s=>s.key==="automation")&&!pendingApprovals().some(f=>f.rule==="reorder")'));
await run('access=window.__owner;renderAll()');

console.log('--- phone ---');
await A.setViewport({ width: 375, height: 812 }); await sleep(400);
await run('openSettings("automation")'); await sleep(400);
check('on a phone the rules and the log fit the screen', await A.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
