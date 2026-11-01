// Products → Import, the preview of a large file, end to end in Chrome against PGlite running the real schema.sql behind
// the PostgREST stand-in (row security on). The file is shaped like the ones shops send (a title and a note above the
// column names, a description on every row, stock not yet counted on some rows, products the shop already has), and
// large (230 rows): the column names are found below the title; the rows are shown 50 a page; a search narrows them; the
// filters (Needs fixing, Ready, Left out) and the List and Grid views work together; each row says what it becomes (a new
// product, a new variant of one, a variant the shop has, a new colour or size of one) and nothing about an existing product
// changes; "Keep each product's first description" is the merchant's choice; stock left empty is "not given" (—), never 0,
// and announced; what is imported matches, row for row, what the database then holds. Then the phone.
// Run: node tests/e2e/product-import-preview.test.mjs
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';

if (!H.CHROME) { console.log('skipped: ' + H.NO_BROWSER); process.exit(77); }
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000f9', EMAIL = 'ownerpreview@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, onboarded_at) VALUES ($1,$2,'Owner','Preview Shop','9876543210','Pune','Maharashtra',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);
const q1 = async (sql) => (await pg.as(sql, [])).rows;

// ---------- the files ----------
const HEAD = 'Product name (required),Colour,Size,Selling price (required),Cost price,Stock quantity,SKU,Barcode,Category,Brand,GST %,HSN code,Unit,Low stock alert,Description';
const KURTA_C = ['Ivory', 'Maroon', 'Indigo', 'Olive', 'Mustard', 'Rose', 'Teal', 'Charcoal'], KURTA_S = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const SHIRT_C = ['White', 'Sky', 'Sage', 'Sand', 'Navy'], SHIRT_S = ['S', 'M', 'L', 'XL', 'XXL'];
const kurta = KURTA_C.flatMap((c, i) => KURTA_S.map((s, j) => `Cotton Kurta,${c},${s},1299,640,${(i + j) % 4 === 0 ? '' : (i + j) % 4},KUR-${i}-${j},,Ethnic,Aura,5,6211,pcs,2,${c} kurta in ${s}`));
const shirt = SHIRT_C.flatMap((c, i) => SHIRT_S.map((s, j) => `Linen Shirt,${c},${s},1499,720,3,LIN-${i}-${j},,Shirts,Aura,5,6205,pcs,2,Pure linen`));
const items = Array.from({ length: 150 }, (_, k) => `Item ${String(k + 1).padStart(3, '0')},,,${100 + k},${50 + k},${k % 3 === 0 ? '' : k % 3 === 1 ? '0' : '7'},ITEM-${k + 1},,General,,18,9619,pcs,,`);
const socks = ['Socks,Teal Green,Small,750,300,4,SOCK-TG-S-2,,Socks,Marigold Threads,5,6115,pcs,,', 'Socks,Teal Green,Medium,750,300,5,SOCK-TG-M,,Socks,Marigold Threads,5,6115,pcs,,',
  'Socks,Grape,Small,750,300,5,SOCK-GR-S,,Socks,Marigold Threads,5,6115,pcs,,', 'Socks,Grape,Large,750,300,,SOCK-GR-L,,Socks,Marigold Threads,5,6115,pcs,,'];
