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
const pol = await A.$$eval('#autoForm [data-autogroup="act"] input[type=radio]:checked', (l) => Object.fromEntries(l.map((x) => [x.name, x.value])));
check('Act: three rules with their defaults: ask before drafting or reminding, check UPI automatically, reminders after 7 days', JSON.stringify(pol) === JSON.stringify({ reorder: 'ask', dues: 'ask', upi: 'auto' })
  && (await A.$eval('#autoForm [name="dueDays"]', (e) => e.value)) === '7', pol);
const wpol = await A.$$eval('#autoForm [data-autogroup="watch"] input[type=radio]:checked', (l) => Object.fromEntries(l.map((x) => [x.name, x.value])));
check('Watch: nine rules, Off or Notify me — every one notifies but unusual sales; late after 3 days, the closing reminder from 21:00',
  JSON.stringify(wpol) === JSON.stringify({ w_stock: 'notify', w_overdue: 'notify', w_mismatch: 'notify', w_late: 'notify', w_unusual: 'off', w_expiry: 'notify', w_receipts: 'notify', w_dayclose: 'notify', w_gst: 'notify' })
  && (await A.$eval('#autoForm [name="lateDays"]', (e) => e.value)) === '3' && (await A.$eval('#autoForm [name="closeHour"]', (e) => e.value)) === '21'
  && !(await A.$('#autoForm [data-autogroup="watch"] input[value="auto"]')) && /Watching never changes anything/.test(await text('#autoForm [data-autogroup="watch"]') || ''), wpol);
check('...expiring stock says which feature it needs (this shop has no batches or expiry dates yet); sales orders are on, so late orders says nothing',/Switch on expiry dates or batches for this shop/.test(await text('#autoForm [data-watchrule="expiry"]') || '')
  && !/Switch on/.test(await text('#autoForm [data-watchrule="late"]') || '') && !/Switch on/.test(await text('#autoForm [data-watchrule="stock"]') || ''));
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
const all = await A.$$eval('#autoLogBlk [data-autolog]', (l) => l.map((x) => x.dataset.autolog)), log = all.filter((x) => x !== 'notified');
check('the activity: done automatically, two policy changes, approved twice, dismissed once (newest first)', log[0] === 'auto' && log.filter((x) => x === 'auto').length === 1 && log.filter((x) => x === 'policy').length === 2 && log.filter((x) => x === 'approved').length === 2 && log.filter((x) => x === 'dismissed').length === 1, log);
const noticed = await A.$$eval('#autoLogBlk [data-autolog="notified"]', (l) => l.map((x) => x.dataset.logrule));
check('...and what the watch rules noticed, once each though automation ran three times: Dupatta sold out, the money customers owe',
  noticed.filter((x) => x === 'stock').length === 1 && noticed.filter((x) => x === 'overdue').length === 1 && /Noticed · Low stock 1 item sold out · Dupatta/.test(await text('#autoLogBlk') || '')
  && /Noticed · Money customers owe ₹900 to collect/.test(await text('#autoLogBlk') || ''), noticed);
check('...in words: what, and who', /Drafted purchase order PO-\d+ for Lakshmi Textiles \(1 product\)\. Not sent\./.test(await text('#autoLogBlk') || '') && /Reorder drafts: Ask me first → Automatically/.test(await text('#autoLogBlk') || '')
  && /Payment reminder to Riya opened in WhatsApp/.test(await text('#autoLogBlk') || ''));
await run('await flushSbQueue()');
const cloud = await q(`SELECT key, jsonb_array_length(value -> 'entries') AS n FROM public.hangtag_meta WHERE key LIKE 'autolog:%'`);
const st = (await q(`SELECT value -> 'automation' AS a FROM public.hangtag_meta WHERE key = 'settings'`))[0];
check('in the cloud: this device\'s log (one row per device) and the policies with the settings', cloud.length === 1 && cloud[0].n === all.length && st && st.a && st.a.reorder === 'auto' && st.a.dueDays === 10 && st.a.watch && st.a.watch.stock === 'notify', { cloud, st });

console.log('--- who ---');
await run('window.__owner=access;access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Aura Threads"};renderAll()');
check('a cashier has no Automation settings (and no purchase-order approvals)', await run('return !settingsSections().some(s=>s.key==="automation")&&!pendingApprovals().some(f=>f.rule==="reorder")'));
await run('access=window.__owner;renderAll()');

