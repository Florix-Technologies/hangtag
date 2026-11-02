// Sell → Scan with the camera, in Chrome. The camera is Chrome's fake device playing a generated video of a real barcode,
// so opening the camera, decoding and adding to the bill all run for real; other cases use a stand-in scanner (the
// "barcodeScanner" port) or a browser whose camera is refused / missing. The cloud is blocked (this device only).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import H from '../helpers/env.mjs';
import { barcodeSVG } from '../../src/infrastructure/codes/barcode-svg.js';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 400) : '')); };
const BM = '2000000000015', WB = '2000000000022', WL = '2000000000039';

// ---------- a camera video (Y4M) showing the Black / M barcode ----------
function y4m(code, file) {
  const svg = barcodeSVG(code), W = +/viewBox="0 0 (\d+) /.exec(svg)[1], bits = new Array(W).fill(0);
  for (const m of svg.matchAll(/M(\d+) 0h(\d+)/g)) for (let x = +m[1]; x < +m[1] + +m[2]; x++) bits[x] = 1;
  const w = 640, h = 480, S = 3, x0 = Math.round((w - W * S) / 2), y0 = 140, bh = 200;
  const Y = Buffer.alloc(w * h, 235), UV = Buffer.alloc((w / 2) * (h / 2) * 2, 128);
  for (let y = y0; y < y0 + bh; y++) for (let x = 0; x < W * S; x++) if (bits[Math.floor(x / S)]) Y[y * w + x0 + x] = 16;
  const frames = []; for (let i = 0; i < 10; i++) frames.push(Buffer.from('FRAME\n'), Y, UV);
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
}
const VIDEO = H.ARTIFACTS + '/camera-black-m.y4m';
y4m(BM, VIDEO);

async function openApp(browser, { before } = {}) {
  const p = await browser.newPage(); await p.setViewport({ width: 1280, height: 900 });
  p.on('pageerror', (e) => { fails++; console.log('[pageerror]', e.message); });
  p.on('dialog', (d) => { console.log('[dialog]', d.message()); d.accept(); });
  await p.setRequestInterception(true);
  p.on('request', (r) => { const u = r.url(); if (u === 'http://localhost:3210/') r.respond({ status: 200, contentType: 'text/html', body: H.hookedHtml() }); else if (u.includes('supabase.co')) r.abort(); else r.continue(); });
  if (before) await p.evaluateOnNewDocument(before);
  await p.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' }); await sleep(800);
  const run = (b) => p.evaluate((b) => __ev('(async()=>{' + b + '})()'), b);
  await run(`hideGate();hideSetup();authUser=null;sbStatus="disconnected";catalog={version:3,example:false,products:[]};moves={};cart=[];saveCatalog();saveMoves();saveCart();
    openEditor(null);editor.name="Water Bottle";editor.price="349";editor.codesOn=true;edCombos()[0].cell.bc="${WB}";edCombos()[0].cell.stock="3";saveEditor();
    openEditor(null);editor.name="Dress";editor.price="999";edToggleOptions(true);edAddOption("Colour");edAddValues(0,["Black","White"]);edAddOption("Size");edAddValues(1,["M","L"]);
    editor.codesOn=true;const c=edCombos();c[0].cell.bc="${BM}";c[0].cell.stock="5";c[3].cell.bc="${WL}";c[3].cell.stock="1";c[1].cell.stock="2";c[2].cell.stock="2";saveEditor();
    setTab("sell");renderAll();`);
  return { p, run };
}
const until = async (run, cond, ms = 12000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await run('return !!(' + cond + ')').catch(() => false)) return true; await sleep(100); } return false; };
const lines = (run) => run('return cart.map(c=>c.name+(c.vl?" "+c.vl:"")+" x"+c.q)');
const status = (p) => p.$eval('#scanStatus', (e) => e.textContent).catch(() => '');

