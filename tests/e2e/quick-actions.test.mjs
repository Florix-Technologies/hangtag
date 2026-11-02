// Smart quick actions (the app bar's New), end to end in Chrome: everything this person may start — a sale, stock, a
// supplier bill, a purchase order, a product, a customer, a quotation, a sales order, an expense, cash in / out, a bank
// entry — in their role's order; the page's own actions suggested first (on Stock: receive stock, a supplier bill, a
// purchase order); what they start often suggested after a few starts; number keys start them; each opens the flow the
// app already has (cash in / out and the bank entry with the choice in the form, recorded in the books); a cashier gets
// only what a cashier may do, the kitchen no New at all; Home's buttons are unchanged. The database is PGlite running the
// real schema.sql behind a PostgREST stand-in (row security on).
import puppeteer from 'puppeteer-core';
import H from '../helpers/env.mjs';
import { createPgRest } from '../helpers/pg-rest.mjs';
await H.ensureServer();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (!ok && i !== undefined ? '  ' + JSON.stringify(i).slice(0, 600) : '')); };
const UID = 'aaaaaaaa-0000-0000-0000-0000000000b7', EMAIL = 'ownerquick@example.com';
const pg = await createPgRest(H.SCHEMA_PATH, { uid: UID, email: EMAIL });
await pg.db.query(`INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, address, city, state, gstin, onboarded_at) VALUES ($1,$2,'Owner','Aura Threads','9876543210','12 MG Road','Pune','Maharashtra','27ABCDE1234F1Z5',now())
  ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`, [UID, EMAIL]);

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
const type = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); await sleep(100); };
const choose = async (sel, v) => { await A.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); }, v); await sleep(100); };
const go = async (tab) => { await run(`closeModal();closeSheets();setTab(${JSON.stringify(tab)});renderAll()`); await sleep(200); };
/* New's rows: titles in order, and the headings */
const openNew = async () => { await A.click('#globalActions [data-global="quick"]'); await sleep(250); };
const rows = () => A.$$eval('#quickActions .quick-row', (b) => b.map((x) => x.querySelector('b').textContent));
const heads = () => A.$$eval('#quickActions .quick-h', (h) => h.map((x) => x.textContent));
const start = async (label) => { const i = (await rows()).indexOf(label); if (i < 0) return false; await (await A.$$('#quickActions .quick-row'))[i].click(); await sleep(350); return true; };
check('signed in and connected', await until('sbStatus==="connected"'));
await run('closeModal();setTab("home");renderAll()'); await sleep(200);
const voucher = await run('return usesVouchers()');

console.log('--- the owner: everything, in the owner\'s order ---');
await openNew();
const OWNER = ['New sale', 'Receive stock', 'Supplier bill', 'Add product', 'Add customer', 'Expense', 'Quotation', 'Sales order', 'Purchase order', 'Cash in / out', 'Bank entry', ...(voucher ? ['Gift voucher'] : [])];
check('New on Home: every action, in the owner\'s usual order, nothing "suggested" yet', JSON.stringify(await rows()) === JSON.stringify(OWNER) && (await heads()).length === 0, await rows());
check('…each with its number key (on a keyboard)', (await A.$$eval('#quickActions .quick-key', (k) => k.map((x) => x.textContent))).slice(0, 3).join() === '1,2,3');
await go('stock'); await openNew();
const R1 = await rows();
check('on Stock: receive stock, a supplier bill and a purchase order suggested, "for this page"', JSON.stringify(R1.slice(0, 3)) === JSON.stringify(['Receive stock', 'Supplier bill', 'Purchase order'])
  && (await heads())[0] === 'Suggested' && /For this page/.test(await text('#quickActions .quick-list .quick-row') || '') && R1.length === OWNER.length, R1);

console.log('--- each opens the flow the app has ---');
check('Supplier bill → the purchase entry, New gone', await start('Supplier bill') && await vis('.pu-sheet') && !(await A.$('#quickActions')));
await go('stock'); await openNew();
check('Purchase order → the purchase order editor', await start('Purchase order') && await vis('.poedit'));
await go('home'); await openNew();
check('Quotation → a new quotation', await start('Quotation') && await vis("#orderSheet") && /quotation/i.test(await text("#orderSheet h3") || ""));
await go('home'); await openNew();
check('Expense → the cash book\'s expense form', await start('Expense') && /Expense/.test(await text('#cashT') || '') && await vis('#cashForm select[name="category"]'));
await go('home'); await openNew(); await start('Expense'); await go('home'); await openNew();
const R2 = await rows();
check('started twice: Expense suggested, "you start this often" (once isn\'t often: not the purchase order)', R2[0] === 'Expense' && (await heads())[0] === 'Suggested'
  && /You start this often/.test(await text('#quickActions .quick-row') || '') && !(await text('#quickActions .quick-list') || '').includes('Purchase orderYou'), R2.slice(0, 4));