const broken = ['Desk Lamp,,,,400,2,LAMP-1,,Home,,18,9405,pcs,,', 'Wall Clock,,,899,400,2,CLOCK-1,,Home,,18,91,pcs,,', ',,,,,,,,,,,,,,'.replace(/^,/, 'X Bag,') + 'bad'];
const fixed = ['Desk Lamp,,,1199,400,2,LAMP-1,,Home,,18,9405,pcs,,', 'Wall Clock,,,899,400,2,CLOCK-1,,Home,,18,9105,pcs,,', 'X Bag,,,499,,,,,,,,,,,'];
const TITLE = ['Marigold Threads — stock update (shop file)', 'Prices from the latest message. Quantities left blank are not counted yet.'];
const write = (name, rows) => { const p = H.ARTIFACTS + '/' + name; fs.writeFileSync(p, '﻿' + rows.join('\r\n') + '\r\n'); return p; };
const FIRST = write('preview-socks.csv', [HEAD, 'Socks,Teal Green,Small,750,300,4,SOCK-TG-S,,Socks,Marigold Threads,5,6115,pcs,,']);
const BIG = write('preview-big.csv', [...TITLE, HEAD, ...kurta, ...shirt, ...items, ...socks, ...broken]);
const BIG_FIXED = write('preview-big-fixed.csv', [...TITLE, HEAD, ...kurta, ...shirt, ...items, ...socks, ...fixed]);
const ROWS = kurta.length + shirt.length + items.length + socks.length + broken.length;

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
async function until(cond, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(120); } return false; }
const text = (sel) => A.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const rowsShown = () => A.$$eval('#impBrowse .im-r', (l) => l.map((r) => r.querySelector('td').textContent.trim()));
async function choose(file) { await (await A.$('#impFile')).uploadFile(file); return until('prodImport&&prodImport.check&&!prodImport.busy'); }
async function click(sel) { await A.click(sel); await sleep(150); }
/* as a person does: clear the box (an input event, as deleting the text gives), then type */
async function typeSearch(v) { await A.$eval('#impQ', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); if (v) await A.type('#impQ', v); await sleep(200); }