// ---------- 1. real camera: open, read, exact variant, no double count ----------
const cam = await puppeteer.launch({ executablePath: H.CHROME, headless: true, protocolTimeout: 20000,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${VIDEO}`] });
const A = await openApp(cam);
check('Sell has a clear Scan button', /Scan/.test(await A.p.$eval('.sell-header [data-act="scan"]', (e) => e.textContent)));
await A.p.click('.sell-header [data-act="scan"]');
check('the scanner opens with the camera picture', await until(A.run, 'scan&&scan.status==="live"') && await A.p.$eval('#scanVideo', (v) => v.videoWidth > 0 && !!v.srcObject));
check('a barcode seen by the camera puts that exact variant on the bill', await until(A.run, 'cart.length===1'), await lines(A.run));
check('…Dress · Black / M, not just the product', JSON.stringify(await lines(A.run)) === '["Dress Black / M x1"]' && /Added Dress · Black \/ M/.test(await status(A.p)), [await lines(A.run), await status(A.p)]);
await A.p.screenshot({ path: H.ARTIFACTS + '/cs1_camera.png' });
await sleep(3000);
check('the same sticker left in view is not added again (duplicate scan protection)', JSON.stringify(await lines(A.run)) === '["Dress Black / M x1"]', await lines(A.run));
await A.p.click('#scanHost [data-scan="close"]'); await sleep(300);
check('× closes the scanner, releases the camera, back to Sell', !(await A.p.$('#scanHost')) && await A.run('return scan===null&&prefs.tab==="sell"'));

// ---------- 2. stand-in scanner: product rules ----------
await A.run('window.__undo=override({barcodeScanner:{available:()=>true,async start(v,h){window.__emit=h.onCode;return {native:true}},stop(){}}})');
const emit = async (code) => { await A.run(`__emit(${JSON.stringify(code)})`); await sleep(120); };
await A.p.click('.sell-header [data-act="scan"]'); await until(A.run, 'scan&&scan.status==="live"');
await emit(WB);
check('a simple product barcode adds it (Water Bottle x1)', (await lines(A.run)).includes('Water Bottle x1') && /Added Water Bottle/.test(await status(A.p)));
await emit('9999999999994');
check('an unknown barcode says "Product not found" and adds nothing', /Product not found/.test(await status(A.p)) && (await lines(A.run)).length === 2);
check('…and no product is created', await A.run('return products().length===2'));
await emit(BM);
check('scanning a variant already on the bill adds one more (existing cart rules)', (await lines(A.run)).includes('Dress Black / M x2') && /2 on the bill/.test(await status(A.p)));
await emit(BM);
check('the same code again at once is ignored (rapid repeat)', (await lines(A.run)).includes('Dress Black / M x2'));
await emit(WL); await emit(WB); await emit(WL);
check('stock limit: White / L has 1 piece; a second scan is refused with the reason', (await lines(A.run)).includes('Dress White / L x1') && /All 1 in stock are already on the bill/.test(await status(A.p)), [await lines(A.run), await status(A.p)]);
await emit('bad\u0001code');
check('an invalid code is refused plainly', /can't belong to a product/.test(await status(A.p)));
check('the scanner footer shows the bill so far', /pieces/.test(await A.p.$eval('#scanBill', (e) => e.textContent)));
await A.p.click('#scanHost [data-scan="close"]'); await sleep(150);
await A.run('SCAN_CONFIG.hintMs=300'); await A.p.click('.sell-header [data-act="scan"]'); await sleep(900);
check('no barcode for a while → tips for a better read', /No barcode found yet/.test(await status(A.p)));
// shop isolation: another account on this phone has none of these products
const iso = await A.run(`storage.set(DATA_OWNER,"user-a");saveCatalog();saveCart();switchLocalDataTo("user-b");loadUserState();__emit("${WL}");const b=scan.last.status;
  closeScanner();switchLocalDataTo("user-a");loadUserState();return {b,a:products().length}`);
check("another account's scan can't find this shop's barcodes", iso.b === 'not-found' && iso.a === 2, iso);
await A.run('__undo()');
await cam.close();

// ---------- 3. camera refused / missing ----------
const plain = await puppeteer.launch({ executablePath: H.CHROME, headless: true, protocolTimeout: 20000 });
const B = await openApp(plain, { before: () => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); } });
await B.p.click('.sell-header [data-act="scan"]'); await sleep(500);
check('permission denied → a plain message, no retry loop, "Type the code instead"', /Camera permission was denied/.test(await status(B.p)) && !(await B.p.$('[data-scan="retry"]')) && !!(await B.p.$('#scanStatus [data-scan="type"]')));
await B.p.click('#scanStatus [data-scan="type"]'); await sleep(200);
check('"Type the code instead" closes the scanner and puts the cursor in the search box', !(await B.p.$('#scanHost')) && await B.p.evaluate(() => document.activeElement && document.activeElement.id === 'sellSearch'));
const Cc = await openApp(plain, { before: () => { Object.defineProperty(navigator, 'mediaDevices', { value: undefined }); } });
await Cc.p.click('.sell-header [data-act="scan"]'); await sleep(400);
check('no camera on the device → says so', /can't use a camera|No camera/.test(await status(Cc.p)), await status(Cc.p));

// ---------- 4. phone layout ----------
await Cc.p.close(); await B.p.bringToFront();
await B.p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(1000);   // (reloads the page)
await B.run('hideGate();hideSetup();authUser=null;sbStatus="disconnected";setTab("sell");renderAll();override({barcodeScanner:{available:()=>true,async start(){return {native:true}},stop(){}}})');
const scanBtn = await B.p.$eval('.sell-header [data-act="scan"]', (e) => Math.round(e.getBoundingClientRect().height));
await B.p.tap('.sell-header [data-act="scan"]'); await sleep(300);
const box = await B.p.$eval('#scanHost', (e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(document.querySelector('.scan-x').getBoundingClientRect().height) }; });
check('phone: Scan button and close button are big touch targets', scanBtn >= 44 && box.x >= 44, { scanBtn, box });
check('phone: the scanner fills the screen', box.w === 390 && box.h === 844, box);
await B.p.screenshot({ path: H.ARTIFACTS + '/cs2_phone.png' });
await B.p.keyboard.press('Escape'); await sleep(200);
check('Escape closes the scanner too', !(await B.p.$('#scanHost')));
await plain.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
