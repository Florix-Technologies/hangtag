// GS1 barcodes, end to end in Chrome: a product saved with its EAN-13 is found from the same item's GTIN-14, a GS1
// DataMatrix / GS1-128 element string (with the scanner's separators or in brackets) and a GS1 Digital Link; stock in by
// a GS1 code fills in the batch and expiry it carries; an expired pack isn't sold (unless the shop allows it); a serial
// in the code goes on the bill by itself; a UPC-A and its EAN-13 are the same item. The database is PGlite running the
// real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000a5', EMAIL = 'ownergs1@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, business_type, onboarded_at) VALUES ($1,$2,'Owner','Care Pharmacy','9876543210','12 MG Road','Pune','Maharashtra','grocery',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, business_type = EXCLUDED.business_type, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);

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
check('signed in and connected', await until('sbStatus==="connected"'));

// Paracetamol (batches with expiry) saved with its EAN-13; a phone tracked by serial with its EAN-13; a cable with a UPC-A
const EAN = '9506000134352', GTIN14 = '09506000134352';
const PHONE_EAN = await run('const d="890123456789";return d+gs1CheckDigit(d)'), PHONE14 = '0' + PHONE_EAN;
await run(`saveCapabilities({uses_batches:true,uses_expiry:true,uses_serials:true});
  openEditor(null);editor.name="Paracetamol 500";editor.price="30";editor.tracking="expiry";editor.codesOn=true;edCombos()[0].cell.bc=${JSON.stringify(EAN)};saveEditor();
  openEditor(null);editor.name="Phone X";editor.price="9000";editor.tracking="serial";editor.codesOn=true;edCombos()[0].cell.bc=${JSON.stringify(PHONE_EAN)};saveEditor();
  openEditor(null);editor.name="Cable";editor.price="200";editor.codesOn=true;edCombos()[0].cell.bc="012345678905";edCombos()[0].cell.stock="10";saveEditor();
  closeModal();await flushSbQueue()`);
const P = await run('const p=products().find(p=>p.name==="Paracetamol 500");return p&&{pid:p.id,vid:p.variants[0].id,trk:p.tracking}');
const PH = await run('const p=products().find(p=>p.name==="Phone X");return p&&{pid:p.id,vid:p.variants[0].id}');
check('products saved: a batch-and-expiry medicine, a serial phone, a cable', P && P.trk === 'batch' && PH);

console.log('--- stock in by a GS1 code ---');
const today = await run('return dayKey(Date.now())'), y = +today.slice(2, 4);
const EXP = `${y + 2}0131`, EXPDATE = `20${y + 2}-01-31`;
let r = await run(`const r=intakeCode("]d201${GTIN14}17${EXP}10B123");return {status:r.status,message:r.message}`);
check('a GS1 DataMatrix at stock in finds Paracetamol by its GTIN, and reads its batch and expiry', r.status === 'found' && /Paracetamol 500 · batch B123 · expires/.test(r.message), r);
// the card's Stock in (as a scan does): the batch and expiry are filled in
await run(`setTab("stock");chooseSubview("stock","levels");renderAll()`); await sleep(200);
await A.$eval('#intakeCode', (e, v) => { e.value = v; }, `(01)${GTIN14}(17)${EXP}(10)B123`);
await A.$eval('#intakeForm', (f) => f.requestSubmit()); await sleep(400);
const row = await run(`return stockOp&&stockOp.rows&&stockOp.rows[${JSON.stringify(P.vid)}]`);
check('...Stock in opens with 1 of batch B123, expiring that day', row && row.q === '1' && row.b === 'B123' && row.exp === EXPDATE, row);
await run('closeModal()');
await run(`const sup=saveSupplier({name:"Med Distributors"}).supplier.id;savePurchase({supplierId:sup,invoiceNo:"MD-1",lines:[{v:${JSON.stringify(P.vid)},q:"10",cost:"20",batch:{no:"B123",exp:${JSON.stringify(EXPDATE)}}},{v:${JSON.stringify(PH.vid)},q:"2",cost:"8000",serials:["SN0001","SN0002"]}],paid:"0"});await flushSbQueue()`);
check('stock in: 10 Paracetamol in batch B123, phones SN0001 and SN0002', await run(`return stockOf(${JSON.stringify(P.vid)})===10&&stockOf(${JSON.stringify(PH.vid)})===2`), await run(`return [stockOf(${JSON.stringify(P.vid)}),stockOf(${JSON.stringify(PH.vid)})]`));

console.log('--- selling by GS1 codes ---');
await run('setTab("sell");renderAll();cart=[];');
const scan = (code) => run(`await new Promise(r=>setTimeout(r,50));const r=scanToCart(${JSON.stringify(code)});return {status:r.status,message:r.message}`);
r = await scan(`]d201${GTIN14}17${EXP}10B123\u001d21X99`);
check('a GS1 DataMatrix (with its GS separator) sells Paracetamol (saved as EAN-13)', r.status === 'added' && /Paracetamol 500/.test(r.message), r);
r = await scan(`(01)${GTIN14}(17)${EXP}(10)B123`);
check('...so does the bracketed form', r.status === 'added' && /2 on the bill/.test(r.message), r);
r = await scan(`https://id.gs1.org/01/${GTIN14}/10/B123?17=${EXP}`);
check('...and a GS1 Digital Link QR', r.status === 'added' && /3 on the bill/.test(r.message), r);
r = await scan(GTIN14);
check('...and the GTIN-14 alone', r.status === 'added', r);
r = await scan(`(01)${GTIN14}(17)${y - 1}0131(10)OLD`);
check('an expired pack (its expiry in the code) isn\'t sold', r.status === 'invalid' && /expired on 20\d\d-01-31/.test(r.message) && await run(`return cartQtyV(${JSON.stringify(P.vid)})===4`), r);
r = await scan('0012345678905');
check('a UPC-A product scanned as its EAN-13 (0 in front) is the same item', r.status === 'added' && /Cable/.test(r.message), r);
r = await scan(`]d201${PHONE14}21SN0002`);
check('a phone\'s GS1 code with its serial: that very phone goes on the bill (no picker)', r.status === 'added' && /serial SN0002/.test(r.message) && await run('return serialsOnLines(cart).has("SN0002")'), r);
r = await scan(`]d201${PHONE14}`);
check('...without a serial in it: the serial picker asks which', r.status === 'serial', r);
await run('closeSheets();closeModal()');
r = await scan('(01)09506000134353(10)X');
check('a GS1 code with a wrong GTIN check digit isn\'t matched', r.status !== 'added', r);
await run('const s=await checkout("cash");window.__sale=s&&s.no;closeSheets();closeModal()');
check('the bill is made from what was scanned', /^INV-/.test(await run('return window.__sale') || ''));

await browser.close();
await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
