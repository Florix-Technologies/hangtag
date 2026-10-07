// The automation center (Settings → Automation), end to end in Chrome: today at a glance; the morning briefing switched on
// and off from there (Home follows); backup watched (changes the cloud refused); the shop's own rules — WHEN a bill is
// over ₹1,000 THEN tell me (Home → Needs attention, opening the bill), WHEN a customer owes more than ₹500 THEN write a
// reminder (waits in Approvals; WhatsApp opens with it typed in), WHEN a discount is over 10% THEN note it (Activity only),
// a rule the same as another refused, switched off, removed, each change logged; and "Send failed receipts again": a
// receipt that failed for a passing reason is sent again once a day by itself, one with a wrong contact never. The
// database is PGlite running the real schema.sql behind a PostgREST stand-in; send-receipt is stubbed.
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { CORS, createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000b8', EMAIL = 'ownerauto2@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
// send-receipt, stubbed: email always goes; every send is recorded
const sends = [];
const sendReceipt = async (r) => {
  const body = JSON.parse(r.postData() || '{}');
  const reply = (status, b) => r.respond({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(b) });
  if (body.action === 'channels') return reply(200, { ok: true, channels: { email: true, whatsapp: false, sms: false } });
  if (body.action !== 'send') return reply(200, { ok: true, updated: 0 });
  sends.push(body);
  return reply(200, { ok: true, status: 'sent', channel: body.channel, recipient: 'riya@example.com', provider: 'resend', provider_message_id: 'm_' + sends.length });
};

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('dialog', (d) => d.accept());
await A.setRequestInterception(true);
A.on('request', async (r) => {
  const u = r.url();
  if (u.startsWith('http://localhost:3210/')) return (u === 'http://localhost:3210/' || u.includes('/?')) ? r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }) : r.continue();
  if (u.includes('.supabase.co/')) { if (!(await pg.handle(r, { '/functions/v1/send-receipt': sendReceipt }))) r.abort(); return; }
  r.continue();
});
await A.evaluateOnNewDocument((s) => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(pg.session()));
await A.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
const run = (b) => A.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
async function until(cond, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const vis = (sel) => A.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0).catch(() => false);
const type = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); await sleep(80); };
const choose = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(150); };
const home = async () => { await run('closeModal();closeSheets();setTab("home");renderAll()'); await sleep(250); };
const settingsPage = async () => { await run('closeModal();openSettings("automation")'); await sleep(350); };
const attention = () => A.$$eval('#homeBody [data-attn]', (l) => l.map((x) => ({ id: x.dataset.attn, text: x.innerText.replace(/\s+/g, ' ').trim() })));
const rules = () => A.$$eval('#customRulesBlk [data-crule] .crule-t b', (l) => l.map((x) => x.textContent));
const addRule = async (trigger, fields, action) => {
  await choose('#customRuleForm [name="trigger"]', trigger);
  for (const [k, v] of Object.entries(fields)) await (k === 'hour' || k === 'product' ? choose : type)(`#customRuleForm [name="${k}"]`, v);
  await choose('#customRuleForm [name="action"]', action);
  await A.click('#customRuleForm [type="submit"]'); await sleep(350);
};
check('signed in and connected', await until('sbStatus==="connected"'));

await run(`openEditor(null);editor.name="Kurta";editor.price="1000";edCombos()[0].cell.stock="40";saveEditor();
  openEditor(null);editor.name="Tee";editor.price="500";edCombos()[0].cell.stock="40";saveEditor();
  saveCustomer({name:"Riya",phone:"98765 43210",email:"riya@example.com"});closeModal();
  window.__opened=[];window.open=(u)=>{window.__opened.push(u);return {}};await flushSbQueue()`);
const KURTA = await run('return products().find(p=>p.name==="Kurta").variants[0].id'), TEE = await run('return products().find(p=>p.name==="Tee").variants[0].id');
const sell = (lines, pay, who, discount) => run(`await new Promise(r=>setTimeout(r,700));setTab("sell");${who ? `setBillCustomer(Object.values(customers).find(c=>c.name===${JSON.stringify(who)}));` : ''}
  ${JSON.stringify(lines)}.forEach(v=>addOne(v));${discount ? `disc=${JSON.stringify(discount)};` : ''}const s=await checkout(${pay});closeModal();closeSheets();return s&&{id:s.id,no:s.no,total:s.total}`);

