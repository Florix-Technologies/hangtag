// The Hangtag Agent, end to end in Chrome: its page, answers from the shop's records with buttons that open what they
// point at (a customer's account, a bill — at once when asked to "open" it), Smart reorder's suggestion turned into a
// draft purchase order only when the person taps Save (as a draft, never sent; nothing before that), a question it
// doesn't know (no AI error without a provider), an AI provider that can only use the Agent's tools (they run on the
// device; the provider sees their results), who may use it, and the phone layout. The database is PGlite running the
// real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000a9', EMAIL = 'owneragent@example.com';
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
const answer = () => text('#v-assistant .ask-answer');
async function ask(question) {
  await A.$eval('#askQuestion', (e, v) => { e.value = v; }, question);
  await A.click('#askForm button[type="submit"]');
  await until('!document.querySelector("#askForm button[type=submit]").disabled&&!!document.querySelector("#v-assistant .ask-answer")');
  await sleep(150);
}
check('signed in and connected', await until('sbStatus==="connected"'));

// purchase orders on; Kurta and Dupatta (bought from Lakshmi Textiles, then sold out); Riya owes on a bill
await run(`saveCapabilities({uses_purchase_orders:true});
  openEditor(null);editor.name="Kurta";editor.price="1000";editor.cost="600";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Dupatta";editor.price="500";editor.cost="250";saveEditor();
  saveSupplier({name:"Lakshmi Textiles",phone:"9876500001"});saveCustomer({name:"Riya",phone:"98765 43210",email:""});closeModal();await flushSbQueue()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), DUP = await run('return products().find(p=>p.name==="Dupatta").variants[0].id');
const SUP = await run('return suppliersList().find(s=>s.name==="Lakshmi Textiles").id');
const PU = await run(`const r=savePurchase({supplierId:${JSON.stringify(SUP)},invoiceNo:"LT-1",lines:[{v:${JSON.stringify(DUP)},q:"2",cost:"250"}],paid:"500",method:"cash"});await flushSbQueue();return r.error||r.purchase.id`);
const sell = (lines, pay, who) => run(`await new Promise(r=>setTimeout(r,700));setTab("sell");${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));const s=await checkout(${pay});closeModal();closeSheets();return s&&s.no`);
const S1 = await sell([DUP, DUP], '"cash"');
const S2 = await sell([KURTA], '[{method:"cash",amount:400},{method:"due",amount:600}]', 'Riya');
await run('await flushSbQueue()');
check('setup: purchase orders on, a purchase from Lakshmi Textiles, two bills (one part on account)', await run('return hasCap("uses_purchase_orders")') && /^pu|^[a-z0-9-]+$/i.test(PU) && S1 === 'INV-000001' && S2 === 'INV-000002', { PU, S1, S2 });

console.log('--- the page ---');
await run('setTab("assistant");renderAll()'); await sleep(300);
check('the Hangtag Agent page: what it does and that you confirm anything it would save', /Hangtag Agent/.test(await text('#v-assistant .viewhead') || '') && /you confirm anything it would save/.test(await text('#v-assistant .viewhead') || ''));
check('suggestions include recent bills, the sales trend, UPI to verify and drafting a purchase order', await A.$$eval('#v-assistant [data-ask-question]', (b) => b.map((x) => x.dataset.askQuestion)).then((l) => ['Recent bills', 'Sales trend', 'UPI to verify', 'Draft a purchase order'].every((s) => l.includes(s))));

console.log('--- answers with buttons ---');
await A.click('#v-assistant [data-ask-question="Who owes me money?"]'); await until('!!document.querySelector("#v-assistant .ask-answer")'); await sleep(200);
check('dues from the records: ₹600 from Riya, with a button to open her account', /₹600 across 1 customer/.test(await answer() || '') && await vis('#v-assistant [data-agentopen^="customer|"]'), await answer());
await A.click('#v-assistant [data-agentopen^="customer|"]'); await sleep(400);
check('...it opens Riya\'s account', /Riya/.test(await text('#modalHost') || ''));
await run('closeModal()'); await sleep(150);
await ask('open bill INV-000002');
check('"open bill INV-000002" opens the bill at once (and offers the button again)', await vis('.billview') && /INV-000002/.test(await text('.billview') || '') && await A.$eval('#v-assistant [data-agentopen^="bill|"]', (b) => /Open bill INV-000002/.test(b.textContent)).catch(() => false));
await run('closeModal()'); await sleep(150);
await ask('recent bills');
check('recent bills: newest first with what is owed', /INV-000002 · Riya/.test(await answer() || '') && /₹600 owed/.test(await answer() || ''), await answer());

console.log('--- a draft purchase order, saved only when confirmed ---');
await A.click('#v-assistant [data-ask-question="What should I reorder?"]'); await sleep(500);
check('reorder: Dupatta (sold out), with Smart reorder and "Draft a purchase order" offered', /Dupatta/.test(await answer() || '') && await vis('#v-assistant [data-agentopen="reorder|smart"]') && await vis('#v-assistant .ask-acts [data-ask-question="Draft a purchase order"]'), await answer());
await A.click('#v-assistant .ask-acts [data-ask-question="Draft a purchase order"]'); await sleep(500);
check('the draft: Lakshmi Textiles, Dupatta, with Save and Not now', await vis('#v-assistant .agent-prop') && /Lakshmi Textiles/.test(await text('#v-assistant .agent-prop') || '') && /Dupatta/.test(await text('#v-assistant .agent-prop') || '')
  && /isn't sent to the supplier/.test(await text('#v-assistant .agent-prop') || ''), await text('#v-assistant .agent-prop'));
check('...nothing is saved yet (on the device or in the cloud)', await run('return poList().length') === 0 && (await q(`SELECT count(*)::int AS n FROM public.hangtag_purchase_orders`))[0].n === 0);
await A.click('#v-assistant [data-agentdismiss]'); await sleep(250);
check('Not now: the draft goes away, still nothing saved', !(await vis('#v-assistant .agent-prop')) && await run('return poList().length') === 0);
await ask('Draft a purchase order for Lakshmi');
await A.click('#v-assistant [data-agentconfirm]'); await sleep(500);
const po = await run('const p=poList()[0];return p&&{no:p.no,status:p.status,source:p.source,sup:p.supplierId,lines:p.items.map(l=>l.name+"×"+l.q)}');
check('Save: a draft purchase order (not sent) for Lakshmi Textiles with the suggested Dupattas', po && po.status === 'draft' && po.source === 'reorder' && po.sup === SUP && po.lines.length === 1 && /^Dupatta×\d+$/.test(po.lines[0]), po);
check('...the page says so, with the way to Purchase orders', /Saved as draft PO-/.test(await text('#v-assistant .agent-saved') || '') && await vis('#v-assistant .agent-saved [data-navsub="stock:pos"]') && !(await vis('#v-assistant .agent-prop')));
await run('await flushSbQueue()');
const row = (await q(`SELECT status, source, jsonb_array_length(items) AS n FROM public.hangtag_purchase_orders`))[0];
check('...and in the cloud as a draft', row && row.status === 'draft' && row.source === 'reorder' && row.n === 1, row);
const au = await run('return autoLog.filter(e=>e.rule==="agent").map(e=>({action:e.action,why:e.why,tool:e.tool,before:e.before,after:e.after,outcome:e.outcome,by:e.by,t:e.t>0}))');
check('the audit: Save and "Not now" are in the automation log — who, when, why (the question), the tool, before, after, the approval and the outcome',
  au.length === 2 && au[0].action === 'approved' && au[0].why === 'Draft a purchase order for Lakshmi' && au[0].tool === 'draft_purchase_order' && au[0].before === 'No draft purchase order for Lakshmi Textiles'
  && /^Draft PO-\d+ for Lakshmi Textiles: 1 line/.test(au[0].after) && /after the person tapped Save \(not sent to the supplier\)/.test(au[0].outcome) && !!au[0].by && au[0].t
  && au[1].action === 'dismissed' && au[1].why === 'Draft a purchase order' && au[1].after === 'Nothing saved' && au[1].outcome === 'Dismissed by the person (Not now)', au);
await run('openSettings("automation")'); await sleep(300);
const act = await text('#autoLogBlk') || '';
check('...shown in Settings → Automation → Activity', /Approved · Hangtag Agent/.test(act) && /Asked: “Draft a purchase order for Lakshmi”/.test(act) && /Tool: draft_purchase_order/.test(act) && /Outcome: Saved as a draft/.test(act) && /Dismissed · Hangtag Agent/.test(act), act.slice(0, 400));
await run('setTab("assistant");renderAll()'); await sleep(200);

console.log('--- questions it doesn\'t know; an AI provider ---');
await ask('Write a thank-you note for my staff');
check('without an AI provider: it says what it can do (no error)', /can't answer that from your shop's data yet/.test(await answer() || '') && /Not understood/.test(await answer() || ''), await answer());
await run(`window.__steps=[];override({agentProvider:{config:async()=>({available:true,provider:"anthropic",model:"test"}),
  step:async(req)=>{window.__steps.push(JSON.parse(JSON.stringify(req)));
    if(!req.transcript.length)return {type:"tool_calls",calls:[{id:"toolu_1",name:"get_today_sales",input:{}},{id:"toolu_2",name:"draft_purchase_order",input:{}}]};
    const r=req.transcript[1].results[0].content;return {type:"answer",text:"From your records: "+r.split("\\n")[0]}}}});
  resetAssistant();setTab("assistant");renderAll()`); await sleep(400);
await ask('Write a thank-you note for my staff');
const steps = await run('return window.__steps');
check('with a provider: it gets only the Agent\'s tools; the tools run here and their results go back', steps.length === 2 && steps[0].tools.length === 17 && steps[0].tools.every((t) => t.inputSchema && t.annotations && !t.perms)
  && /₹2,000 from 2 bills/.test(steps[1].transcript[1].results[0].content), steps.map((s) => s.transcript.length));
check('...its answer is marked as AI, with the tools it checked; a draft it asked for still waits for Save', /AI · from your shop/.test(await answer() || '') && /From your records: Today: ₹2,000 from 2 bills/.test(await answer() || '')
  && /Checked: Today's sales, Draft a purchase order/.test(await answer() || '') && await vis('#v-assistant .agent-prop') && await run('return poList().length') === 1, await answer());
await run('resetAssistant()');

console.log('--- a purchase plan within a budget ---');
await run('resetAssistant();setTab("assistant");renderAll()'); await sleep(200);
await ask('What should I buy with ₹300?');
check('the Agent plans within ₹300: one of the two Dupattas for ₹250, ₹50 left, nothing ordered', /Within ₹300: Dupatta × 1 \(of 2\) ₹250\. Total ₹250, ₹50 left\./.test(await answer() || '') && /Nothing has been ordered/.test(await answer() || ''), await answer());
await run('chooseSubview("stock","smart");setTab("stock");renderAll()'); await sleep(400);
check('Smart reorder shows the forecast on each suggestion', /Forecast\s+Sold out now/.test(await text('#v-stock .intel-card .intel-forecast') || ''), await text('#v-stock .intel-card .intel-forecast'));
await A.$eval('#planForm [name="budget"]', (e) => { e.value = '1000'; }); await A.click('#planForm button[type="submit"]'); await sleep(400);
check('Smart reorder: a plan within ₹1,000 — Dupatta × 2 for ₹500, ₹500 left', /₹500 of ₹1,000 · ₹500 left/.test(await text('#v-stock .planres') || '') && /Dupatta/.test(await text('#v-stock .planres') || ''), await text('#v-stock .planres'));
const n0 = await run('return poList().length');
await A.click('#v-stock [data-plansave]'); await sleep(500);
const newest = await run('const p=poList()[0];return {n:poList().length,status:p.status,source:p.source,lines:p.items.map(l=>l.name+"×"+l.q)}');
check('Save as draft purchase orders: one draft for Lakshmi Textiles with the plan\'s lines (not sent)', newest.n === n0 + 1 && newest.status === 'draft' && newest.source === 'reorder' && newest.lines.join() === 'Dupatta×2', newest);

console.log('--- who may use it ---');
await run('window.__owner=access;access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Aura Threads"};renderAll()');
check('a cashier (no reports) doesn\'t get the Agent', await run('return !tabOpen("assistant")'));
await run('access=window.__owner;renderAll()');

console.log('--- phone ---');
await A.setViewport({ width: 375, height: 812 }); await sleep(400);
await run('setTab("assistant");renderAll()'); await sleep(200);
await A.click('#v-assistant [data-ask-question="Draft a purchase order"]'); await sleep(500);
const fit = await A.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, prop: !!document.querySelector('#v-assistant .agent-prop'),
  right: Math.max(...[...document.querySelectorAll('#v-assistant .agent-prop *')].map((e) => e.getBoundingClientRect().right)) }));
check('on a phone the answer and the draft fit the screen', fit.over <= 0 && fit.prop && fit.right <= 375, fit);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