try {
  check('signed in and connected', await until('sbStatus==="connected"'));
  await run('setTab("products");renderAll()'); await sleep(250);
  // the shop has Socks, Teal Green / Small (4 in stock)
  await click('[data-act="prodimport"]');
  check('the shop\'s first product: Socks, Teal Green / Small', await choose(FIRST) && (await text('#impGo')) === 'Import 1 product');
  await click('#impGo'); await run('await flushSbQueue()');
  check('…saved in the cloud with its 4 in stock', await until('true') && (await q1('SELECT count(*)::int n FROM public.hangtag_variants'))[0].n === 1
    && +(await q1(`SELECT sum(qty)::float q FROM public.hangtag_stock_moves`))[0].q === 4);

  // ---------- the large file ----------
  await click('[data-act="prodimport"]');
  check(`the large file (${ROWS} rows under a title) is read`, await choose(BIG));
  const notesTxt = await text('#modalHost .im-body');
  check('the column names are found on row 3, below the title and its note — "2 rows above them … are left out"', /The column names are on row 3: 2 rows above them \(a title or notes\) are left out/.test(notesTxt || ''), (notesTxt || '').slice(0, 300));
  const c0 = await run('return {e:prodImport.check.errorCount,d:prodImport.check.summary.descConflicts,nq:prodImport.check.summary.noQty,ex:prodImport.check.existing}');
  check('rows to fix: the 3 broken ones, the 47 kurta rows with their own description, the 4 Socks rows (the shop has Socks)', c0.e === 3 + 47 + 4 && c0.d === 47 && JSON.stringify(c0.ex) === '["Socks"]', c0);
  check('"Needs fixing" is chosen; 50 rows on the first page, the pager says 1–50 of 54', (await A.$eval('[data-imp-filter="bad"]', (b) => b.getAttribute('aria-pressed'))) === 'true'
    && (await rowsShown()).length === 50 && /Rows 1–50 of 54/.test(await text('#impRange') || ''), await text('#impRange'));
  await click('[data-imp-page="next"]');
  check('Next: rows 51–54, and Next can\'t go further', (await rowsShown()).length === 4 && /Rows 51–54 of 54/.test(await text('#impRange') || '') && (await A.$eval('[data-imp-page="next"]', (b) => b.disabled)));
  // the merchant's choices
  await click('#impFirstDesc');
  const c1 = await run('return prodImport.check.errorCount');
  check('"Keep each product\'s first description": the 47 description rows are fine now (7 left: 3 broken, 4 Socks)', c1 === 7 && (await A.$eval('#impFirstDesc', (e) => e.checked)), c1);
  await click('#impSkipEx');
  const c2 = await run('return {e:prodImport.check.errorCount,skip:prodImport.check.summary.skipped,nv:prodImport.check.summary.newVariantsOfExisting}');
  check('"Leave them out": the 4 Socks rows left out (3 of them new colours or sizes of it), only the 3 broken rows to fix', c2.e === 3 && c2.skip === 4 && c2.nv === 3, c2);
  await click('[data-imp-filter="skip"]');
  const skipTxt = await A.$$eval('#impBrowse .im-r', (l) => l.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
  check('Left out: the Socks variant the shop has ("nothing about it changes") and its 3 new colours or sizes ("add it to the product")',
    skipTxt.length === 4 && skipTxt.filter((t) => /Already in your shop: left out, nothing about it changes/.test(t)).length === 1
    && skipTxt.filter((t) => /A new colour or size of a product your shop has: left out \(add it to the product in Products\)/.test(t)).length === 3, skipTxt);
  // search with a filter
  await click('[data-imp-filter="all"]');
  await typeSearch('kurta maroon');
  const found = await A.$$eval('#impBrowse .im-r', (l) => l.map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('search "kurta maroon": the 6 Maroon kurta rows, focus kept in the search box', found.length === 6 && found.every((t) => /Cotton Kurta/.test(t) && /Maroon/.test(t))
    && (await A.evaluate(() => document.activeElement && document.activeElement.id)) === 'impQ', found.length);
  const roles = await A.$$eval('#impBrowse .im-role', (l) => l.map((e) => e.textContent));
  check('…each says what it becomes: new variants of Cotton Kurta (its first row is the new product, Ivory XS)', roles.length === 6 && roles.every((r) => r === 'New variant of Cotton Kurta'), roles);
  const notes = await A.$$eval('#impBrowse .im-note', (l) => l.map((e) => e.textContent));
  check('…and that their own description is left out (the kurta keeps row 4\'s)', notes.length === 6 && notes.every((n) => /keeps row 4's/.test(n)), notes);
  await typeSearch('Item 01');
  const stocks = await A.$$eval('#impBrowse .im-r', (l) => l.map((r) => [r.querySelector('td').textContent.trim(), r.querySelector('td[data-l="Stock"]').innerText.trim()]));
  check('stock as given: an empty cell is "—" (not given), a 0 is 0, a count is the count', stocks.length >= 10 && stocks.some(([, s]) => s === '—') && stocks.some(([, s]) => s === '0') && stocks.some(([, s]) => s === '7'), stocks.slice(0, 6));
  check('…and the rows with no quantity are announced: added without stock, "Nothing is assumed"', /rows have no stock quantity.*added without stock.*Nothing is assumed/.test(await text('.im-noqty') || ''), await text('.im-noqty'));
  // the grid: one card per product
  await typeSearch('');
  await click('[data-imp-view="grid"]');
  const cards = await A.$$eval('#impResults .im-pcard', (l) => l.map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
  const kurtaCard = cards.find((t) => /^Cotton Kurta/.test(t)) || '';
  check('Grid: one card per product; 50 a page (Products 1–50 of 156)', cards.length === 50 && /Products 1–50 of 156/.test(await text('#impRange') || ''), { n: cards.length, range: await text('#impRange') });
  check('…the kurta\'s card: a new product with 48 variants, its 8 colours and 6 sizes, its stock and the rows without a quantity',
    /Ready/.test(kurtaCard) && /New product · 48 variants/.test(kurtaCard) && KURTA_C.every((c) => kurtaCard.includes(c)) && KURTA_S.every((s) => kurtaCard.includes(s)) && /without a quantity/.test(kurtaCard), kurtaCard);
  await click('[data-imp-filter="bad"]');
  const badCards = await A.$$eval('#impResults .im-pcard', (l) => l.map((c) => c.innerText.replace(/\s+/g, ' ').trim()));
  check('Grid with "Needs fixing": the broken products, each with its row and what to change', badCards.length === 3 && badCards.some((t) => /Desk Lamp/.test(t) && /Row \d+:.*Selling price is empty/.test(t))
    && badCards.some((t) => /Wall Clock/.test(t) && /HSN code/.test(t)), badCards);
  check('Import stays off while anything needs fixing', await A.$eval('#impGo', (b) => b.disabled));
  await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(300);
  await until('sbStatus==="connected"');
} finally { /* the phone part below reopens what it needs */ }

// ---------- the corrected file, imported; then what the cloud holds ----------
await run('setTab("products");renderAll()'); await sleep(250);
await A.$eval('[data-act="prodimport"]', (b) => b.click()); await sleep(250);
await choose(BIG_FIXED);
for (const id of ['#impFirstDesc', '#impSkipEx']) await A.$eval(id, (e) => e.click()); await sleep(250);
const over = await A.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('phone: the preview fits (no sideways scroll), the list one card per row', over <= 1 && (await A.$$eval('#impBrowse .im-r', (l) => l.length && l.every((r) => getComputedStyle(r).display === 'block'))), over);
await A.$eval('[data-imp-view="grid"]', (b) => b.click()); await sleep(200);
check('phone: the grid fits too', (await A.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await A.screenshot({ path: H.ARTIFACTS + '/import_preview_phone.png' });
const plan = await run('return {ok:prodImport.check.ok,p:prodImport.check.summary.products,v:prodImport.check.summary.variants,pieces:prodImport.check.summary.pieces,nq:prodImport.check.summary.noQty}');
const expectPieces = kurta.reduce((a, l) => a + (+l.split(',')[5] || 0), 0) + shirt.length * 3 + items.reduce((a, l) => a + (+l.split(',')[5] || 0), 0) + 2 + 2;
check(`corrected: everything ready — ${plan.p} new products, ${plan.v} rows, ${expectPieces} pieces counted`, plan.ok && plan.p === 1 + 1 + 150 + 3 && plan.v === 48 + 25 + 150 + 3 && plan.pieces === expectPieces, { plan, expectPieces });
await A.$eval('#impGo', (b) => b.click()); await sleep(400);
const toastTxt = await A.evaluate(() => (document.querySelector('.toast') || {}).textContent || '');
check('Import: the message counts what was added and names the variants with no stock yet', /Imported 155 products \(226 variants, .* in stock\)\. \d+ variants have no stock yet: count them in Stock\./.test(toastTxt), toastTxt);
await run('await flushSbQueue()');
await until('true', 1000);
const db = {
  products: (await q1('SELECT count(*)::int n FROM public.hangtag_products'))[0].n,
  variants: (await q1('SELECT count(*)::int n FROM public.hangtag_variants'))[0].n,
  opening: +(await q1(`SELECT COALESCE(sum(qty),0)::float q FROM public.hangtag_stock_moves WHERE type = 'OPENING'`))[0].q,
  socks: (await q1(`SELECT count(*)::int n FROM public.hangtag_variants v JOIN public.hangtag_products p ON p.id = v.product_id WHERE p.name = 'Socks'`))[0].n,
  noMove: (await q1(`SELECT count(*)::int n FROM public.hangtag_variants v WHERE NOT EXISTS (SELECT 1 FROM public.hangtag_stock_moves m WHERE m.variant_id = v.id)`))[0].n,
};
const noQtyRows = kurta.filter((l) => l.split(',')[5] === '').length + items.filter((l) => ['', '0'].includes(l.split(',')[5])).length + 1;
check('the cloud matches the preview: 156 products (Socks + 155), 227 variants, opening stock = Socks\' 4 + the counted pieces only', db.products === 156 && db.variants === 227 && db.opening === 4 + expectPieces, db);
check('…the shop\'s Socks unchanged (one variant: none of the file\'s Socks rows reached it)', db.socks === 1, db.socks);
check('…and every row with no quantity (or 0) has no stock record: nothing was made up', db.noMove === noQtyRows, { noMove: db.noMove, expected: noQtyRows });
await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
