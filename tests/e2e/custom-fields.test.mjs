// The shop's own product fields and units, end to end in Chrome, on products Hangtag has no template for. The owner, with
// no code change:
//   · makes fields in Settings (Wattage: one choice; Spectrum: one choice; Warranty months: a whole number; IMEI refused,
//     with where serial numbers live) and a unit (Sq ft, 2 decimals);
//   · adds an LED grow light whose variants come from the Wattage field, with its Spectrum and warranty, and a hand-knotted
//     rug sold by the square foot — in the database: the values, the option taking its values from the field, the unit;
//   · finds the light by its spectrum, sees its details, is stopped by a wrong value;
//   · imports a sheet with a column the shop had no field for (Lumens), makes it a field in one tap, imports bar lights
//     whose rows are told apart by Wattage; exports the catalog in the same columns;
//   · sells a variant (its stock goes down), renames a Wattage choice (variants keep their ids and stock), archives a field
//     in use (its values stay);
// and the new screens fit a phone. PGlite runs the real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
import { layoutIssues } from '../helpers/responsive.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 700) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000f8', EMAIL = 'ownerfields@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, onboarded_at, business_type) VALUES ($1,$2,'Owner','Green Thumb Hydroponics','9876543210','Pune','Maharashtra',now(),'other')
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state,
    onboarded_at = EXCLUDED.onboarded_at, business_type = EXCLUDED.business_type`, [UID, EMAIL]);
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
const fill = async (sel, value) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, value); };
const uploaded = () => until('sbOfflineQueue.length===0&&!syncing', 20000);
// buttons in a sheet's footer are pressed directly: a toast from the step before may still lie over them
const tap = (sel) => A.$eval(sel, (e) => e.click());
check('signed in and connected', await until('sbStatus==="connected"'));
await run('const f=use("files");window.__saved=[];f.saveFile=async(name,data,type)=>{window.__saved.push({name,type,text:typeof data==="string"?data:null,bytes:data&&data.length||0});return true;};');

// ---------- 1. fields and a unit, made in Settings ----------
await run('openSettings("inventory")'); await sleep(400);
check('Settings → Products & Inventory offers Product fields and Units, for any kind of shop', !!(await A.$('#shopFieldsSetup [data-biz="atlist"]')) && !!(await A.$('#shopUnitsSetup [data-biz="unlist"]')));
await A.click('#shopFieldsSetup [data-biz="atlist"]'); await sleep(250);
await A.click('[data-biz="atnew"]'); await sleep(250);
async function makeField({ name, type, choices, cats, min, max }){
  await fill('#atForm [name="name"]', name);
  if (type && type !== 'choice') { await A.select('#atForm [name="type"]', type); await sleep(200); }
  if (choices) { await fill('[data-atoptadd]', choices); await A.click('[data-biz="atoptadd"]'); await sleep(150); }
  if (min != null) await fill('#atForm [name="min"]', String(min));
  if (max != null) await fill('#atForm [name="max"]', String(max));
  if (cats) await fill('#atForm [name="cats"]', cats);
  await tap('[data-biz="atsave"]'); await sleep(300);
}
await makeField({ name: 'Wattage', choices: '100 W, 200 W, 300 W', cats: 'Grow lights' });
check('a field with choices is made: back on the list', /Wattage/.test(await text('.bizlist') || '') && /3 choices/.test(await text('.bizlist') || ''), await text('.bizsheet'));
await A.click('[data-biz="atnew"]'); await sleep(250);
await makeField({ name: 'Spectrum', choices: 'Full spectrum, Bloom, Veg' });
await A.click('[data-biz="atnew"]'); await sleep(250);
await makeField({ name: 'Warranty months', type: 'number', min: 0, max: 60 });
check('…and two more: one choice for every product, a whole number from 0 to 60', /Spectrum/.test(await text('.bizlist') || '') && /Warranty months\s*Whole number/.test(await text('.bizlist') || ''), await text('.bizlist'));
await A.click('[data-biz="atnew"]'); await sleep(250);
await fill('#atForm [name="name"]', 'IMEI'); await A.select('#atForm [name="type"]', 'text'); await sleep(150);
await tap('[data-biz="atsave"]'); await sleep(200);
check('a field named IMEI is refused, and told where serial numbers live', /Serial number/.test(await text('.biz-err') || ''), await text('.biz-err'));
const F = await run('return Object.fromEntries(shopAttrs().map(a=>[a.name,a.id]))');
await A.click('[data-biz="close"]'); await sleep(150);
await run('openSettings("inventory")'); await sleep(300);
await A.click('#shopUnitsSetup [data-biz="unlist"]'); await sleep(200);
await A.click('[data-biz="unnew"]'); await sleep(200);
await fill('#unForm [name="label"]', 'Sq ft'); await A.select('#unForm [name="dp"]', '2'); await A.select('#unForm [name="kind"]', 'measure'); await A.select('#unForm [name="uqc"]', 'SQF');
await tap('[data-biz="unsave"]'); await sleep(300);
check('a unit of the shop\'s own: Sq ft, up to 2 decimals, GST SQF', /Sq ft\s*sqft · up to 2 decimals · GST SQF/.test(await text('.bizlist') || ''), await text('.bizsheet'));
await A.click('[data-biz="close"]'); await sleep(150);
check('the fields and the unit reach the database', await uploaded() && (await q(`SELECT count(*)::int n FROM public.hangtag_attributes`))[0].n === 3 && (await q(`SELECT decimals, uqc FROM public.hangtag_units WHERE id = 'sqft'`))[0].uqc === 'SQF');

// ---------- 2. a product whose variants come from a field ----------
await run('closeSettings&&closeSettings();setTab("products");renderAll();openEditor()'); await sleep(300);
await fill('#edName', 'LED Grow Light Pro'); await fill('[data-ed="price"]', '4999');
await fill('[data-ed="cat"]', 'Grow lights'); await sleep(300);
check('"More details" shows the fields for its category (Wattage too, as Grow lights), folded until used', !!(await A.$('#ed-fields')) && !!(await A.$(`[data-edattr="${F.Spectrum}"]`)) && !!(await A.$(`[data-edattr="${F['Warranty months']}"]`))
  && !!(await A.$(`[data-edattr="${F.Wattage}"]`)));
await A.$eval('#ed-fields', (d) => { d.open = true; });
await A.select(`[data-edattr="${F.Spectrum}"]`, 'Bloom'); await fill(`[data-edattr="${F['Warranty months']}"]`, '24');
await A.click('[data-edtoggle="hasOpts"]'); await sleep(250);
check('the shop\'s field is offered as an option, before the usual names', !!(await A.$(`[data-optfield="${F.Wattage}"]`)));
await A.click(`[data-optfield="${F.Wattage}"]`); await sleep(250);
check('…chosen, the option is the field, its choices one tap away', /Wattage · your field/.test(await text('.optbox') || '') && (await A.$$('[data-valpick]')).length === 3, await text('.optbox'));
await A.click('[data-valpick][data-val="100 W"]'); await sleep(200); await A.click('[data-valpick][data-val="200 W"]'); await sleep(250);
await A.$$eval('#modalHost [data-edf="stock"]', (els) => els.forEach((e, i) => { e.value = String([5, 3][i]); e.dispatchEvent(new Event('input', { bubbles: true })); }));
await tap('[data-act="edsave"]'); await sleep(500);
const lamp = await run('return products().find(p=>p.name==="LED Grow Light Pro")');
check('saved: its values, and two variants made from Wattage', lamp && lamp.attrs[F.Spectrum] === 'Bloom' && lamp.attrs[F['Warranty months']] === 24 && lamp.opts[0].a === F.Wattage
  && JSON.stringify(lamp.variants.map((v) => v.o)) === '[["100 W"],["200 W"]]', lamp || { err: await text('#edErr'), toast: await text('.toast'), editor: await run('return editor&&{opts:editor.opts,attrs:editor.attrs,cat:editor.cat}').catch((e) => String(e)) });
if (!lamp) { await browser.close(); console.log('\nstopped: the product was not saved'); process.exit(1); }
await uploaded();
const row = (await q(`SELECT attrs, options FROM public.hangtag_products WHERE name = 'LED Grow Light Pro'`))[0];
const vrows = await q(`SELECT option_values FROM public.hangtag_variants WHERE product_id = $1 ORDER BY sort_order`, [lamp.id]);
check('…in the database: attrs checked against the fields, the option naming its field, the variants and their opening stock',
  row && row.attrs[F.Spectrum] === 'Bloom' && row.attrs[F['Warranty months']] === 24 && row.options.opts[0].attr === F.Wattage && JSON.stringify(vrows.map((x) => x.option_values)) === '[["100 W"],["200 W"]]'
  && (await q(`SELECT sum(qty)::int n FROM public.hangtag_stock_moves WHERE product_id = $1`, [lamp.id]))[0].n === 8, { row, vrows });

// ---------- 3. a rug sold by the square foot ----------
await run('openEditor()'); await sleep(300);
await fill('#edName', 'Hand-knotted Kashan Rug'); await fill('[data-ed="price"]', '450'); await fill('[data-ed="cat"]', 'Rugs'); await sleep(200);
check('"Sold by" offers the shop\'s own unit', await A.$eval('#edUnit', (s) => [...s.options].some((o) => o.value === 'sqft' && /Sq ft \(up to 2 decimals\)/.test(o.textContent))));
await A.select('#edUnit', 'sqft'); await sleep(250);
await fill('#modalHost [data-edf="stock"]', '24.5');
await tap('[data-act="edsave"]'); await sleep(400);
await uploaded();
const rug = (await q(`SELECT id, unit FROM public.hangtag_products WHERE name = 'Hand-knotted Kashan Rug'`))[0];
check('the rug is sold by sqft, 24.5 in stock', rug && rug.unit === 'sqft' && +(await q(`SELECT sum(qty) n FROM public.hangtag_stock_moves WHERE product_id = $1`, [rug.id]))[0].n === 24.5, rug);

// ---------- 4. found, shown, checked ----------
await run('sellQuery="bloom";setTab("sell");renderAll()'); await sleep(250);
check('the sell search finds the light by its spectrum', await run('return sellProducts().some(p=>p.name==="LED Grow Light Pro")'));
await run('sellQuery="";renderAll();openProductView(' + JSON.stringify(lamp.id) + ')'); await sleep(250);
check('its view shows its details', /Details\s*Spectrum\s*Bloom\s*Warranty months\s*24/.test(await text('.pv-fields') || ''), await text('.pv-fields'));
await run('closeModal();openEditor(' + JSON.stringify(lamp.id) + ')'); await sleep(300);
await A.$eval('#ed-fields', (d) => { d.open = true; });
await fill(`[data-edattr="${F['Warranty months']}"]`, '72');
await tap('[data-act="edsave"]'); await sleep(250);
check('a wrong value stops the save, with the field\'s rule', /Warranty months can't be above 60/.test(await text('#edErr') || '') || /Warranty months can't be above 60/.test(await text('.toast') || ''), [await text('#edErr'), await text('.toast')]);
await run('closeModal();editor=null'); await sleep(150);

// ---------- 5. an import with a column the shop had no field for, and the export ----------
const write = (name, rows) => { const p = H.ARTIFACTS + '/' + name; fs.writeFileSync(p, '﻿' + rows.join('\r\n') + '\r\n'); return p; };
const CSV = write('custom-fields-import.csv', [
  'Product name,Selling price,Category,Wattage,Spectrum,Lumens,Stock quantity',
  'Bar Light 2 ft,2999,Grow lights,100 W,Full spectrum,9000,6',
  'Bar Light 2 ft,4499,Grow lights,200 W,Full spectrum,18000,4',
  'Clip Fan,899,Grow lights,,Veg,,10',
]);
await run('setTab("products");renderAll()'); await sleep(200);
await A.click('[data-act="prodimport"]'); await sleep(250);
await (await A.$('#impFile')).uploadFile(CSV); await sleep(800);
check('the preview reads the fields\' columns, and lists the one the shop has no field for (Lumens: whole numbers)', /Lumens/.test(await text('.im-unknown') || '') && /whole number/.test(await text('.im-unknown') || '')
  && /Spectrum: Full spectrum/.test(await text('.im') || ''), await text('.im-unknown'));
await A.click('[data-imp="addfields"]'); await sleep(800);
check('one tap makes Lumens a field and reads the file again: nothing left out', !(await A.$('.im-unknown')) && /Lumens: 9000/.test(await text('.im') || '') && !(await A.$eval('#impGo', (b) => b.disabled)), await text('.im-body'));
await tap('#impGo'); await sleep(600);
await uploaded();
const bar = await run('return products().find(p=>p.name==="Bar Light 2 ft")');
const barRow = (await q(`SELECT attrs, options FROM public.hangtag_products WHERE name = 'Bar Light 2 ft'`))[0];
check('imported: the bar light\'s variants come from Wattage, Lumens differs per variant too, Spectrum is the product\'s own', bar && bar.opts.map((o) => o.n).join() === 'Wattage,Lumens' && bar.opts[0].a === F.Wattage
  && barRow && barRow.attrs[F.Spectrum] === 'Full spectrum' && barRow.options.opts[1].attr, { bar, barRow });
check('…and the clip fan has its own Spectrum', (await q(`SELECT attrs FROM public.hangtag_products WHERE name = 'Clip Fan'`))[0].attrs[F.Spectrum] === 'Veg');
await run('openProductImport()'); await sleep(200);
await A.click('[data-imp="expcsv"]'); await sleep(300);
const exp = (await run('return window.__saved.find(x=>/^hangtag-products-/.test(x.name))')) || {};
const expLines = String(exp.text || '').replace(/^﻿/, '').split('\n');
check('the export: the template\'s columns with the shop\'s fields, one row per variant', /Wattage,Spectrum,Warranty months,Lumens/.test(expLines[0]) && expLines.some((l) => /^LED Grow Light Pro,.*,100 W,Bloom,24,/.test(l))
  && expLines.some((l) => /^"?Hand-knotted Kashan Rug"?,.*sqft/.test(l)), expLines.slice(0, 6));
await run('closeModal();prodImport=null'); await sleep(100);

// ---------- 6. sold, renamed, archived ----------
const v100 = lamp.variants[0].id;
await run(`setTab("sell");addOne(${JSON.stringify(v100)});lastCheckout=0;await checkout("cash")`); await sleep(400);
check('a 100 W light sold: its stock goes from 5 to 4', await until(`stockOf(${JSON.stringify(v100)})===4`));
await uploaded();
await run('openSettings("inventory")'); await sleep(300);
await A.click('#shopFieldsSetup [data-biz="atlist"]'); await sleep(200);
await A.click(`[data-atedit="${F.Wattage}"]`); await sleep(250);
check('a field in use: its kind fixed, each choice says how many products use it', await A.$eval('#atForm select[name="type"]', (s) => s.disabled) && /used by 2 products/.test(await text('.atopts') || ''), await text('.atopts'));
await fill('[data-atopt="0"]', '100 Watt');
await tap('[data-biz="atsave"]'); await sleep(500);
await uploaded();
const after = await run(`return products().find(p=>p.id===${JSON.stringify(lamp.id)})`);
const dbv = await q(`SELECT id, option_values FROM public.hangtag_variants WHERE product_id = $1 ORDER BY sort_order`, [lamp.id]);
check('renaming a choice renames it on every product using it: same variants, same stock', after.opts[0].v[0] === '100 Watt' && after.variants[0].id === v100 && dbv[0].id === v100
  && dbv[0].option_values[0] === '100 Watt' && (await run(`return stockOf(${JSON.stringify(v100)})`)) === 4 && (await run('return products().find(p=>p.name==="Bar Light 2 ft").opts[0].v[0]')) === '100 Watt', { after: after.opts, dbv });
await A.click(`[data-atedit="${F.Spectrum}"]`); await sleep(250);
check('a field in use can\'t be removed, only archived', !(await A.$('[data-biz="atremove"]')) && !!(await A.$('[data-biz="atarchive"]')));
await tap('[data-biz="atarchive"]'); await sleep(400);
await uploaded();
check('archived: the products keep their values (in the database too)', (await q(`SELECT archived FROM public.hangtag_attributes WHERE id = $1`, [F.Spectrum]))[0].archived === true
  && (await q(`SELECT attrs FROM public.hangtag_products WHERE id = $1`, [lamp.id]))[0].attrs[F.Spectrum] === 'Bloom');
await A.click('[data-biz="close"]'); await sleep(150);
await run('openEditor(' + JSON.stringify(lamp.id) + ')'); await sleep(300);
check('…and the product editor shows it as an archived field, read only', /Spectrum \(archived field\)\s*Bloom/.test(await text('#ed-fields') || ''), await text('#ed-fields'));
await run('closeModal();editor=null'); await sleep(100);

// ---------- 7. the new screens on a phone ----------
await A.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true }); await sleep(600);
await until('sbStatus==="connected"');
const screens = [
  ['product editor with its fields and an option from a field', 'openEditor(' + JSON.stringify(lamp.id) + ');document.querySelector("#ed-fields").open=true'],
  ['the product fields list', 'openSettings("inventory");openAttrList()'],
  ['a field being made, with choices', 'openAttrEditor(' + JSON.stringify(F.Wattage) + ')'],
  ['the units list', 'openUnitList()'],
  ['a unit being made', 'openUnitEditor(null)'],
];
for (const [name, js] of screens) {
  await run('closeModal();editor=null;bizView=null;' + js); await sleep(400);
  const issues = await layoutIssues(A, { touch: true });
  check(`phone: ${name} fits (nothing sideways, off-screen, overlapping or unnamed)`, !issues.length, issues.slice(0, 4));
}

await browser.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