await A.keyboard.press('1'); await sleep(350);
check('key 1 starts the first: the expense form', /Expense/.test(await text('#cashT') || '') && !(await A.$('#quickActions')));

console.log('--- cash in / out and the bank entry, recorded in the books ---');
await go('home'); await openNew(); await start('Cash in / out');
check('Cash in / out: one form, which way chosen in it', /Cash in or out/.test(await text('#cashT') || '') && await vis('#cashForm select[name="type"]'));
await choose('#cashForm select[name="type"]', 'out'); await type('#cashForm [name="amount"]', '200'); await type('#cashForm [name="reason"]', 'Handed to the owner');
await A.click('#cashForm [type="submit"]'); await sleep(350);
const cm = await run('return Object.values(cashMoves).map(m=>({type:m.type,amount:m.amount,reason:m.reason}))');
check('…saved as cash out ₹200 in the cash book', cm.length === 1 && cm[0].type === 'out' && +cm[0].amount === 200 && cm[0].reason === 'Handed to the owner' && !(await A.$('#cashForm')), cm);
await go('home'); await openNew(); await start('Bank entry');
check('Bank entry with no account yet: adding the account comes first', await vis('#bankEdit'));
await run(`closeModal();saveBankAccount({name:"HDFC Current",bank:"HDFC",last4:"1234",opening:"10000",openingDate:dayKey(Date.now()),isDefault:true,active:true,methods:["upi","card"]})`);
await go('home'); await openNew(); await start('Bank entry');
check('then straight to the entry on that account, in or out chosen in the form', await vis('#bankMove') && /Bank entry · HDFC Current/.test(await text('#bankMove .sh-head') || '')
  && await vis('#bankMoveForm select[name="type"]') && !(await A.$('#bankMoveForm select[name="account"]')));
await choose('#bankMoveForm select[name="type"]', 'in'); await type('#bankMoveForm [name="amount"]', '5000'); await type('#bankMoveForm [name="reason"]', 'Cash deposit');
await A.click('#bankMoveForm [type="submit"]'); await sleep(400);
check('…recorded: money in ₹5,000, the account showing ₹15,000', await vis('#bankSheet') && /₹15,000/.test(await text('#bankSheet .bankbal') || '')
  && await run('return bankMoves().some(m=>m.type==="in"&&+m.amount===5000)'), await text('#bankSheet .bankbal'));
await run(`closeModal();saveBankAccount({name:"SBI Savings",bank:"SBI",last4:"9876",opening:"2000",openingDate:dayKey(Date.now()),isDefault:false,active:true,methods:[]})`);
const SBI = await run('return bankAccounts().find(a=>a.name==="SBI Savings").id');
await go('home'); await openNew(); await start('Bank entry');
check('two accounts: the account chosen in the form (the default first)', await vis('#bankMoveForm select[name="account"]') && (await A.$$eval('#bankMoveForm select[name="account"] option', (o) => o.map((x) => x.textContent))).join() === 'HDFC Current ••1234,SBI Savings ••9876');
await choose('#bankMoveForm select[name="account"]', SBI); await type('#bankMoveForm [name="amount"]', '300'); await type('#bankMoveForm [name="reason"]', 'Bank charges');
await A.click('#bankMoveForm [type="submit"]'); await sleep(400);
check('…money out ₹300 on SBI, not HDFC', await run(`return bankMoves().some(m=>m.type==="out"&&+m.amount===300&&m.account===${JSON.stringify(SBI)})`) && /SBI Savings/.test(await text('#bankSheet .sh-head') || ''));

console.log('--- roles ---');
await run('closeModal();window.__owner=access;access={role:"cashier",perms:[...ROLE_DEFAULTS.cashier],shopName:"Aura Threads"};setTab("home");renderAll()'); await sleep(250);
await openNew();
const C = await rows();
check('a cashier: sale, customer, cash, expense, quotation, order — no stock, purchases, products or bank', ['New sale', 'Add customer', 'Cash in / out', 'Expense'].every((x) => C.includes(x))
  && C[0] === 'New sale' && !['Receive stock', 'Supplier bill', 'Purchase order', 'Add product', 'Bank entry'].some((x) => C.includes(x)), C);
await run('closeModal();access={role:"kitchen",perms:[...ROLE_DEFAULTS.kitchen],shopName:"Aura Threads"};renderAll()'); await sleep(200);
check('the kitchen: no New at all', !(await A.$('#globalActions [data-global="quick"]')) && !!(await A.$('#globalActions [data-global="search"]')));
await run('access=window.__owner;setTab("home");renderAll()'); await sleep(250);
check('Home\'s buttons for the owner are unchanged (New sale, Scan to sell, Receive stock)', JSON.stringify(await A.$$eval('#homeBody .qa .qa-b', (l) => l.map((b) => b.textContent.trim()))) === '["New sale","Scan to sell","Receive stock"]');

await browser.close(); await pg.close?.();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
