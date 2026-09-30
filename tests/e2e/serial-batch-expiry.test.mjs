// Serial numbers, batches and expiry end to end in Chrome (Wave 2, schema.sql section 3n). An electronics shop: a phone
// tracked by serial number — a purchase with its serials (typed as a range on the purchase form) → stock → the till's
// serial picker → a bill (the serial SOLD in the cloud) → the same serial refused on another bill → a return (RETURNED,
// back in stock) → the audit log. Then batches with expiry dates: rice by the kg in two batches → a bill taking the batch
// that expires first (across two batches) → a return back into its batch → expiring soon on the stock page and in
// Inventory → Serials & batches → expired stock not sold unless the shop allows it.
// The database is PGlite running the real schema.sql behind a PostgREST stand-in.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-000000000052', EMAIL = 'owner52@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, business_type, onboarded_at) VALUES ($1,$2,'Owner','Volt Mobiles','9876543210','Pune','Maharashtra','electronics',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const P = await (await browser.createBrowserContext()).newPage();
await P.setViewport({ width: 420, height: 900 });
P.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
P.on('dialog', (d) => d.accept());
await P.setRequestInterception(true);
P.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, {}))) r.abort(); return; }
  r.continue();
});
await P.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await P.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => P.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
const until = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(100); } return false; };
const text = (sel) => P.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const type = async (sel, v) => { await P.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, v); };
const click = async (sel) => { await run(`const t=document.getElementById("toastHost");if(t)t.innerHTML=""`); await P.click(sel); };
const flush = () => run('await flushSbQueue();return !sbOfflineQueue.length');

check('signed in and connected', await until('sbStatus==="connected"'));
check('an electronics shop tracks serial numbers', await run('return hasCap("uses_serials")&&!hasCap("uses_batches")'));

console.log('--- a phone tracked by serial number ---');
await run('setTab("products");renderAll();openEditor(null)');
check('the product form offers None / Serial number', await until('document.querySelectorAll("#edTracking option").length===2'), await P.$$eval('#edTracking option', (o) => o.map((x) => x.value)).catch(() => null));
await P.select('#edTracking', 'serial');
check('choosing it makes the stock box read-only', await until('document.querySelector("[data-edf=stock]")&&document.querySelector("[data-edf=stock]").disabled'));
await run('editor.name="Phone X";editor.price="9000";saveEditor()');
const PH = await run('const p=products().find(p=>p.name==="Phone X");return p&&{pid:p.id,vid:p.variants[0].id,tracking:p.tracking}');
check('saved as tracked by serial number', PH && PH.tracking === 'serial', PH);
const SUP = await run('const r=saveSupplier({name:"Volt Distributors"});await flushSbQueue();return r.supplier&&r.supplier.id');

console.log('--- purchase with serials (the purchase form) ---');
await run(`openPurchaseEntry({supplierId:${JSON.stringify(SUP)}});addPurchaseLine(${JSON.stringify(PH.vid)});renderPurchaseEntry()`);
check('the purchase line asks for serial numbers', await until('document.querySelector(\'[data-pul="0:sn"]\')'));
await type('[data-pul="0:sn"]', 'sn001..sn003');
check('a range typed: 3 serials make the quantity', await until('document.querySelector(\'[data-pul="0:q"]\').value==="3"&&document.querySelector("[data-pusn=\\"0\\"]").textContent==="3"'));
await type('[data-pul="0:cost"]', '8000');
await type('#puInv', 'VD-101');
await click('[data-pur="save"]');
check('saved: 3 phones in stock', await until('!purchaseForm&&stockOf(' + JSON.stringify(PH.vid) + ')===3'), await run('return purchaseForm&&purchaseForm.err'));
check('uploaded', await flush());
let reg = await q(`SELECT serial, status, import_id FROM public.hangtag_serials ORDER BY serial`);
check('the cloud\'s serial register: SN001-SN003 in stock, from the purchase', reg.length === 3 && reg.every((r) => r.status === 'IN_STOCK' && r.import_id) && reg[0].serial === 'SN001', reg);

