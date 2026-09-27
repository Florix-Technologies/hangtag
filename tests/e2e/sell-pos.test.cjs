// Phone-first Sell: search → select → variant → quantity → add → review the bill (this device; the cloud is blocked).
// Run: npm run test:e2e
const H = require('../helpers/env.cjs');
const puppeteer = require('puppeteer-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 400) : '')); };
(async () => {
  await H.ensureServer();
  const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
  const p = await browser.newPage(); await p.setViewport({ width: 1280, height: 900 });
  p.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
  await p.setRequestInterception(true);
  p.on('request', (r) => { const u = r.url(); if (u === 'http://localhost:3210/') r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }); else if (u.includes('supabase.co')) r.abort(); else r.continue(); });
  await p.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' }); await sleep(800);
  const run = (b) => p.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
  const init = () => run('hideGate();hideSetup();authUser=null;sbStatus="disconnected";renderAll();');
  await init();
  // a simple product and a Colour × Size product with its own prices, SKU and barcode, all in stock
  const ids = await run(`catalog={version:3,example:false,products:[]};moves={};cart=[];saveCatalog();saveMoves();saveCart();
    openEditor(null);editor.name="Water Bottle";editor.price="349";editor.hasOpts=false;edCombos()[0].cell.sku="WB-1";edCombos()[0].cell.stock="10";saveEditor();
    openEditor(null);editor.name="Dress";editor.price="999";edToggleOptions(true);edAddOption("Colour");edAddValues(0,["Black","White"]);edAddOption("Size");edAddValues(1,["M","L"]);
    const c=edCombos();c.forEach(x=>x.cell.stock="5");c[1].cell.price="1099";c[1].cell.sku="DR-BLK-L";editor.codesOn=true;c[2].cell.bc="2000000000015";saveEditor();
    const d=products().find(p=>p.name==="Dress"),w=products().find(p=>p.name==="Water Bottle");
    setTab("sell");renderAll();
    return {wb:w.id,wv:w.variants[0].id,dr:d.id,bl:d.variants[1].id,wm:d.variants[2].id}`);
  const cart = () => run('return cart.map(c=>({v:c.v,n:c.name,vl:c.vl,q:c.q,price:c.price,sku:c.sku}))');

  // ---------- simple product: select → quantity → add ----------
  await p.click(`.tile[data-pid="${ids.wb}"]`); await sleep(200);
  const qs = await p.$eval('#sheetHost .qsheet', (e) => ({ price: e.querySelector('.qs-price').textContent, left: e.querySelector('.qs-left').textContent, q: e.querySelector('[data-cellqty]').value })).catch(() => null);
  check('simple product: one tap shows price, stock and quantity 1 ready (no variant step)', qs && qs.price === '₹349' && qs.left === '9 left' && qs.q === '1', qs);
  await p.click('#sheetHost .qs-step [data-cellplus]'); await p.click('#sheetHost .qs-step [data-cellplus]'); await sleep(100);
  check('the stepper counts up (3) and the footer shows pieces and amount', /3 pieces/.test(await p.$eval('#pickSum', (e) => e.textContent)) && (await p.$eval('#sheetHost [data-cellqty]', (e) => e.value)) === '3');
  await p.click('#addPickBtn'); await sleep(200);
  let c = await cart();
  check('added to the bill: Water Bottle × 3 at ₹349', c.length === 1 && c[0].v === ids.wv && c[0].q === 3 && c[0].price === 349, c);

  // ---------- variant product: variants with option values and their own prices ----------
  await p.click(`.tile[data-pid="${ids.dr}"]`); await sleep(250);
  const cells = await p.$$eval('#sheetHost .vc', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ')));
  check('variant product: every variant shows its price (Black / L ₹1,099)', cells.length === 4 && cells.some((t) => /L.*₹1,099/.test(t)) && cells.filter((t) => /₹999/.test(t)).length === 3, cells);
  await p.click(`[data-cellplus="${ids.bl}"]`); await sleep(100);
  const sum = await p.$eval('#pickSum', (e) => e.textContent);
  check('the chosen variant is named with its options and price', /Black \/ L · ₹1,099 each/.test(sum), sum);
  await p.click('#addPickBtn'); await sleep(200);
  c = await cart();
  check('added: Dress Black / L at its own price ₹1,099 with its SKU', c.length === 2 && c[1].v === ids.bl && c[1].price === 1099 && c[1].vl === 'Black / L' && c[1].sku === 'DR-BLK-L', c);

  // ---------- search by SKU and barcode (exact variant) ----------
  await p.click('#sellSearch'); await p.type('#sellSearch', 'dr-blk-l'); await sleep(250);
  const hits = await p.$$eval('#sellHits .hit-row', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ')));
  check('SKU search (any case) shows exactly that variant', hits.length === 1 && /Dress/.test(hits[0]) && /Black \/ L/.test(hits[0]) && /₹1,099/.test(hits[0]), hits);
  await p.click('#sellHits [data-addv]'); await sleep(200);
  c = await cart();
  check('adding from the SKU result: Black / L now 2', c[1].q === 2 && c.length === 2, c);
  await p.click('#sellSearch', { count: 3 }); await p.type('#sellSearch', '2000000000015'); await p.keyboard.press('Enter'); await sleep(250);
  c = await cart();
  check('barcode search + Enter adds the exact variant (White / M)', c.length === 3 && c[2].v === ids.wm && c[2].vl === 'White / M', c);
  await p.click('#sellSearch', { count: 3 }); await p.keyboard.press('Backspace'); await sleep(150);
  const byName = await run('sellQuery="water";return sellProducts().map(p=>p.name)');
  check('name search still finds products', JSON.stringify(byName) === '["Water Bottle"]');
  await run('sellQuery="";renderAll()'); await sleep(150);

  // ---------- the bill (desktop panel): lines, quantities, remove ----------
  const lines = await p.$$eval('#billPanel .li', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ')));
  check('bill shows product, options, SKU, unit price and line total for each line', lines.length === 3 && /Water Bottle/.test(lines[0]) && /SKU WB-1/.test(lines[0]) && /₹349 each/.test(lines[0]) && /₹1,047/.test(lines[0])
    && /Black \/ L/.test(lines[1]) && /SKU DR-BLK-L/.test(lines[1]) && /₹1,099 each/.test(lines[1]) && /₹2,198/.test(lines[1]), lines);
  await p.screenshot({ path: H.ARTIFACTS + '/sp1_desktop.png' });
  await p.click('#billPanel [data-inc="0"]'); await sleep(120);
  check('+ adds a piece', (await cart())[0].q === 4);
  await p.click('#billPanel [data-dec="0"]'); await p.click('#billPanel [data-dec="0"]'); await sleep(120);
  check('− takes pieces off', (await cart())[0].q === 2);
  const typeQty = async (i, v) => { await p.click(`#billPanel [data-lineqty="${i}"]`, { count: 3 }); await p.type(`#billPanel [data-lineqty="${i}"]`, v); await p.keyboard.press('Tab'); await sleep(200); };
  await typeQty(0, '6');
  check('typing a quantity changes it (6)', (await cart())[0].q === 6);
  await typeQty(0, '0');
  check('0 is refused (quantity unchanged, reason shown)', (await cart())[0].q === 6 && /1 or more/.test(await p.$eval('.toast', (e) => e.textContent).catch(() => '')));
  await typeQty(0, '2.5');
  check('a decimal is refused', (await cart())[0].q === 6);
  await typeQty(1, '99');
  check('more than the stock is capped to the stock (5) with the reason', (await cart())[1].q === 5 && /Only 5 in stock/.test(await p.$eval('.toast', (e) => e.textContent).catch(() => '')));
  check('+ is off when no more are in stock', await p.$eval('#billPanel [data-inc="1"]', (e) => e.disabled));
  await p.click('#billPanel [data-rmline="2"]'); await sleep(150);
  c = await cart();
  check('Remove takes the line off the bill', c.length === 2 && !c.some((x) => x.v === ids.wm), c);
  check('stock is untouched until the bill is paid (ledger unchanged)', await run(`return stockOf(${JSON.stringify(ids.bl)})===5&&availOf(${JSON.stringify(ids.bl)})===0`));
  check('multiple products in one bill, total = sum of lines', /₹7,589/.test(await p.$eval('#billPanel [data-grand]', (e) => e.textContent)));   // 6 × 349 + 5 × 1,099

  // ---------- account isolation on a shared phone ----------
  const iso = await run('storage.set(DATA_OWNER,"user-a");saveCatalog();saveCart();switchLocalDataTo("user-b");loadUserState();const b=cart.length;switchLocalDataTo("user-a");loadUserState();return {b,a:cart.length}');
  check("another account on this device doesn't see this bill", iso.b === 0 && iso.a === 2, iso);

  // ---------- phone ----------
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(1000);   // (reloads the page)
  await init(); await run('setTab("sell");renderAll()'); await sleep(300);
  check('phone: the bill bar shows pieces and total (6 + 5 = 11 pieces)', /11 pieces/.test(await p.$eval('#billBar', (e) => e.textContent)) && /₹7,589/.test(await p.$eval('#billBar', (e) => e.textContent)));
  const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: the Sell page fits the width', over <= 1, over);
  await p.screenshot({ path: H.ARTIFACTS + '/sp2_phone_sell.png' });
  await p.tap(`.tile[data-pid="${ids.wb}"]`); await sleep(300);
  const big = await p.$$eval('#sheetHost .qs-step button', (x) => x.map((b) => Math.round(b.getBoundingClientRect().height)));
  check('phone: quantity buttons are large touch targets (≥ 44 px)', big.length === 2 && big.every((h) => h >= 44), big);
  await p.screenshot({ path: H.ARTIFACTS + '/sp3_phone_qty.png' });
  await p.tap('#addPickBtn'); await sleep(200);
  check('phone: select → add in two taps (Water Bottle now 7)', (await cart())[0].q === 7);
  await p.tap('#billBar [data-act="openbill"]'); await sleep(300);
  const sheet = await p.$$eval('#sheetHost .li', (x) => x.length);
  const btn = await p.$eval('#sheetHost .step button', (b) => Math.round(b.getBoundingClientRect().height));
  check('phone: the bill opens as a sheet with the lines; stepper buttons ≥ 44 px', sheet === 2 && btn >= 44, { sheet, btn });
  await p.tap('#sheetHost [data-rmline="1"]'); await sleep(200);
  check('phone: Remove works in the bill sheet', (await cart()).length === 1 && (await p.$$('#sheetHost .li')).length === 1);
  const over2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: the bill sheet fits the width', over2 <= 1, over2);
  await p.screenshot({ path: H.ARTIFACTS + '/sp4_phone_bill.png' });

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
