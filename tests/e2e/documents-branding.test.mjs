// Documents and branding, end to end in Chrome: Settings → Billing & Documents → Templates offers Standard, Classic,
// Modern and Compact with a live preview of the real document (it follows the form before saving); the authorised
// signature and company stamp are uploaded, previewed, replaced, removed and switched on or off for printing; they reach
// the cloud (hangtag_meta, private to the shop); the bill's A4 view and its PDF carry them; and a document without them
// has neither. The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import path from 'path';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000d1', EMAIL = 'ownerdocs@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q = async (sql, p = []) => (await pg.as(sql, p)).rows;
const PIC = path.resolve('icon-192.png');   // a PNG picture to upload (the app's own icon)

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
/* the live preview's document: its template class and which pictures it shows */
const live = () => A.evaluate(() => { const f = document.querySelector('#docTplLive iframe'), d = f && f.contentDocument; const a = d && d.querySelector('article.doc');
  return a ? { cls: a.className, sign: !!d.querySelector('img.d-signimg'), stamp: !!d.querySelector('img.d-stamp'), h: Math.round(f.getBoundingClientRect().height) } : null; });
check('signed in and connected', await until('sbStatus==="connected"'));
await run(`openEditor(null);editor.name="Kurta";editor.price="1000";edCombos()[0].cell.stock="40";saveEditor();closeModal();await flushSbQueue();
  setTab("sell");renderAll();addOne(products()[0].variants[0].id);await checkout("cash");closeSheets();await flushSbQueue()`);
const SID = await run('return lastSale.id');

console.log('--- the templates and the live preview ---');
await run('openSettings("billing")'); await sleep(400);
check('Templates offer Standard, Classic, Modern and Compact', (await A.$$eval('#docTplForm [name="docTpl"]', (r) => r.map((x) => x.value))).join() === 'standard,classic,modern,compact');
check('the preview is the real document (the latest bill in its frame), shown before anything is saved', await until('!!document.querySelector("#docTplLive iframe")&&!!document.querySelector("#docTplLive iframe").contentDocument.querySelector("article.doc")')
  && /t-modern/.test((await live()).cls) && (await live()).h > 200, await live());
await A.click('#docTplForm input[name="docTpl"][value="compact"]'); await sleep(450);
check('choosing Compact redraws the preview in Compact at once', /t-compact/.test(((await live()) || {}).cls || ''), await live());
check('the pictures: none yet, nothing to switch on', /None yet/.test(await text('#docTplForm [data-docpic="signature"]') || '') && await A.$eval('#docTplForm [name="docSignImg"]', (e) => e.disabled));

console.log('--- the signature and stamp ---');
const sigIn = await A.$('#docTplForm [data-docpicfile="signature"]'); await sigIn.uploadFile(PIC); await sleep(900);
check('the signature is uploaded: shown in its card, Replace and Remove offered, printed (switched on)', await vis('#docTplForm [data-docpic="signature"] .docpic-prev img')
  && /Replace/.test(await text('#docTplForm [data-docpic="signature"]') || '') && await vis('#docTplForm [data-docpicremove="signature"]') && await A.$eval('#docTplForm [name="docSignImg"]', (e) => e.checked && !e.disabled));
const stIn = await A.$('#docTplForm [data-docpicfile="stamp"]'); await stIn.uploadFile(PIC); await sleep(900);
await sleep(300);
let L = await live();
check('the preview shows both, at the signature (and still in Compact)', L && L.sign && L.stamp && /t-compact/.test(L.cls), L);
check('kept on this device as small pictures', await run('return /^data:image\\/jpeg;base64,/.test(docImages.signature)&&/^data:image\\/jpeg;base64,/.test(docImages.stamp)&&docImages.signature.length<200000'));
await run('await flushSbQueue()');
const meta = await q(`SELECT key, (value->>'data') LIKE 'data:image/jpeg;base64,%' AS pic FROM public.hangtag_meta WHERE key IN ('doc_signature','doc_stamp') ORDER BY key`);
check('...and uploaded for the shop\'s other devices (hangtag_meta doc_signature, doc_stamp)', meta.length === 2 && meta.every((m) => m.pic), meta);
await A.click('#docTplForm [name="docStampImg"]'); await sleep(450);
L = await live();
check('switching the stamp off takes it off the preview, the signature stays', L && L.sign && !L.stamp, L);
await A.click('#docTplForm button[type="submit"]'); await sleep(300);
check('Save templates keeps Compact and the stamp switched off', await run('return settings.docTpl==="compact"&&settings.docStampImg===false&&settings.docSignImg!==false'));
await run('await flushSbQueue()');
const cloud = (await q(`SELECT value FROM public.hangtag_meta WHERE key = 'settings'`))[0];
check('...in the cloud with the shop\'s settings', cloud && cloud.value.docTpl === 'compact' && cloud.value.docStampImg === false, cloud && { docTpl: cloud.value.docTpl, docStampImg: cloud.value.docStampImg });

console.log('--- the bill\'s A4 view and its PDF ---');
await run(`openBillView(${JSON.stringify(SID)},"a4")`); await sleep(600);
const A4 = await A.evaluate(() => { const f = document.querySelector('.billview iframe'), d = f && f.contentDocument; return d ? { cls: d.querySelector('article.doc').className, sign: !!d.querySelector('img.d-signimg'), stamp: !!d.querySelector('img.d-stamp') } : null; });
check('the bill\'s A4 view: Compact, with the signature and without the stamp (switched off)', A4 && /t-compact/.test(A4.cls) && A4.sign && !A4.stamp, A4);
await run(`window.__pdf=null;const f=use("files");override({files:{...f,saveFile:async(n,d)=>{window.__pdf={n,head:String.fromCharCode(...d.slice(0,5)),im2:new TextDecoder("latin1").decode(d).includes("/Im2 Do"),im3:new TextDecoder("latin1").decode(d).includes("/Im3 Do")};return true}}})`);
await A.click(`.billview [data-billpdf="${SID}"]`); await sleep(700);
const P = await run('return window.__pdf');
check('its PDF carries the signature (and not the switched-off stamp)', P && P.head === '%PDF-' && P.im2 && !P.im3, P);
await run('closeModal()');

console.log('--- remove ---');
await run('openSettings("billing")'); await sleep(400);
await A.click('#docTplForm [data-docpicremove="signature"]'); await sleep(450);
L = await live();
check('Remove takes the signature away: its card says none yet, the preview has no signature picture', /None yet/.test(await text('#docTplForm [data-docpic="signature"]') || '') && L && !L.sign, L);
await run('await flushSbQueue()');
check('...and from the cloud', (await q(`SELECT count(*)::int AS n FROM public.hangtag_meta WHERE key = 'doc_signature'`))[0].n === 0);

console.log('--- phone ---');
await A.setViewport({ width: 375, height: 812 }); await sleep(500);
await run('openSettings("billing")'); await sleep(500);
const fit = await A.evaluate(() => ({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth, cards: [...document.querySelectorAll('#docTplForm .docpic')].map((c) => Math.round(c.getBoundingClientRect().right)) }));
check('on a phone the templates, preview and picture cards fit the screen', fit.over <= 0 && fit.cards.every((r) => r <= 375), fit);

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
