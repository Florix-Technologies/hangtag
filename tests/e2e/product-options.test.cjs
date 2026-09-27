// Product options, variants, SKU, barcode/QR, stickers and scanning, in Chrome (this device only; the cloud is blocked).
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
  p.on('dialog', (d) => d.accept());
  await p.setRequestInterception(true);
  p.on('request', (r) => { const u = r.url(); if (u === 'http://localhost:3210/') r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }); else if (u.includes('supabase.co')) r.abort(); else r.continue(); });
  await p.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' }); await sleep(800);
  const run = (b) => p.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
  await run('hideGate();hideSetup();authUser=null;sbStatus="disconnected";catalog={version:3,example:false,products:[]};saveCatalog();setTab("products");renderAll();');
  const type = async (sel, v) => { await p.click(sel, { count: 3 }); await p.type(sel, v); };
  const err = () => p.$eval('#edErr', (e) => e.hidden ? '' : e.textContent).catch(() => '');

  // ---------- simple product (no variants) ----------
  await p.click('.ptools [data-act="addp"]'); await sleep(200);
  check('new product: "multiple options / variants" is unticked, no option UI', !(await p.$eval('[data-edtoggle="hasOpts"]', (e) => e.checked)) && !(await p.$('[data-valadd]')) && !(await p.$('.vdet')));
  await type('#edName', 'Water Bottle'); await type('[data-ed="price"]', '349'); await type('[data-ed="cost"]', '150');
  await type('[data-ed="hsn"]', '3924'); await type('[data-ed="gst"]', '18');
  await type('[data-edf="sku"]', 'WB-1'); await type('[data-edf="stock"]', '12');
  await p.click('[data-act="edsave"]'); await sleep(300);
  const wb = await run('const p=products().find(x=>x.name==="Water Bottle");return {opts:p.opts.length,n:p.variants.length,sku:p.variants[0].sku,o:p.variants[0].o.length,hsn:p.hsn,gst:p.gst,stock:stockOf(p.variants[0].id)}');
  check('simple product: no options, one variant with the product-level SKU, HSN/GST kept, stock 12', wb.opts === 0 && wb.n === 1 && wb.sku === 'WB-1' && wb.o === 0 && wb.hsn === '3924' && wb.gst === 18 && wb.stock === 12, wb);

  // ---------- one option (typed in the UI), variant prices ----------
  await p.click('.ptools [data-act="addp"]'); await sleep(200);
  await type('#edName', 'Phone'); await type('[data-ed="price"]', '15999'); await type('[data-ed="cost"]', '12000');
  await p.click('[data-edtoggle="hasOpts"]'); await sleep(150);
  await p.click('[data-optsugg="Storage"]'); await sleep(150);
  for (const v of ['64 GB', '128 GB', '256 GB']) { await p.type('[data-valadd="0"]', v); await p.keyboard.press('Enter'); await sleep(80); }
  check('one option "Storage" → 3 variant rows generated', (await p.$$('.vdet tbody tr')).length === 3);
  const rows = await p.$$('.vdet tbody tr');
  await (await rows[1].$('[data-edf="price"]')).type('17999'); await (await rows[2].$('[data-edf="price"]')).type('19999');
  await (await rows[2].$('[data-edf="cost"]')).type('15500');
  await p.click('[data-edact="edsku"]'); await sleep(150);
  const skus = await p.$$eval('.vdet [data-edf="sku"]', (x) => x.map((e) => e.value));
  check('auto SKUs from the product and value codes', JSON.stringify(skus) === '["PH-64GB","PH-128GB","PH-256GB"]', skus);
  await p.click('[data-act="edsave"]'); await sleep(300);
  const ph = await run('const p=products().find(x=>x.name==="Phone");return {opts:p.opts,v:p.variants.map(v=>[v.o.join("/"),vPrice(p,v),vCost(p,v)])}');
  check('variant-specific prices and costs (empty = product default)', JSON.stringify(ph.v) === '[["64 GB",15999,12000],["128 GB",17999,12000],["256 GB",19999,15500]]', ph);

  // ---------- 10 × 10, table, deactivate, codes ----------
  await p.click('.ptools [data-act="addp"]'); await sleep(200);
  await run(`editor.name="Dress";editor.price="999";editor.cost="600";edToggleOptions(true);edAddOption("Colour");edAddValues(0,${JSON.stringify(Array.from({ length: 10 }, (_, i) => 'C' + (i + 1)))});edAddOption("Size");edAddValues(1,["XS","S","M","L","XL","XXL","3XL","4XL","5XL","Free size"]);`);
  check('10 colours × 10 sizes = 100 variant rows', (await p.$$('.vdet tbody tr')).length === 100);
  await p.screenshot({ path: H.ARTIFACTS + '/po1_editor_100.png' });
  await p.click('[data-edtoggle="codesOn"]'); await sleep(150);
  check('"Enable barcode / QR code" shows the code type choice (Barcode / QR Code)', (await p.$$('[data-edcode]')).length === 2 && (await p.$$('.vdet [data-edf="bc"]')).length === 100);
  await p.click('[data-edact="gencodes"]'); await sleep(400);
  const codes = await run('return edCombos().map(x=>[x.cell.bc,isValidEan13(x.cell.bc)])');
  check('generated codes: valid in-store EAN-13, all different', codes.length === 100 && new Set(codes.map((c) => c[0])).size === 100 && codes.every(([c, ok]) => /^20\d{11}$/.test(c) && ok));
  check('barcode previews are vector SVG', (await p.$$('.codeprev svg')).length >= 100);
  const first = (await p.$$('.vdet tbody tr'))[0];
  await (await first.$('[data-edf="active"]')).click(); await sleep(80);
  await p.click('[data-edact="edsku"]'); await sleep(200);
  await p.click('[data-act="edsave"]'); await sleep(400);
  const dr = await run('const p=products().find(x=>x.name==="Dress");return {n:p.variants.length,active:p.variants.filter(v=>v.active).length,first:p.variants[0].active,code:p.code,bc:p.variants[5].bc}');
  check('saved: 100 variants, one switched off (deactivated), codes stored against each variant', dr.n === 100 && dr.active === 99 && dr.first === false && dr.code === 'barcode' && /^20/.test(dr.bc), dr);

  // ---------- uniqueness ----------
  await run('openEditor(products().find(x=>x.name==="Phone").id)'); await sleep(150);
  await type('.vdet tbody tr:nth-child(1) [data-edf="sku"]', 'wb-1'); await p.click('[data-act="edsave"]'); await sleep(200);
  check('duplicate SKU in the shop is refused (any case)', /SKU wb-1 is already used by Water Bottle/.test(await err()), await err());
  await type('.vdet tbody tr:nth-child(1) [data-edf="sku"]', 'PH-64GB');
  await p.click('[data-edtoggle="codesOn"]'); await sleep(150);
  const dressCode = await run('return products().find(x=>x.name==="Dress").variants[5].bc');
  await type('.vdet tbody tr:nth-child(2) [data-edf="bc"]', dressCode); await p.click('[data-act="edsave"]'); await sleep(200);
  check('duplicate barcode in the shop is refused', new RegExp('Barcode ' + dressCode + ' is already used by Dress').test(await err()), await err());
  await type('.vdet tbody tr:nth-child(2) [data-edf="bc"]', '4006381333932'); await p.click('[data-act="edsave"]'); await sleep(200);
  check('a mistyped EAN-13 check digit is caught', /isn't a valid EAN-13/.test(await err()), await err());
  // QR code for the phone
  await type('.vdet tbody tr:nth-child(2) [data-edf="bc"]', '');
  await p.click('[data-edcode][value="qr"]'); await sleep(150);
  await p.click('.vdet tbody tr:nth-child(2) [data-edgen]'); await sleep(200);
  check('QR code type: generated code previewed as a QR (square SVG)', /QR code/.test(await p.$eval('.vdet tbody tr:nth-child(2) .codeprev', (e) => e.innerHTML)));
  await p.click('[data-act="edsave"]'); await sleep(300);
  const q = await run('const p=products().find(x=>x.name==="Phone");return {code:p.code,bc:p.variants[1].bc}');
  check('QR code stored against the 128 GB variant', q.code === 'qr' && /^20\d{11}$/.test(q.bc), q);

  // ---------- scan / search ----------
  await run('setTab("sell");cart=[];saveCart();renderAll()'); await sleep(200);
  const target = await run('const p=products().find(x=>x.name==="Dress");const v=p.variants[57];moves["s57"]={id:"s57",v:v.id,p:p.id,type:"RESTOCK",q:3,cost:null,note:"",t:Date.now(),dev:dev};saveMoves();invalidate();return {id:v.id,bc:v.bc,label:v.o.join(" / ")}');   // in stock, so it can be sold
  await p.focus('body'); await p.keyboard.type(target.bc, { delay: 5 }); await p.keyboard.press('Enter'); await sleep(300);
  const line = await run('return cart.map(c=>({v:c.v,vl:c.vl,q:c.q}))');
  check('scanning a barcode adds that exact variant (not just the product)', line.length === 1 && line[0].v === target.id && line[0].vl === target.label, { line, target });
  const hits = await run('sellQuery="PH-128GB";return variantHits().map(h=>h.p.name+" "+h.v.o.join("/"))');
  check('search by SKU finds the exact variant', JSON.stringify(hits) === '["Phone 128 GB"]', hits);
  const byName = await run('sellQuery="water";return sellProducts().map(p=>p.name)');
  check('search by product name still works', JSON.stringify(byName) === '["Water Bottle"]');
  const byCode = await run(`return findByCode(${JSON.stringify(q.bc)}).v.o.join("/")`);
  check('a QR code text resolves the exact variant too', byCode === '128 GB');
  await run('sellQuery="";cart=[];saveCart();renderAll()');

  // ---------- stickers ----------
  await run('setTab("products")'); await sleep(200);
  await p.click(`[data-stickers="${await run('return products().find(x=>x.name==="Dress").id')}"]`); await sleep(300);
  check('Stickers from the product card: preview of every variant on sale', /99 different stickers/.test(await p.$eval('#stkT', (e) => e.parentNode.textContent)) && (await p.$$('.stk-prev svg')).length >= 6);
  const svg = await run('return stickerSVG({p:products().find(x=>x.name==="Dress"),v:products().find(x=>x.name==="Dress").variants[1]},STICKER_SIZES[0],{name:true,variant:true,price:true,sku:true,code:true})');
  check('sticker SVG: 50 × 25 mm, product, variant, price, SKU and the barcode', /width="50mm" height="25mm"/.test(svg) && />Dress</.test(svg) && /C1 \/ S/.test(svg) && /₹999/.test(svg) && /SKU DR-C1-S/.test(svg) && /<path fill="#000" d="M/.test(svg), svg.slice(0, 300));
  await p.select('[data-stksize]', 'a4'); await sleep(150);
  await p.$eval('[data-stkcopies]', (e) => { e.value = '2'; e.dispatchEvent(new Event('change', { bubbles: true })); }); await sleep(150);
  await p.screenshot({ path: H.ARTIFACTS + '/po2_stickers.png' });
  await p.click('[data-stkact="print"]'); await sleep(500);
  const printed = await p.evaluate(() => { const f = [...document.querySelectorAll('iframe')].pop(); return f ? { n: f.contentDocument.querySelectorAll('svg[width="70mm"]').length, page: /size:A4/.test(f.contentDocument.querySelector('style').textContent) } : null; });
  check('Print: A4 sheet with every sticker × 2 copies through the browser print dialog', printed && printed.n === 198 && printed.page, printed);
  await run('closeModal()');
  await run(`openEditor(products().find(x=>x.name==="Phone").id)`); await sleep(150);
  await p.click('.vdet tbody tr:nth-child(2) [data-edsel]'); await sleep(100);   // 128 GB: the variant with a QR code
  await p.click('[data-edact="printsel"]'); await sleep(300);
  check('editor: "Print selected" saves and prints just the ticked variant (QR)', /Print stickers · Phone/.test(await p.$eval('#stkT', (e) => e.textContent)) && (await p.$$('.stk-prev > svg')).length === 1 && (await p.$eval('.stk-prev', (e) => { const inner = e.querySelector('svg svg'); const vb = inner && inner.getAttribute('viewBox').split(' '); return !!inner && vb[2] === vb[3] && inner.getAttribute('width') === inner.getAttribute('height'); })));   // a square code: the QR
  await run('closeModal()');
  await run('openEditor(products().find(x=>x.name==="Water Bottle").id)'); await sleep(150);
  check('simple product: "Print sticker"; multi-variant: "Print selected" + "Print all variants"', !!(await p.$('[data-edact="print1"]')) && !(await p.$('[data-edact="printall"]')));
  await run('closeModal();editor=null');

  // ---------- options: rename in place, remove with history, regenerate safely ----------
  await run(`const p=products().find(x=>x.name==="Phone");moves["t1"]={id:"t1",v:p.variants[0].id,p:p.id,type:"RESTOCK",q:5,cost:null,note:"",t:Date.now(),dev:dev};saveMoves();invalidate();openEditor(p.id);`); await sleep(150);
  const id64 = await run('return edCombos()[0].cell.id');
  await run('edRenameValue(0,0,"64GB")'); await sleep(100);
  check('rename a value: same variant (id, stock) keeps its row', await run(`return edCombos()[0].cell.id===${JSON.stringify(id64)}&&edCombos()[0].o[0]==="64GB"&&edCombos()[0].cell.stock==="5"`));
  await run('edRemoveValue(0,0)'); await sleep(100);
  await run('saveEditor()'); await sleep(200);
  const kept = await run(`const p=products().find(x=>x.name==="Phone");const v=p.variants.find(v=>v.id===${JSON.stringify(id64)});return {active:v.active,o:v.o,stock:stockOf(v.id),opts:p.opts[0].v}`);
  check('removing a value with stock history keeps the variant off sale with stock 0 (history kept)', kept.active === false && kept.o[0] === '64GB' && kept.stock === 0 && JSON.stringify(kept.opts) === '["128 GB","256 GB"]', kept);
  await run('openEditor(products().find(x=>x.name==="Phone").id);edAddValues(0,"64GB")'); await sleep(100);
  check('adding the value back revives the same variant', await run(`return edCombos().find(x=>x.o[0]==="64GB").cell.id===${JSON.stringify(id64)}`));
  await run('closeModal();editor=null');

  // ---------- phone layout ----------
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(1000);   // (reloads the page)
  await run('hideGate();hideSetup();authUser=null;sbStatus="disconnected";renderAll();'); await sleep(200);
  await run('openEditor(products().find(x=>x.name==="Dress").id)'); await sleep(400);
  check('phone: the product editor is open', !!(await p.$('.sheet.editor .vdet')));
  const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('phone: the editor fits the screen width (the variants table scrolls inside itself)', ov <= 1, ov);
  await p.screenshot({ path: H.ARTIFACTS + '/po3_editor_phone.png' });
  await run('closeModal();editor=null;setTab("stock")'); await sleep(300);
  await p.screenshot({ path: H.ARTIFACTS + '/po4_stock_phone.png' });
  check('phone: stock page grid shows option names as headers', /Colour/.test(await p.$eval('#stockBody', (e) => e.textContent)));

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