console.log('--- watch ---');
const attnIds = () => A.$$eval('#homeBody [data-attn]', (l) => l.map((x) => x.dataset.attn));
const saveForm = async () => { await A.click('#autoForm button[type="submit"]'); await sleep(300); };
await run('openSettings("automation")'); await sleep(300);
await A.click('#autoForm input[name="w_stock"][value="off"]'); await saveForm();
check('Off: saved with the shop\'s settings, and the change is in the log', await run('return settings.automation.watch.stock==="off"') && /Low stock: Notify me → Off/.test(await text('#autoLogBlk') || ''));
await home();
let ids = await attnIds();
check('...Home no longer shows low stock (the other watch rules still do)', !ids.includes('stock') && ids.includes('dues'), ids);
await run('openSettings("automation")'); await sleep(300);
await A.click('#autoForm input[name="w_stock"][value="notify"]'); await saveForm();
await home();
check('...Notify me again: back on Home', (await attnIds()).includes('stock'));

// late orders: a sales order open for 5 days (late after 3)
await run('saveCapabilities({uses_purchase_orders:true,uses_sales_orders:true})');
const KP = await run('return products().find(p=>p.name==="Kurta").id');
const ORD = await run(`const real=Date.now;Date.now=()=>real()-5*864e5;const d=newOrderDraft("sales",{cart:[{p:${JSON.stringify(KP)},v:${JSON.stringify(KURTA)},name:"Kurta",vl:"",q:1,price:1000}],cust:Object.values(customers).find(c=>c.name==="Riya")});Date.now=real;const r=saveOrder(d);return r.error||r.order.id`);
await home();
check('late orders: an order open 5 days is on Home (late after 3), opening the sales orders', /1 order late/.test(await text('#homeBody [data-attn="late"]') || '') && /Open more than 3 days · the oldest 5 days/.test(await text('#homeBody [data-attn="late"]') || '')
  && !!(await A.$('#homeBody [data-attn="late"] [data-subview="orders:sales"]')), { ORD, t: await text('#homeBody [data-attn="late"]') });
await run('openSettings("automation")'); await sleep(300);
await A.$eval('#autoForm [name="lateDays"]', (e) => { e.value = '7'; }); await saveForm();
await home();
check('...late after 7 days instead: not late yet', await run('return settings.automation.watch.lateDays') === 7 && !(await attnIds()).includes('late'));
await run('openSettings("automation")'); await sleep(300);
await A.$eval('#autoForm [name="lateDays"]', (e) => { e.value = '0'; }); await saveForm();
check('...a time out of range is refused, saying why', /Late orders: from 1 to 60/.test(await text('#autoErr') || '') && await run('return settings.automation.watch.lateDays') === 7);

// expiring stock: a batch of ghee that expires in 5 days
await run('saveCapabilities({uses_purchase_orders:true,uses_sales_orders:true,uses_batches:true,uses_expiry:true});openEditor(null);editor.name="Ghee";editor.price="500";editor.tracking="expiry";saveEditor();closeModal()');
const GHEE = await run('return products().find(p=>p.name==="Ghee").variants[0].id');
const PG = await run(`const r=savePurchase({supplierId:${JSON.stringify(SUP)},invoiceNo:"LT-2",lines:[{v:${JSON.stringify(GHEE)},q:"3",cost:"400",batch:{no:"g1",exp:plusDays(dayKey(Date.now()),5)}}],paid:"1200",method:"cash"});await flushSbQueue();return r.error||r.purchase.id`);
await home();
await run('openSettings("automation")'); await sleep(300);
check('expiring stock: batches with expiry dates are on now — no "Switch on" note', !/Switch on/.test(await text('#autoForm [data-watchrule="expiry"]') || ''));
await home();
check('expiring stock: the batch is on Home, with the product', /^pur/.test(PG || '') && /1 batch expiring soon/.test(await text('#homeBody [data-attn="expiry"]') || '') && /Ghee/.test(await text('#homeBody [data-attn="expiry"]') || ''), { PG, t: await text('#homeBody [data-attn="expiry"]') });

// daily closing: from the reminder hour, with bills today and the day's cash not closed
const at = (h) => `(()=>{const t=new Date();t.setHours(${h},30,0,0);return +t})()`;
check('daily closing: after 21:00 with bills today → "Close today\'s cash"; before it, nothing', await run(`return watchFindings(${at(22)}).some(f=>f.id==="dayclose"&&/Close today/.test(f.title))&&!watchFindings(${at(12)}).some(f=>f.id==="dayclose")`));
await run(`const real=Date.now;Date.now=()=>${at(22)};closeModal();setTab("home");renderAll();Date.now=real`); await sleep(200);
check('...on Home, opening the cash close', !!(await A.$('#homeBody [data-attn="dayclose"] [data-cashform="close"]')));
const CL = await run('const r=closeDay({scope:"shop",counted:"2900",note:""});return r.error||r.close.id');
check('...once the day is closed, it stops', !!CL && await run(`return !watchFindings(${at(22)}).some(f=>f.id==="dayclose")`), CL);

