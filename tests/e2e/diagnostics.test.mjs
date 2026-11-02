// Security and observability, end to end in Chrome: the page runs under its Content-Security-Policy with the Supabase
// library pinned by Subresource Integrity; technical problems (logged, uncaught, failed background work) go into the
// on-device history cleaned of customer, contact, bill and money details; Settings → Advanced → Diagnostics & health
// shows the device's health and those problems; the support report downloads with nothing private in it; Clear empties
// it. The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000a2', EMAIL = 'ownerdiag@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);

const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
const A = await (await browser.createBrowserContext()).newPage();
await A.setViewport({ width: 1280, height: 900 });
const violations = [];
A.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
A.on('console', (m) => { if (/Content.Security.Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
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

console.log('--- the page\'s protections ---');
const head = await A.evaluate(() => ({ csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '', sri: [...document.scripts].filter((s) => /supabase-js@\d+\.\d+\.\d+\//.test(s.src)).map((s) => s.integrity), lib: !!window.supabase }));
check('a Content-Security-Policy: no plugins, no inline event handlers, scripts only from the app and the pinned CDN', /object-src 'none'/.test(head.csp) && /script-src-attr 'none'/.test(head.csp) && /base-uri 'none'/.test(head.csp) && !/script-src[^;]*'unsafe-inline'/.test(head.csp), head.csp);
check('the Supabase library is a pinned version checked by its integrity hash (and it loaded)', head.sri.length === 1 && /^sha384-/.test(head.sri[0]) && head.lib, head);

console.log('--- problems go into the cleaned history ---');
await run(`clearDiagnostics();logger.error("Upload failed for customer: Riya Sharma, +91 98765 43210 riya@example.com bill INV-000123 of ₹1,250 token=abc123secret");
  window.dispatchEvent(new ErrorEvent("error",{message:"Cannot read total",error:new Error("Cannot read total of 9876543210"),filename:"http://localhost:3210/src/features/bills/pages/bills-page.js",lineno:42,colno:7}));
  window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection",{promise:Promise.resolve(),reason:new Error("Background sync failed")}));`);
const hist = await run('return getDiagnostics()');
check('three problems recorded: the logged one, an uncaught error (with its file and line) and a failed background task', hist.length === 3 && hist[1].source === 'window.error' && /bills-page\.js$/.test(hist[1].file) && hist[1].line === 42 && hist[2].source === 'promise', hist);
check('...with no name, phone, email, bill number, amount or secret in them', !/Riya|98765|riya@|INV-000123|1,250|abc123secret/.test(JSON.stringify(hist)), hist.map((h) => h.message));

console.log('--- Settings → Advanced → Diagnostics & health ---');
await run('openSettings("advanced")'); await sleep(400);
const blk = await text('#diagBlk');
check('health: online, cloud connected, nothing waiting or refused', /Internet Online/.test(blk || '') && /Cloud Connected/.test(blk || '') && /Changes waiting to upload 0/.test(blk || '') && /Refused by the database 0/.test(blk || ''), blk);
const firstLi = await text('#diagBlk .diag-list li:first-child'), nEntries = await A.$$eval('#diagBlk [data-diag-entry]', (l) => l.length);
check('...and the recent problems, newest first, cleaned', nEntries === 3 && /Background sync failed/.test(firstLi || '') && !/Riya|98765/.test(blk || ''), { nEntries, firstLi, blk });
await run('window.__saved=null;const f=use("files");override({files:{...f,saveFile:async(n,d,t)=>{window.__saved={n,d,t};return true}}})');
await A.click('#diagBlk [data-diag="download"]'); await sleep(300);
const saved = await run('return window.__saved');
const rep = saved && JSON.parse(saved.d);
const lat = await A.$$eval('#diagBlk .diag-lat [data-lat-op]', (l) => l.map((x) => ({ op: x.dataset.latOp, calls: +x.children[1].textContent })));
check('server calls: every call this device made, timed by operation (calls, failed, average, most within, slowest)', lat.length > 0 && lat.every((o) => /^(rpc|table|fn|auth):|^storage$|^other$/.test(o.op) && o.calls > 0)
  && /Server calls · last 24 hours/.test(blk || '') && /typical/.test(blk || ''), lat);
check('Download report: a JSON file with the health, the last 24 h counts, the server-call timings and the cleaned history only', saved && /^hangtag-diagnostics-\d{4}-\d{2}-\d{2}\.json$/.test(saved.n) && rep.schema === 3 && rep.health.cloud === 'connected' && rep.diagnostics.length === 3
  && rep.latency.calls > 0 && rep.latency.ops.every((o) => !/[?=]/.test(o.op)) && Array.isArray(rep.agentChains)
  && Object.values(rep.last24h || {}).every((n) => Number.isInteger(n)) && !/Riya|98765|riya@|INV-000123|abc123secret|ownerdiag@example\.com|aaaaaaaa-0000/.test(saved.d), saved && saved.n);
check('the panel counts the last 24 hours by category (API, sync, payments, email, WhatsApp, SMS, printer, Agent, automation, database) and says nothing is sent by itself',
  (await A.$$eval('#diagBlk [data-diag-cat]', (l) => l.map((x) => x.dataset.diagCat))).join() === 'api,sync,payment,email,whatsapp,sms,printer,agent,automation,database' && /Never sent anywhere by itself/.test(await text('#diagBlk') || ''));
await A.click('#diagBlk [data-diag="clear"]'); await sleep(300);
check('Clear asks first, on the button itself (no browser pop-up): nothing is cleared by one tap', await run('return getDiagnostics().length') === 3 && /Tap again to clear/.test(await text('#diagBlk [data-diag="clear"]') || ''));
await A.click('#diagBlk [data-diag="clear"]'); await sleep(300);
check('…the second tap empties the history and the timings', await run('return getDiagnostics().length') === 0 && /No technical problems recorded/.test(await text('#diagBlk') || '')
  && await run('return getTraces().length===0&&latencySummary().calls<5') && /no questions yet on this device/.test(await text('#diagBlk') || ''));

console.log('--- the Agent chain ---');
// a question the Agent answers with a tool: its chain (request → tool → result → outcome) is noted, as codes only
await run('closeModal();setTab("assistant");renderAll()'); await sleep(300);
await A.$eval('#askQuestion', (e) => { e.value = 'Morning briefing'; });
await A.click('#askForm button[type="submit"]');
await until('!document.querySelector("#askForm button[type=submit]").disabled&&!!document.querySelector("#v-assistant .ask-answer")');
await run('openSettings("advanced")'); await sleep(400);
const chain = await text('#diagBlk .diag-chains li:first-child');
check('the question\'s chain: asked → tool get_daily_briefing → its result → answered — without the question\'s words', /asked question/.test(chain || '') && /tool get_daily_briefing/.test(chain || '') && /result get_daily_briefing · \d+ rows?/.test(chain || '')
  && /answered/.test(chain || '') && !/Morning briefing/.test(chain || ''), chain);
check('…in the report too', await run('return diagnosticsReport({}).agentChains[0].steps.map(s=>s.step).join()') === 'request,tool,result,outcome');

console.log('--- phone ---');
await A.setViewport({ width: 360, height: 780 }); await sleep(400);
await run('openSettings("advanced")'); await sleep(400);
check('on a phone the panel fits the screen', await A.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);
check('no Content-Security-Policy violations while using the app', violations.length === 0, violations.slice(0, 3));

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
