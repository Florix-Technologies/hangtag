// Products → Import, end to end in Chrome: the template a shop owner downloads (notes, plain column names, example
// products), a filled-in CSV with mistakes (shown row by row in the sheet's own row numbers, with what to change, and
// downloadable with the problems written in), the corrected file imported (products, colour × size variants, opening
// stock, all in the database), the same file again (products already in the shop refused, or left out on request) and the
// phone layout. The database is PGlite running the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000f7', EMAIL = 'ownerimport@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, onboarded_at) VALUES ($1,$2,'Owner','Import Shop','9876543210','Pune','Maharashtra',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q1 = async (sql) => (await pg.as(sql, [])).rows;

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
// files the app saves are kept for the test instead of downloaded
await run('const f=use("files");window.__saved=[];f.saveFile=async(name,data,type)=>{window.__saved.push({name,type,text:typeof data==="string"?data:null,bytes:data&&data.length||0});return true;};');

// ---------- 1. the screen and the template ----------
await run('setTab("products");renderAll()'); await sleep(250);
await A.click('[data-act="prodimport"]'); await sleep(250);
check('Import products: three steps (download, fill in, choose), the column guide', (await A.$$('.im-steps > li')).length === 3 && !!(await A.$('[data-imp="tplxlsx"]')) && !!(await A.$('[data-imp="tplcsv"]'))
  && !!(await A.$('.im-help summary')) && (await A.$eval('#impGo', (b) => b.disabled)));
await A.click('.im-help summary'); await sleep(100);
check('…the guide says what goes in each column', /Selling price\s*Yes/.test(await text('.im-helpt')) && /Barcode\s*No/.test(await text('.im-helpt')));
await A.click('[data-imp="tplcsv"]'); await sleep(200);
const csv = (await run('return window.__saved[0]')) || {};
const lines = String(csv.text || '').replace(/^﻿/, '').split('\n');
check('CSV template: notes first, then plain column names, then example products', csv.name === 'hangtag-products-template.csv' && /^"?# HOW TO FILL THIS IN/.test(lines[0])
  && lines.some((l) => l.startsWith('Product name (required),Colour,Size,Selling price (required),Cost price,Stock quantity,SKU,Barcode')) && lines.some((l) => /^Cotton Round-Neck T-shirt,Black,M,499/.test(l)), lines.slice(0, 10));
await A.click('[data-imp="tplxlsx"]'); await sleep(200);
const xl = await run('return window.__saved[1]');
check('Excel template too', xl && xl.name === 'hangtag-products-template.xlsx' && xl.bytes > 2000, xl);

