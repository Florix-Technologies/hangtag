// Customers: add / edit / search on the Customers page, pick / add / skip a customer while selling, and purchase
// history from completed bills. Desktop and phone. This device only (the cloud is blocked). Run: npm run test:e2e
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
  const init = () => run('hideGate();hideSetup();authUser=null;sbStatus="disconnected";renderAll();');
  await init();
  const ids = await run(`catalog={version:3,example:false,products:[]};moves={};cart=[];customers={};localDays={};remoteDays={};saveCatalog();saveMoves();saveCart();saveCustomers();
    openEditor(null);editor.name="Tee";editor.price="500";edCombos()[0].cell.stock="30";saveEditor();
    openEditor(null);editor.name="Dress";editor.price="999";edToggleOptions(true);edAddOption("Size");edAddValues(0,["M","L"]);edCombos().forEach(x=>x.cell.stock="10");saveEditor();
    const t=products().find(p=>p.name==="Tee"),d=products().find(p=>p.name==="Dress");return {tee:t.variants[0].id,dm:d.variants[0].id}`);
  const typeIn = async (sel, v) => { await p.click(sel, { count: 3 }); await p.type(sel, v); };
  const text = (sel) => p.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ')).catch(() => '');
  const listNames = () => p.$$eval('#custList .cc-main b', (x) => x.map((e) => e.firstChild.textContent));

  // ---------- Customers page: create, business type, duplicates ----------
  await p.click('.nav [data-tab="customers"]'); await sleep(250);
  check('Customers tab and page', /No customers yet/.test(await text('#custList')));
  await p.click('[data-act="custadd"]'); await sleep(150);
  check('new customer form: Individual is the default type', await p.$eval('#custForm [name=type][value=individual]', (e) => e.checked));
  await typeIn('#custForm [name=name]', 'Meera Shah'); await typeIn('#custForm [name=phone]', '98765 43210'); await typeIn('#custForm [name=email]', 'meera@mail.com');
  await p.click('#custForm [type=submit]'); await sleep(250);
  check('create customer: saved, profile opens', /Meera Shah/.test(await text('.custsheet h3')) && /No completed bills yet/.test(await text('.custsheet')));
  await p.click('[data-modal-close]'); await sleep(150);
  await p.click('[data-act="custadd"]'); await sleep(150);
  await p.click('#custForm [name=type][value=business]'); await sleep(150);
  check('Business type asks for the business name', /Business name/.test(await text('#custForm')));
  await typeIn('#custForm [name=name]', 'Shah Traders'); await typeIn('#custForm [name=gstin]', '27abcde1234f1z5'); await typeIn('#custForm [name=phone]', '9123456780');
  await p.click('#custForm [type=submit]'); await sleep(250);
  check('business customer saved with GSTIN (upper case) and a Business badge', /Business/.test(await text('.custsheet h3')) && /GSTIN 27ABCDE1234F1Z5/.test(await text('.custsheet')));
  await p.click('[data-modal-close]'); await sleep(150);
  await p.click('[data-act="custadd"]'); await sleep(150);
  await typeIn('#custForm [name=name]', 'Someone'); await typeIn('#custForm [name=phone]', '+91 9876543210');
  await p.click('#custForm [type=submit]'); await sleep(200);
  check('the same mobile again is refused, with a way to open the existing customer', /Meera Shah already has this mobile number/.test(await text('#custErr')) && !!(await p.$('#custErr [data-custhist]')));
  await p.click('[data-act="custback"]'); await sleep(150);
  check('…and no duplicate was created', JSON.stringify((await listNames()).sort()) === '["Meera Shah","Shah Traders"]', await listNames());

  // ---------- search ----------
  await p.type('#custSearch', 'trad'); await sleep(150);
  check('search by name', JSON.stringify(await listNames()) === '["Shah Traders"]', await listNames());
  await typeIn('#custSearch', '43210'); await sleep(150);
  check('search by mobile', JSON.stringify(await listNames()) === '["Meera Shah"]', await listNames());
  await typeIn('#custSearch', 'xyz'); await sleep(150);
  check('no match says so', /No customer matches/.test(await text('#custList')));
  await p.click('#custSearch', { count: 3 }); await p.keyboard.press('Backspace'); await sleep(150);

  // ---------- edit ----------
  await p.click('#custList [data-custhist]'); await sleep(200);
  const meeraId = await run('return Object.values(customers).find(c=>c.name==="Meera Shah").id');
  await run(`openCustHistory(${JSON.stringify(meeraId)})`); await sleep(150);
  await p.click('[data-custedit]'); await sleep(150);
  await typeIn('#custForm [name=name]', 'Meera S. Shah'); await p.click('#custForm [type=submit]'); await sleep(250);
  check('edit customer: profile shows the new name', /Meera S\. Shah/.test(await text('.custsheet h3')) && await run(`return customers[${JSON.stringify(meeraId)}].name==="Meera S. Shah"`));
  await run('closeModal()');
  await p.screenshot({ path: H.ARTIFACTS + '/cu1_desktop_list.png' });

  // ---------- Sell: select existing / add new / continue without ----------
  const pay = async (how) => { await sleep(700); await p.click(`#billPanel [data-pay="${how}"]`); await sleep(200); if (how !== 'cash') { await p.type(`[data-payf="ref:${how}"]`, how === 'upi' ? '412345678901' : 'APPR1'); await sleep(80); } if (how === 'upi') { await p.click('[data-upireceived]'); await sleep(80); } await p.click('#payDone'); await sleep(300); await run('closeSheets()'); await sleep(100); };
  await run(`setTab("sell");addOne(${JSON.stringify(ids.tee)});addOne(${JSON.stringify(ids.tee)});renderAll()`); await sleep(150);
  await p.click('#billPanel [data-act="pickcust"]'); await sleep(150);
  await p.type('#custQ', 'meera'); await sleep(150);
  await p.click('#custPickList [data-custpick]'); await sleep(200);
  check('select an existing customer in Sell: the bill shows them', /Meera S\. Shah/.test(await text('#billPanel .custline')));
  await pay('cash');
  await run(`addOne(${JSON.stringify(ids.dm)});renderAll()`); await sleep(100);
  await p.click('#billPanel [data-act="pickcust"]'); await sleep(150);
  await p.click('[data-act="custnew"]'); await sleep(150);
  await typeIn('#custForm [name=name]', 'Ravi Kumar'); await typeIn('#custForm [name=phone]', '9000011111');
  await p.click('#custForm [type=submit]'); await sleep(250);
  check('add a customer during Sell: saved and on the bill, without leaving Sell', /Ravi Kumar/.test(await text('#billPanel .custline')) && await run('return prefs.tab==="sell"&&Object.values(customers).some(c=>c.name==="Ravi Kumar")'));
  await pay('upi');
  await run(`addOne(${JSON.stringify(ids.tee)});renderAll()`); await sleep(100);
  await p.click('#billPanel [data-act="pickcust"]'); await sleep(150);
  await p.click('[data-act="nocust"]'); await sleep(150);
  check('continue without customer: walk-in bill', /Walk-in/.test(await text('#billPanel .custline')));
  await pay('card');
  check('the walk-in bill has no customer', await run('const s=D().sales[D().sales.length-1];return !s.cust&&s.pay==="card"'));
  // a second bill for Meera, then one cancelled bill for her
  await run(`addOne(${JSON.stringify(ids.dm)});addOne(${JSON.stringify(ids.dm)});addOne(${JSON.stringify(ids.tee)});pickCustomer(${JSON.stringify(meeraId)});await new Promise(r=>setTimeout(r,700));await checkout({method:"upi",ref:"412345678901",confirmed:true});closeSheets();renderAll()`); await sleep(150);
  await run(`addOne(${JSON.stringify(ids.tee)});pickCustomer(${JSON.stringify(meeraId)});await new Promise(r=>setTimeout(r,700));await checkout("cash");closeSheets();renderAll()`); await sleep(150);
  await run('const s=D().sales[D().sales.length-1];await voidSale(s.id,"Duplicate bill")'); await sleep(200);

  // ---------- purchase history ----------
  await run(`setTab("customers");openCustHistory(${JSON.stringify(meeraId)})`); await sleep(200);
  const bills = await p.$$eval('.custsheet .custbill', (x) => x.map((e) => e.textContent.replace(/\s+/g, ' ')));
  const sales = await run(`return D().sales.filter(s=>s.cust&&s.cust.id===${JSON.stringify(meeraId)}&&!s.void).sort((a,b)=>b.t-a.t).map(s=>s.no)`);
  check('completed bills appear in the history, newest first (cancelled bill left out)', bills.length === 2 && bills[0].includes(sales[0]) && bills[1].includes(sales[1]), { bills, sales });
  check('each bill shows items with quantities, payment and total', /Dress · M × 2/.test(bills[0]) && /Tee × 1/.test(bills[0]) && /UPI/.test(bills[0]) && /₹2,498/.test(bills[0]) && /Tee × 2/.test(bills[1]) && /Cash/.test(bills[1]) && /₹1,000/.test(bills[1]), bills);
  check('bills, total spent and last visit', /Bills\s*2/.test(await text('.custsheet .tmini')) && /₹3,498/.test(await text('.custsheet .tmini')));
  await p.click('.custsheet .custbill'); await sleep(200);
  check('tapping a bill opens it', /Returns and exchanges|Print|Receipt/.test(await text('#modalHost')));
  await run('closeModal();renderAll()'); await sleep(150);
  check('the list shows bills and spend per customer', /2 bills/.test(await text('#custList')));
  await p.screenshot({ path: H.ARTIFACTS + '/cu2_desktop_profile.png' });

  // ---------- another account on this device ----------
  const iso = await run('storage.set(DATA_OWNER,"user-a");saveCustomers();switchLocalDataTo("user-b");loadUserState();const b=Object.keys(customers).length;switchLocalDataTo("user-a");loadUserState();return {b,a:Object.keys(customers).length}');
  check("another account on this phone sees none of this shop's customers", iso.b === 0 && iso.a === 3, iso);

  // ---------- phone ----------
  await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  // Changing the mobile/touch emulation can reload Chrome; navigate explicitly so the hooked test page is ready.
  await p.goto('http://localhost:3210/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => typeof window.__ev === 'function', { timeout: 15000 });
  await init(); await run('setTab("home");renderAll()'); await sleep(300);
  const phoneNav = await p.$$eval('.nav > button', (buttons) => buttons.map((e) => {
    const r = e.getBoundingClientRect();
    return { label: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height), vis: r.width > 0 && r.height > 0 };
  }).filter((e) => e.vis));
  check('phone: the primary navigation is Home, Sell, Bills, Stock and More', JSON.stringify(phoneNav.map((e) => e.label)) === '["Home","Sell","Bills","Stock","More"]', phoneNav);
  check('phone: every primary navigation item is a proper touch target', phoneNav.length === 5 && phoneNav.every((e) => e.h >= 44), phoneNav);
  await p.tap('.nav [data-navmore]'); await sleep(200);
  const customerGroup = await p.$eval('.navsheet [data-tab="customers"]', (e) => ({
    label: e.textContent.trim(),
    group: e.closest('.navgrp')?.querySelector('h4')?.textContent.trim() || '',
    h: Math.round(e.getBoundingClientRect().height),
  }));
  check('phone: Customers is discoverable in its grouped More destination', customerGroup.label === 'Customers' && customerGroup.group === 'Customers' && customerGroup.h >= 44, customerGroup);
  await p.tap('.navsheet [data-tab="customers"]'); await sleep(300);
  check('phone: More opens the Customers page', await run('return prefs.tab==="customers"') && await p.$eval('#v-customers', (e) => !e.hidden));
  check('phone: the page fits the width', await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1);
  const card = await p.$eval('#custList .custcard', (e) => Math.round(e.getBoundingClientRect().height));
  check('phone: customer rows are big touch targets', card >= 56, card);
  await p.screenshot({ path: H.ARTIFACTS + '/cu3_phone_list.png' });
  await p.tap('#custList .custcard'); await sleep(250);
  check('phone: the profile opens with the purchase history', (await p.$$('.custsheet .custbill')).length >= 1 && await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 1);
  await p.screenshot({ path: H.ARTIFACTS + '/cu4_phone_profile.png' });
  await run('closeModal();setTab("sell")'); await sleep(200);
  await run(`addOne(${JSON.stringify(ids.tee)});renderAll()`); await sleep(150);
  await p.tap('#billBar [data-act="openbill"]'); await sleep(250);
  await p.tap('#sheetHost [data-act="pickcust"]'); await sleep(250);
  check('phone: the customer picker opens from the bill, with "Continue without customer"', !!(await p.$('#custQ')) && !!(await p.$('[data-act="nocust"]')));

  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