console.log('--- the till: choose the serial, sell it ---');
await run(`setTab("sell");renderAll();openPicker(${JSON.stringify(PH.pid)})`);
check('the serial picker lists the 3 in stock', await until('document.querySelectorAll("#sheetHost [data-snsel]").length===3'));
await P.click('[data-snsel="SN002"]');
await click('[data-snpickgo]');
check('SN002 is on the bill (one piece, its serial shown)', await until('cart.length===1&&cart[0].sn&&cart[0].sn[0]==="SN002"&&cart[0].q===1') && /SN002/.test(await text('#billPanel') || ''));
const S1 = await run('lastCheckout=0;const s=await checkout("cash");return s&&s.id?{id:s.id,sn:s.items[0].sn}:s');
check('the bill is saved with the serial', S1 && S1.id && S1.sn[0] === 'SN002', S1);
await flush();
reg = await q(`SELECT status, sale_id FROM public.hangtag_serials WHERE serial = 'SN002'`);
check('in the cloud: SN002 SOLD on that bill', reg[0] && reg[0].status === 'SOLD' && reg[0].sale_id === S1.id, reg);
check('stock follows: 2 left, 2 serials ready to sell', await run(`return stockOf(${JSON.stringify(PH.vid)})===2&&serialsOf(${JSON.stringify(PH.vid)},{available:true}).length===2`));
await run(`openPicker(${JSON.stringify(PH.pid)})`);
check('the picker no longer offers SN002', await until('document.querySelectorAll("#sheetHost [data-snsel]").length===2&&!document.querySelector(\'[data-snsel="SN002"]\')'));
await run('closeSheets()');
const dup = await run(`addSerials(cart,${JSON.stringify(PH.vid)},["SN002"]);lastCheckout=0;const r=await checkout("cash");const e=r&&r.error;cart=[];saveCart();renderAll();return e`);
check('a bill with SN002 again is refused (already sold)', /already sold/.test(dup || ''), dup);
check('a sold serial scanned at the till isn\'t added', await run('return scanSerialToCart("SN002")===null&&!cart.length'));
const sc = await run('const r=scanSerialToCart("sn003");return r&&r.status');
check('a serial in stock scanned at the till goes on the bill', sc === 'added' && await run('return cart[0].sn[0]==="SN003"'));
await run('cart=[];saveCart();renderAll()');

console.log('--- return the serial ---');
await run(`openReturn(${JSON.stringify(S1.id)})`);
check('the return shows the serial sold', await until('document.querySelector(\'[data-rtsn="0|SN002"]\')'));
await P.click('[data-rtsn="0|SN002"]');
await until('retState&&retState.q[0]===1');
await click('[data-act="rtsave"]');
check('returned: SN002 back on the shelf (RETURNED), stock 3', await until(`!retState&&serialState("SN002").status==="RETURNED"&&stockOf(${JSON.stringify(PH.vid)})===3`));
await flush();
reg = await q(`SELECT status, return_id FROM public.hangtag_serials WHERE serial = 'SN002'`);
check('in the cloud: RETURNED with its return', reg[0] && reg[0].status === 'RETURNED' && !!reg[0].return_id, reg);
const au = await q(`SELECT action FROM public.hangtag_audit_log WHERE entity = 'serials' AND entity_id = 'SN002' ORDER BY id`);
check('the audit log: SN002 assigned, sold, returned', JSON.stringify(au.map((x) => x.action)) === '["insert","sold","returned"]', au);

console.log('--- batches with expiry dates ---');
check('batches and expiry switched on', await run('const r=saveCapabilities({uses_batches:true,uses_expiry:true});return r.ok&&hasCap("uses_batches")&&hasCap("uses_expiry")'));
await run('setTab("products");renderAll();openEditor(null)');
await until('document.querySelector("#edTracking")');
check('the form now offers Batch and Batch with expiry date', JSON.stringify(await P.$$eval('#edTracking option', (o) => o.map((x) => x.value))) === '["none","serial","batch","expiry"]');
await run('editor.name="Basmati";editor.price="120";editor.unit="kg";editor.tracking="expiry";saveEditor()');
const RC = await run('const p=products().find(p=>p.name==="Basmati");return p&&{pid:p.id,vid:p.variants[0].id,tracking:p.tracking,expiry:p.expiry}');
check('saved: by batch, with expiry dates', RC && RC.tracking === 'batch' && RC.expiry === true, RC);
const today = await run('return dayKey(Date.now())');
const soon = await run(`return plusDays(${JSON.stringify(today)},10)`), far = await run(`return plusDays(${JSON.stringify(today)},200)`);
const PU = await run(`const r=savePurchase({supplierId:${JSON.stringify(SUP)},invoiceNo:"VD-102",lines:[{v:${JSON.stringify(RC.vid)},q:"4",cost:"90",batch:{no:"b-old",exp:${JSON.stringify(soon)}}},{v:${JSON.stringify(RC.vid)},q:"10.5",cost:"90",batch:{no:"b-new",exp:${JSON.stringify(far)}}}],paid:"0"});await flushSbQueue();return r.error||r.purchase.id`);
check('a purchase of two batches: 4 kg (expires in 10 days) and 10.5 kg', /^pur/.test(PU || ''), PU);
const bts = await q(`SELECT batch_no, expiry::text AS e FROM public.hangtag_batches WHERE variant_id = $1 ORDER BY batch_no`, [RC.vid]);
check('in the cloud: both batches with their expiry dates', bts.length === 2 && bts[0].batch_no === 'B-NEW' && bts[0].e === far && bts[1].e === soon, bts);
check('batch stock: 4 + 10.5; B-OLD is expiring soon', await run(`return stockOf(${JSON.stringify(RC.vid)})===14.5&&batchQty(${JSON.stringify(RC.vid)},"B-OLD")===4&&expiryOf(${JSON.stringify(soon)})==="soon"&&expiryOf(${JSON.stringify(far)})==="fresh"`));
await run('setTab("stock");chooseSubview("stock","levels");renderAll()');
check('the stock page warns: B-OLD expiring, and lists the batches under the product', await until('document.querySelector(".expcard")') && /B-OLD/.test(await text('.expcard') || '') && /B-NEW/.test(await text(`[data-trk="${RC.pid}"]`) || ''));