// ---------- 2. a filled-in file with mistakes ----------
const head = 'Product name (required),Colour,Size,Selling price (required),Cost price,Stock quantity,SKU,Barcode,Category,Brand,GST %,HSN code,Unit,Low stock alert,Description';
const notes = lines.filter((l) => /^"?#/.test(l));
const examples = lines.filter((l) => /^Cotton Round-Neck|^Steel Water|^Basmati/.test(l));
const good = [
  'Linen Shirt,Blue,M,1299,650,4,LIN-BL-M,,Shirts,Aura,5,6205,pcs,2,Pure linen',
  'Linen Shirt,Blue,L,1299,650,3,LIN-BL-L,,Shirts,Aura,5,6205,pcs,2,',
  'Linen Shirt,White,M,1349,650,5,LIN-WH-M,,Shirts,Aura,5,6205,pcs,2,',
  'Ceramic Mug,,,249,110,12,MUG-01,8901234567890,Kitchen,,18,6912,pcs,4,',
  'Toor Dal,,,140,110,20.5,DAL-TOOR,,Groceries,,5,0713,kg,5,Loose',
];
const bad = [...good.slice(0, 3), 'Ceramic Mug,,,249.50,110,12,MUG-01,8.90123E+12,Kitchen,,18,6912,pcs,4,', 'Toor Dal,,,140,110,20.5,DAL-TOOR,,Groceries,,5,713,kg,5,Loose', ',,,99,,1,,,,,,,,,'];
const write = (name, rows) => { const p = H.ARTIFACTS + '/' + name; fs.writeFileSync(p, '﻿' + rows.join('\r\n') + '\r\n'); return p; };
const BAD = write('import-mistakes.csv', [...notes, head, ...examples, '', ...bad]);
await (await A.$('#impFile')).uploadFile(BAD);
check('the file is checked and shown', await until('prodImport&&prodImport.check&&!prodImport.busy'));
const firstRow = notes.length + 1 + examples.length + 2;   // the header, the examples, a blank row
const cards = await A.$$eval('.im-card', (l) => l.map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
check('summary cards: products, rows, stock, and 3 rows to fix', cards.length === 4 && /^3 to fix$/.test(cards[3]), cards);
check('nothing can be imported while rows need fixing; the banner says why', (await A.$eval('#impGo', (b) => b.disabled)) && /3 rows need fixing\. Nothing is imported until every row is right/.test(await text('.im-sum.bad')));
check('the rows that need fixing are shown first (filter "Needs fixing")', (await A.$eval('[data-imp-filter="bad"]', (b) => b.getAttribute('aria-pressed'))) === 'true' && (await A.$$('.im-r')).length === 3);
const shown = await A.$$eval('.im-r', (l) => l.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
check("each problem in the sheet's own row number, in its column's name, with what to write", shown[0].startsWith(String(firstRow + 3)) && /Selling price “249\.50” has decimals: use a whole amount \(249 or 250\)/.test(shown[0])
  && /Barcode “8\.90123E\+12” was shortened by Excel/.test(shown[0]) && /HSN code “713” should be 4, 6 or 8 digits \(Excel may have removed a 0/.test(shown[1]) && /Product name is empty/.test(shown[2]), shown);
check('the template\'s examples are left out, and said so', /5 example rows from the template are left out/.test(await text('.im-body')));
await A.click('[data-imp-filter="all"]'); await sleep(150);
check('"All" shows every row: ready ones marked Ready, examples marked Left out', (await A.$$('.im-r')).length === 11 && (await A.$$('.im-r.ok')).length === 3 && (await A.$$('.im-r.skip')).length === 5);
await A.click('[data-imp="problems"]'); await sleep(200);
const prob = await run('return window.__saved[2]');
const plines = String(prob && prob.text || '').replace(/^﻿/, '').split('\n');
check('download the file with the problems written next to each row', prob && prob.name === 'import-mistakes - problems.csv' && /,Problems$/.test(plines[notes.length]) && /has decimals/.test(plines[firstRow + 2]) && /Example row: not imported/.test(plines[notes.length + 1]), plines.slice(notes.length, notes.length + 3));
check('nothing reached the catalog or the database', (await run('return products().length')) === 0 && (await q1('SELECT count(*)::int n FROM public.hangtag_products'))[0].n === 0);

// ---------- 3. the corrected file ----------
const GOOD = write('import-fixed.csv', [...notes, head, ...examples, ...good]);
await (await A.$('#impFile')).uploadFile(GOOD);
check('corrected: "Everything looks right", Import names how many', await until('prodImport&&prodImport.check&&prodImport.check.ok') && /Everything looks right/.test(await text('.im-sum.ok')) && (await text('#impGo')) === 'Import 3 products');
await A.click('#impGo');
check('imported: the screen closes', await until('!prodImport'));
const local = await run('return products().map(p=>({n:p.name,v:p.variants.length,unit:p.unit||"pcs",opts:(p.opts||[]).map(o=>o.n+":"+o.v.join("/")).join(" ")}))');
check('this device: 3 products, the shirt with Colour × Size variants, dal by the kg', local.length === 3 && local.find((p) => p.n === 'Linen Shirt').v === 3 && local.find((p) => p.n === 'Linen Shirt').opts === 'Colour:Blue/White Size:M/L' && local.find((p) => p.n === 'Toor Dal').unit === 'kg', local);
await run('await flushSbQueue()');
check('the database: products, variants (the white shirt at its own price), opening stock', await until('true') && (await q1('SELECT count(*)::int n FROM public.hangtag_products'))[0].n === 3
  && (await q1('SELECT count(*)::int n FROM public.hangtag_variants'))[0].n === 5
  && (await q1(`SELECT price FROM public.hangtag_variants WHERE sku = 'LIN-WH-M'`))[0].price === 1349
  && +(await q1(`SELECT sum(qty)::float q FROM public.hangtag_stock_moves WHERE type = 'OPENING'`))[0].q === 44.5, await q1('SELECT name FROM public.hangtag_products'));

// ---------- 4. the same file again ----------
await A.click('[data-act="prodimport"]'); await sleep(250);
await (await A.$('#impFile')).uploadFile(GOOD);
await until('prodImport&&prodImport.check&&!prodImport.busy');
check('the same file again: each product already in the shop is refused, with one reason', /already in your shop/.test(await text('.im-r.bad')) && (await A.$$('.im-r.bad')).length === 5 && !!(await A.$('#impSkipEx')));
await A.click('#impSkipEx'); await sleep(200);
check('"Leave them out": nothing left to import, said plainly (Import stays off)', /There is nothing to import/.test(await text('.im-sum.bad')) && (await A.$eval('#impGo', (b) => b.disabled)));
const MORE = write('import-more.csv', [head, ...good, 'Bamboo Toothbrush,,,59,20,30,BRUSH-01,,Personal care,,12,9603,pcs,10,']);
await (await A.$('#impFile')).uploadFile(MORE);
await until('prodImport&&prodImport.check&&prodImport.check.ok');
check('a file with one new product and the known ones: with "Leave them out" on, only the new one is imported', (await text('#impGo')) === 'Import 1 product' && (await A.$$('.im-r.skip')).length === 5);

// ---------- 5. the phone ----------
await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(300);   // (puppeteer reloads the page for this)
await until('sbStatus==="connected"');
await run('setTab("products");renderAll()'); await sleep(250);
check('phone: Products has Import', await A.$eval('[data-act="prodimport"]', (b) => b.getClientRects().length > 0).catch(() => false));
await A.$eval('[data-act="prodimport"]', (b) => b.click()); await sleep(250);
await (await A.$('#impFile')).uploadFile(BAD);
await until('prodImport&&prodImport.check&&!prodImport.busy');
const overflow = await A.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const cardRows = await A.$$eval('.im-r', (l) => l.every((r) => getComputedStyle(r).display === 'block'));
check('phone: the preview fits the width, one card per row', overflow <= 1 && cardRows, { overflow, cardRows });
await A.screenshot({ path: H.ARTIFACTS + '/import_phone.png' });
await A.setViewport({ width: 1280, height: 900 }); await sleep(200);
await A.screenshot({ path: H.ARTIFACTS + '/import_desktop.png' });
await run('prodImport=null;closeModal()');

await browser.close(); await pg.db.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