console.log('--- the center ---');
await settingsPage();
const tiles = await A.$$eval('#autoCenter .ac-k span', (l) => l.map((x) => x.textContent));
check('today at a glance: watching, noticed, done by itself, waiting for your OK', JSON.stringify(tiles) === '["Watching","Noticed today","Done by itself today","Waiting for your OK"]', tiles);
check('Watch has the morning briefing and backup (a backup file after 30 days); Act sends failed receipts again', await vis('#autoForm [data-watchrule="briefing"]') && await vis('#autoForm [data-watchrule="backup"]')
  && (await A.$eval('#autoForm [name="backupDays"]', (e) => e.value)) === '30' && (await A.$eval('#autoForm input[name="resend"]:checked', (e) => e.value)) === 'auto');
check('no rules of the shop\'s own yet, with examples', /No rules of your own yet/.test(await text('#customRulesBlk') || ''));

console.log('--- the morning briefing, switched from here ---');
await home();
const briefOn = await vis('#homeBody .hbrief');
await settingsPage(); await A.click('#autoForm input[name="w_briefing"][value="off"]'); await A.click('#autoForm [type="submit"]'); await sleep(300);
await home();
check('Morning briefing off: gone from Home (it was there)', briefOn && !(await A.$('#homeBody .hbrief')));
await settingsPage(); await A.click('#autoForm input[name="w_briefing"][value="notify"]'); await A.click('#autoForm [type="submit"]'); await sleep(300);
await home();
check('…on again: back', await vis('#homeBody .hbrief'));

console.log('--- your rules ---');
await settingsPage();
await choose('#customRuleForm [name="trigger"]', 'stock_at');
check('the form follows its trigger: a stock rule asks for the product; it can tell or note, not remind', await vis('#customRuleForm [name="product"]') && await vis('#customRuleForm [name="qty"]')
  && (await A.$$eval('#customRuleForm [name="action"] option', (o) => o.map((x) => x.value))).join() === 'notify,log');
await choose('#customRuleForm [name="trigger"]', 'owes_over');
check('…a customer owing: can write a reminder', (await A.$$eval('#customRuleForm [name="action"] option', (o) => o.map((x) => x.value))).join() === 'notify,log,remind' && !(await A.$('#customRuleForm [name="product"]')));
await addRule('bill_over', { amount: '500' }, 'notify');
await addRule('owes_over', { amount: '500' }, 'remind');
await addRule('discount_over', { pct: '10' }, 'log');
check('three rules, in words', JSON.stringify(await rules()) === JSON.stringify(['A bill over ₹500 → Tell me', 'A customer owing more than ₹500 → Write a reminder', 'A discount over 10% of a bill → Note it']), await rules());
await addRule('bill_over', { amount: '500' }, 'notify');
check('the same rule again is refused, saying why', /already there/.test(await text('#customErr') || '') && (await rules()).length === 3);
await addRule('sales_reach', { amount: '' }, 'notify');
check('a rule without its figure is refused', /Enter the amount/.test(await text('#customErr') || '') && (await rules()).length === 3);
check('kept with the shop\'s settings (they sync like them)', await run('return settings.automation.custom.length===3&&sbOfflineQueue.some(q=>q.type==="settings")||settings.automation.custom.length===3'));

const S1 = await sell([KURTA, KURTA], '"cash"');
const S2 = await sell([KURTA], '[{method:"cash",amount:200},{method:"due",amount:800}]', 'Riya');
const S3 = await sell([TEE], '"cash"', null, { type: 'percent', value: '20' });
await run('await flushSbQueue()');
check('three bills: ₹2,000 cash, ₹1,000 with ₹800 on Riya\'s account, ₹400 after 20% off', S1.total === 2000 && S2.total === 1000 && S3.total === 400, [S1, S2, S3]);
await home();
let att = await attention();
const big = att.find((a) => /bills over ₹500 today/.test(a.text));
check('"Tell me": Home → Needs attention has the bills over ₹500 (2 today; not the ₹400 one)', !!big && /2 bills over ₹500 today/.test(big.text) && /The biggest INV-000001 · ₹2,000/.test(big.text), att);
check('"Note it": the discount rule isn\'t on Home', !att.some((a) => /discount/.test(a.text)), att);
check('"Write a reminder": Riya waits for your OK (not on Home as a notice)', att.some((a) => a.id === 'approvals' && /waiting for your OK/.test(a.text)) && !att.some((a) => /Riya owes/.test(a.text)), att);
await A.click(`#homeBody [data-attn="${big.id}"] button`); await sleep(400);
check('the bills over ₹500 open in Bills, filtered (today, over ₹500)', await vis('#v-bills') && (await A.$$eval('#v-bills .billrow', (b) => b.length)) === 2 && /over ₹500/.test(await text('#v-bills .searchchips') || ''));
await run('openApprovals()'); await sleep(250);
const appr = await A.$$eval('#modalHost [data-appr]', (l) => l.map((x) => ({ key: x.dataset.appr, text: x.innerText.replace(/\s+/g, ' ') })));
const mine = appr.find((a) => a.key.startsWith('custom:'));
check('Approvals: "Remind Riya about ₹800", from Your rules', !!mine && /Remind Riya about ₹800/.test(mine.text) && /Your rules/i.test(mine.text), appr);
await A.click(`#modalHost [data-autoapprove="${mine.key}"]`); await sleep(300);
const url = await run('return window.__opened[0]||""');
check('approved: WhatsApp opens with the reminder typed in (₹800, the bill) — nothing sent by itself', /wa\.me\/919876543210\?text=/.test(url) && /800/.test(decodeURIComponent(url)) && /INV-000002/.test(decodeURIComponent(url)), url);
check('…and it stops waiting (snoozed)', !(await A.$(`#modalHost [data-appr="${mine.key}"]`)));
await run('closeModal();await runAutomation({online:false})');
const log = await run('return autoLog.map(e=>({rule:e.rule,action:e.action,text:e.text}))');
check('Activity: the discount noted once ("Noticed", Your rules), the bills over ₹500 noted too, the reminder approved', log.some((e) => e.rule === 'custom' && e.action === 'notified' && /discount over 10%/.test(e.text))
  && log.some((e) => e.rule === 'custom' && e.action === 'notified' && /over ₹500/.test(e.text)) && log.some((e) => e.rule === 'custom' && e.action === 'approved' && /Riya/.test(e.text)), log.slice(0, 8));