// GST preparation: from the 1st to the 11th, last month's GST (the bills of 8 days ago are in some month: the 5th of the next one)
const G = await run(`const was=settings.taxOn,b=dayKey(Date.now()-8*864e5),m=b.slice(0,7),t=+new Date(+m.slice(0,4),+m.slice(5,7),5,12);settings=Object.assign({},settings,{taxOn:true});
  const f=watchFindings(t).filter(x=>x.id==="gst");return {was:!!was,m,t,f:f.map(x=>({title:x.title,attr:x.attr,tone:x.tone,sub:x.sub}))}`);
check('GST: "Prepare GST for <the month>" from the 1st to the 11th (GSTR-1 is due on the 11th)', G.f.length === 1 && /^Prepare GST for \w+ \d{4}$/.test(G.f[0].title) && G.f[0].attr.includes(`data-gstmonth="${G.m}"`) && /due on the 11th/.test(G.f[0].sub), G);
check('...not after the 11th', await run(`return !watchFindings(${G.t}+10*864e5).some(f=>f.id==="gst")`));
await run(`const real=Date.now;Date.now=()=>${G.t};closeModal();setTab("home");renderAll();Date.now=real`); await sleep(200);
await A.click('#homeBody [data-attn="gst"] button'); await sleep(500);
check('...Prepare opens GST filing preparation on that month', (await A.$eval('#gstMonth', (e) => e.value).catch(() => null)) === G.m);
await run(`closeModal();settings=Object.assign({},settings,{gstExports:[{period:${JSON.stringify(G.m)},t:Date.now(),format:"csv",totals:{tax:0,taxable:0},digest:""}]})`);
check('...once the month is exported, it stops', await run(`return !watchFindings(${G.t}).some(f=>f.id==="gst")`));
await run(`settings=Object.assign({},settings,{taxOn:${G.was},gstExports:[]})`);

// unusual sales (off unless chosen): four past Thursdays (or whatever today is) of 3 bills each, and today far below
await run(`const real=Date.now;for(const ago of [7,14,21,28]) for(let i=0;i<3;i++){setTab("sell");addOne(${JSON.stringify(KURTA)});lastCheckout=0;Date.now=()=>real()-ago*864e5-i*60e3;const p=checkout("cash");Date.now=real;await p;closeModal();closeSheets();}`);
check('unusual sales: off by default — nothing said', await run(`return !watchFindings(${at(23)}).some(f=>f.id==="unusual")`));
await run('openSettings("automation")'); await sleep(300);
await A.click('#autoForm input[name="w_unusual"][value="notify"]'); await saveForm();
const U = await run(`return watchFindings(${at(23)}).filter(f=>f.id==="unusual").map(f=>({title:f.title,sub:f.sub}))`);
check('...Notify me: today\'s ₹1,000 against a usual ₹3,000 by this time → "Sales slower than usual"', U.length === 1 && U[0].title === 'Sales slower than usual' && /₹1,000 so far · a usual \w+ has ₹3,000 by now/.test(U[0].sub), U);
check('...too early in the day to tell: nothing', await run(`return !watchFindings((()=>{const t=new Date();t.setHours(9,0,0,0);return +t})()).some(f=>f.id==="unusual")`));

// receipts not sent (this device's delivery queue)
const S1 = await run('return D().sales.slice().sort((a,b)=>b.t-a.t)[0].id');
await run(`deliveryQueue=[{id:"dq1",saleId:${JSON.stringify(S1)},channel:"email",status:"failed",tries:3,t:Date.now()}];closeModal();setTab("home");renderAll()`); await sleep(200);
check('receipts not sent: on Home, opening the bill', /1 receipt not sent/.test(await text('#homeBody [data-attn="receipts"]') || '') && !!(await A.$(`#homeBody [data-attn="receipts"] [data-billview="${S1}"]`)));
await run('deliveryQueue=[]');

// once a day in the log, per rule and subject
const once = await run(`const k=dayKey(Date.now());await runAutomation({online:true});await runAutomation({online:true});
  const n=key=>autoLog.filter(e=>e.key===key).length;return {late:n("notify:late:late:"+k),expiry:n("notify:expiry:expiry:"+k),stock:n("notify:stock:stock:"+k)}`);
check('the log notes each finding once a day, however often automation runs', once.expiry === 1 && once.stock === 1, once);
check('...a cashier sees only what their role acts on (sold out, money owed to collect — not payments to reconcile or unusual sales)', await run(`window.__owner=access;access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Aura Threads"};
  const ids=watchFindings(${at(22)}).map(f=>f.id);access=window.__owner;renderAll();return ids.includes("stock")&&ids.includes("dues")&&!ids.includes("unusual")&&!ids.includes("gst")&&!ids.includes("upi")`));

console.log('--- phone ---');
await A.setViewport({ width: 375, height: 812 }); await sleep(400);
await run('openSettings("automation")'); await sleep(400);
check('on a phone the rules and the log fit the screen', await A.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