console.log('--- sell by batch (first to expire), return into it ---');
const S2 = await run(`setTab("sell");const w=addWeighed(${JSON.stringify(RC.vid)},"5");if(w.error)return w;lastCheckout=0;const s=await checkout("cash");return s&&s.id?{id:s.id,bt:s.items[0].bt}:s`);
check('5 kg sold: 4 from B-OLD (expires first), 1 from B-NEW', S2 && S2.id && JSON.stringify(S2.bt) === '[{"b":"B-OLD","q":4},{"b":"B-NEW","q":1}]', S2);
check('batch stock reduced: B-OLD 0, B-NEW 9.5', await run(`return batchQty(${JSON.stringify(RC.vid)},"B-OLD")===0&&batchQty(${JSON.stringify(RC.vid)},"B-NEW")===9.5`));
await flush();
const left = async (b) => +(await pg.db.query(`SELECT public.hangtag_batch_left($1, $2, $3) AS n`, [UID, RC.vid, b])).rows[0].n;
check('in the cloud: the same batch stock', await left('B-OLD') === 0 && await left('B-NEW') === 9.5);
const R2 = await run(`const r=recordReturn({sid:${JSON.stringify(S2.id)},picks:{0:2},mode:"return",pay:"cash",reason:"Didn't like it"});return r.error||r.ret.items[0].bt`);
check('a return of 2 kg goes back into B-OLD', JSON.stringify(R2) === '[{"b":"B-OLD","q":2}]' && await run(`return batchQty(${JSON.stringify(RC.vid)},"B-OLD")===2`), R2);
await flush();
check('in the cloud: B-OLD back to 2', await left('B-OLD') === 2);

console.log('--- expired stock ---');
const yday = await run(`return plusDays(${JSON.stringify(today)},-1)`);
await run(`stockRepository().record({moves:[{id:"mexp",v:${JSON.stringify(RC.vid)},p:${JSON.stringify(RC.pid)},type:"RESTOCK",q:3,cost:null,note:"Old stock",t:Date.now(),dev:dev,b:"B-EXP",exp:${JSON.stringify(yday)}}]});await flushSbQueue();invalidate();renderAll()`);
check('a batch whose date has passed shows as expired; the stock counts it, what can be sold doesn\'t', await run(`return expiryOf(${JSON.stringify(yday)})==="expired"&&stockOf(${JSON.stringify(RC.vid)})===14.5&&sellableOf(${JSON.stringify(RC.vid)})===11.5`));
const blocked = await run(`addWeighed(${JSON.stringify(RC.vid)},"11.5");cart[0].q=12;lastCheckout=0;const r=await checkout("cash");const e=r&&r.error;cart=[];saveCart();return e`);
check('selling more than the unexpired stock is refused (expired stock isn\'t sold)', /has expired/.test(blocked || ''), blocked);
check('the shop allows selling expired stock: now it can', await run(`const s=saveExpirySettings({expiryDays:"30",sellExpired:true});return s.ok&&sellableOf(${JSON.stringify(RC.vid)})===14.5`));
await run('saveExpirySettings({expiryDays:"30",sellExpired:false})');

console.log('--- Inventory → Serials & batches ---');
await run('setTab("stock");chooseSubview("stock","tracking");renderAll()');
check('the part is there, with serial counts and batches', await until('document.querySelector(\'[data-subalt="stock"] #tvQ\')') && /Batches/.test(await text('[data-subalt="stock"]') || ''));
await type('#tvQ', 'sn002');
check('finding SN002 shows its history (purchased, sold, returned)', await until('document.querySelector("[data-sncard=\\"SN002\\"]")') && /Purchased.*|Returned/.test(await text('[data-sncard="SN002"]') || '')
  && /Returned/.test(await text('[data-sncard="SN002"]') || '') && /Sold/.test(await text('[data-sncard="SN002"]') || ''));
await run('trackView.exp="expired";renderAll()');
check('the expired batches list shows B-EXP', /B-EXP/.test(await text('[data-subalt="stock"]') || ''));
await P.screenshot({ path: H.ARTIFACTS + '/pic_tracking_phone.png' });

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