await run('await runAutomation({online:false})');
check('…once a day, not on every run', (await run('return autoLog.filter(e=>e.rule==="custom"&&e.action==="notified").length')) === 2);

await settingsPage();
const idBig = await run('return settings.automation.custom.find(r=>r.trigger==="bill_over").id'), idDisc = await run('return settings.automation.custom.find(r=>r.trigger==="discount_over").id');
await A.click(`#customRulesBlk [data-customon="${idBig}"]`); await sleep(300);
await home();
check('switched off: the bills over ₹500 leave Home', !(await attention()).some((a) => /over ₹500 today/.test(a.text)));
await settingsPage(); await A.click(`#customRulesBlk [data-customrm="${idDisc}"]`); await sleep(300);
check('removed: two rules left, the first marked off', (await rules()).length === 2 && /off/.test(await text(`#customRulesBlk [data-crule="${idBig}"] small`) || ''));
check('every change is in Activity ("Policy changed · Your rules")', await run('return ["added","switched off","removed"].every(w=>autoLog.some(e=>e.rule==="custom"&&e.action==="policy"&&e.text.includes(w)))'));

console.log('--- backup ---');
await run('syncReview=[{item:{type:"cust",id:"x"},err:"Not allowed",code:"PERMISSION",t:Date.now()}]');
await home();
check('a change the cloud refused: on Home, to look at in the sync review', (await attention()).some((a) => a.id === 'syncreview' && /1 change not saved in the cloud/.test(a.text)));
await run('syncReview=[];renderAll()');

console.log('--- failed receipts sent again ---');
await run(`deliveryQueue.push({id:"jt",saleId:${JSON.stringify(S2.id)},channel:"email",status:"failed",temp:true,attempts:5,first:Date.now()-3*36e5,nextAt:0,t:Date.now()-2*36e5,error:"The email service is busy."},
  {id:"jf",saleId:${JSON.stringify(S1.id)},channel:"email",status:"failed",temp:false,attempts:1,first:Date.now()-3*36e5,nextAt:0,t:Date.now()-2*36e5,error:"No email address."});saveDeliveryQueue()`);
const before = sends.length;
await run('await runAutomation({online:true})');
check('a receipt that failed for a passing reason: sent again by itself', await until(`deliveryQueue.find(j=>j.id==="jt").status==="sent"`) && sends.length === before + 1 && sends[sends.length - 1].sale_id === S2.id);
check('…one with a wrong contact: never', (await run('return deliveryQueue.find(j=>j.id==="jf").status')) === 'failed');
check('…in Activity: "Done automatically · 1 receipt sent again: INV-000002"', await run('return autoLog.some(e=>e.rule==="resend"&&e.action==="auto"&&/1 receipt sent again: INV-000002/.test(e.text))'));
await run(`const j=deliveryQueue.find(j=>j.id==="jt");Object.assign(j,{status:"failed",temp:true,t:Date.now()-2*36e5});await runAutomation({online:true})`);
await sleep(600);
check('…once a day: a second failure the same day waits for tomorrow', sends.length === before + 1 && (await run('return deliveryQueue.find(j=>j.id==="jt").status')) === 'failed');

await browser.close(); await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
