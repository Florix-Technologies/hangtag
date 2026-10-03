// Cloud round trip: device 1 uploads through the real supabase-js to a small in-memory PostgREST;
// device 2 (same account, empty) downloads everything. Upload columns are checked against the real schema.
import puppeteer from 'puppeteer-core';
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import H from '../helpers/env.mjs';
await H.ensureServer();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const check = (n, ok, i) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (i !== undefined ? '  ' + JSON.stringify(i).slice(0, 300) : '')); };
const SB = 'https://wcorlmgkwcahyfastjoz.supabase.co';
const hooked = H.hookedHtml();

// 1) real column lists from the new schema
const db = new PGlite();
await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid, provider text, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;`);
await db.exec(fs.readFileSync(H.SCHEMA_PATH, 'utf8'));
const cols = {};
(await db.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'hangtag_%'`)).rows.forEach(r => { (cols[r.table_name] = cols[r.table_name] || new Set()).add(r.column_name); });
await db.close();

// 2) tiny PostgREST stand-in (one account)
const PK = { hangtag_products: ['id'], hangtag_variants: ['id'], hangtag_images: ['product_id'], hangtag_sales: ['id'], hangtag_sale_items: ['sale_id', 'line_no'],
  hangtag_stock_moves: ['id'], hangtag_returns: ['id'], hangtag_return_items: ['return_id', 'line_no'], hangtag_customers: ['id'], hangtag_meta: ['key'], hangtag_profiles: ['id'], hangtag_payments: ['id'] };
const store = {}; const writes = []; const badCols = [];
const tbl = t => (store[t] = store[t] || []);
const key = (t, r) => (PK[t] || ['id']).map(k => r[k]).join('|');
function upsert(t, rows) { rows.forEach(r => { const k = key(t, r), a = tbl(t), i = a.findIndex(x => key(t, x) === k); if (i > -1) a[i] = Object.assign({}, a[i], r); else a.push(Object.assign({}, r)); }); }
function filt(t, q) { let rows = tbl(t).slice(); for (const [k, v] of q) { if (['select', 'order', 'offset', 'limit', 'on_conflict', 'columns'].includes(k)) continue; const m = v.match(/^(eq|in)\.(.*)$/); if (!m) continue; if (m[1] === 'eq') rows = rows.filter(r => String(r[k]) === decodeURIComponent(m[2])); else { const set = decodeURIComponent(m[2]).replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, '')); rows = rows.filter(r => set.includes(String(r[k]))); } }
  const ord = (q.find(([k]) => k === 'order') || [])[1];
  if (ord) { const keys = ord.split(',').map(x => x.split('.')); rows.sort((a, b) => { for (const [k, dir] of keys) { const x = a[k], y = b[k]; if (x === y) continue; const c = (x == null) ? -1 : (y == null) ? 1 : (x < y ? -1 : 1); return dir === 'desc' ? -c : c; } return 0; }); }
  return rows; }
const UID = 'aaaaaaaa-0000-0000-0000-000000000001', EMAIL = 'owner@example.com';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url'), now = () => Math.floor(Date.now() / 1000);
const session = () => ({ access_token: b64({ alg: 'HS256' }) + '.' + b64({ sub: UID, email: EMAIL, role: 'authenticated', exp: now() + 3600 }) + '.x', token_type: 'bearer', expires_in: 3600, expires_at: now() + 3600, refresh_token: 'r1',
  user: { id: UID, aud: 'authenticated', role: 'authenticated', email: EMAIL, user_metadata: { full_name: 'Owner' }, identities: [{ provider: 'google' }], created_at: '2026-01-01T00:00:00Z' } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS,HEAD', 'Access-Control-Expose-Headers': 'content-range' };
upsert('hangtag_profiles', [{ id: UID, email: EMAIL, full_name: 'Owner', shop_name: 'Owner Shop', phone: '9876543210', city: 'Pune', state: 'Maharashtra' }]);
function handle(r) {
  const u = new URL(r.url()), m = r.method();
  if (m === 'OPTIONS') return r.respond({ status: 204, headers: CORS });
  if (u.pathname.startsWith('/auth/v1/token')) return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(session()) });
  if (u.pathname.startsWith('/auth/v1/user')) return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(session().user) });
  if (u.pathname.startsWith('/auth/v1/settings')) return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: '{"external":{"google":true,"email":true}}' });
  if (u.pathname.startsWith('/auth/v1/')) return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: '{}' });
  if (u.pathname.startsWith('/realtime')) return r.abort();
  const mt = u.pathname.match(/^\/rest\/v1\/(?:rpc\/)?(\w+)/); if (!mt) return r.abort();
  const t = mt[1], q = [...u.searchParams.entries()];
  if (u.pathname.includes('/rpc/')) {
    // hangtag_save_sales: bills with their lines and payments (same columns as the tables; payments must add up to what was due)
    const body = JSON.parse(r.postData() || '{}');
    if (t === 'hangtag_save_sales') for (const b of body.p_bills) {
      const paid = b.payments.reduce((a, p) => a + p.amount, 0), due = Math.max(0, b.sale.total - b.sale.credit);
      if (Math.round(paid * 100) !== Math.round(due * 100)) return r.respond({ status: 400, contentType: 'application/json', headers: CORS, body: JSON.stringify({ code: '23514', message: `payments ${paid} but ${due} is due` }) });
      [['hangtag_sales', [b.sale]], ['hangtag_sale_items', b.items], ['hangtag_payments', b.payments]].forEach(([tt, rs]) => { rs.forEach(x => Object.keys(x).forEach(c => { if (cols[tt] && !cols[tt].has(c)) badCols.push(tt + '.' + c); })); upsert(tt, rs); writes.push({ t: tt, m: 'RPC', n: rs.length }); });
    }
    // hangtag_save_return: a return and its lines, all or nothing (same rules as the RPC: never more than a line has left)
    if (t === 'hangtag_save_return') {
      const R = body.p_return, rows = body.p_items;
      [['hangtag_returns', [R]], ['hangtag_return_items', rows]].forEach(([tt, rs]) => rs.forEach(x => Object.keys(x).forEach(c => { if (cols[tt] && !cols[tt].has(c)) badCols.push(tt + '.' + c); })));
      for (const x of rows) {
        const bought = (tbl('hangtag_sale_items').find(i => i.sale_id === x.sale_id && i.line_no === x.sale_line_no) || {}).quantity;
        const already = tbl('hangtag_return_items').filter(i => i.sale_id === x.sale_id && i.sale_line_no === x.sale_line_no && i.return_id !== x.return_id).reduce((a, i) => a + i.quantity, 0);
        if (bought == null || already + x.quantity > bought) return r.respond({ status: 400, contentType: 'application/json', headers: CORS, body: JSON.stringify({ code: '23514', message: `Can't return ${x.quantity} piece(s): ${bought} bought, ${already} already returned` }) });
      }
      const lines = Math.round(rows.reduce((a, x) => a + x.value, 0) * 100) + Math.round((R.round_off || 0) * 100);
      if (lines !== Math.round(R.value * 100)) return r.respond({ status: 400, contentType: 'application/json', headers: CORS, body: JSON.stringify({ code: '23514', message: `Return worth ${R.value} but its lines come to ${lines / 100}` }) });
      upsert('hangtag_returns', [R]); upsert('hangtag_return_items', rows); writes.push({ t: 'hangtag_returns', m: 'RPC', n: 1 });
    }
    return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: '[]' });
  }
  if (m === 'HEAD') return r.respond({ status: 200, headers: Object.assign({ 'content-range': '*/' + tbl(t).length }, CORS) });
  if (m === 'GET') { const rows = filt(t, q); const obj = /vnd\.pgrst\.object/.test(r.headers()['accept'] || ''); return r.respond({ status: 200, contentType: 'application/json', headers: Object.assign({ 'content-range': '0-' + rows.length + '/*' }, CORS), body: JSON.stringify(obj ? (rows[0] || null) : rows) }); }
  const body = r.postData() ? JSON.parse(r.postData()) : null;
  if (m === 'POST' || m === 'PATCH') {
    const rows = Array.isArray(body) ? body : [body];
    rows.forEach(x => Object.keys(x).forEach(c => { if (cols[t] && !cols[t].has(c)) badCols.push(t + '.' + c); }));
    if (t === 'hangtag_return_items') {   // same rule as the hangtag_check_return_qty trigger (whole statement refused)
      for (const x of rows) {
        const bought = (tbl('hangtag_sale_items').find(i => i.sale_id === x.sale_id && i.line_no === x.sale_line_no) || {}).quantity;
        const already = tbl('hangtag_return_items').filter(i => i.sale_id === x.sale_id && i.sale_line_no === x.sale_line_no && !(i.return_id === x.return_id && i.line_no === x.line_no)).reduce((a, i) => a + i.quantity, 0);
        if (bought == null || already + x.quantity > bought) return r.respond({ status: 400, contentType: 'application/json', headers: CORS, body: JSON.stringify({ code: '23514', message: `Can't return ${x.quantity} piece(s): ${bought} bought, ${already} already returned` }) });
      }
    }
    writes.push({ t, m, n: rows.length });
    if (m === 'POST') upsert(t, rows); else filt(t, q).forEach(x => Object.assign(x, rows[0]));
    return r.respond({ status: 201, contentType: 'application/json', headers: CORS, body: '[]' });
  }
  if (m === 'DELETE') { const del = new Set(filt(t, q).map(x => key(t, x))); store[t] = tbl(t).filter(x => !del.has(key(t, x))); writes.push({ t, m }); return r.respond({ status: 204, headers: CORS }); }
  return r.abort();
}
const browser = await puppeteer.launch({ executablePath: H.CHROME, headless: true });
async function device(label) {
  const ctx = await browser.createBrowserContext(); const p = await ctx.newPage(); await p.setViewport({ width: 1280, height: 900 });
  p.on('pageerror', e => { fails++; console.log(`[${label} pageerror]`, e.message); });
  await p.setRequestInterception(true);
  p.on('request', r => { const u = r.url(); if (u.startsWith('http://localhost:3210/')) { if (u === 'http://localhost:3210/' || u.includes('/?')) return r.respond({ status: 200, contentType: 'text/html', body: hooked }); return r.continue(); } if (u.startsWith(SB)) return handle(r); r.continue(); });
  await p.evaluateOnNewDocument(s => { if (location.hostname === 'localhost') localStorage.setItem('hangtag-auth', s); }, JSON.stringify(session()));
  await p.goto('http://localhost:3210/', { waitUntil: 'networkidle0' });
  await p.waitForFunction(() => window.__ev && __ev('sbStatus') === 'connected', { timeout: 20000 });
  await sleep(500);
  return p;
}
const run = (p, b, a) => p.evaluate((b, a) => __ev('(async(arg)=>{' + b + '})')(a), b, a === undefined ? null : a);
try {
  const A = await device('A');
  check('device 1 signs in and connects to the variant database', (await run(A, 'return sbStatus')) === 'connected');
  await run(A, 'loadExamples();await sleep(0)'.replace('await sleep(0)', 'await new Promise(r=>setTimeout(r,300))'));
  await run(A, 'await flushSbQueue()');
  check('examples uploaded: products, variants, opening stock', tbl('hangtag_products').length === 10 && tbl('hangtag_variants').length === 84 && tbl('hangtag_stock_moves').length === 84, { p: tbl('hangtag_products').length, v: tbl('hangtag_variants').length, m: tbl('hangtag_stock_moves').length });
  // sell a mixed bill with a customer
  await run(A, `const p=prod("p1");const v=c=>p.variants.find(x=>x.o[0]===c.split("/")[0]&&x.o[1]===c.split("/")[1]).id;
    customers.c1={id:"c1",name:"Riya",phone:"9876543210",email:"",t:Date.now()};saveCustomers();enqueue({type:"cust",id:"c1",cust:customers.c1});
    cartCust={id:"c1",name:"Riya",phone:"9876543210"};addToLines(cart,v("Black/L"),2);addToLines(cart,v("White/M"),1);await checkout({method:"upi",ref:"412345678901",confirmed:true});await flushSbQueue();`);
  const sale = tbl('hangtag_sales')[0], items = tbl('hangtag_sale_items');
  check('bill uploaded with number, customer and GST fields', sale && /^INV-\d{6}-[0-9A-Z]{3}001$/.test(sale.bill_no) && sale.customer_name === 'Riya' && sale.kind === 'sale', sale);
  check('bill lines uploaded with variant, colour and cost', items.length === 2 && items.every(i => i.variant_id && i.color && i.cost_price === 320), items.map(i => [i.variant_id, i.color, i.cost_price]));
  check('its payment uploaded with it (UPI, for the total)', JSON.stringify(tbl('hangtag_payments').map(p => [p.id, p.method, p.amount])) === JSON.stringify([[sale.id + ':upi', 'upi', sale.total]]), tbl('hangtag_payments'));
  // return and exchange, stock in, adjustment, settings
  await run(A, `const s=D().sales[0];openReturn(s.id);retState.q[0]=1;saveReturn();
    openReturn(s.id);retState.mode="exchange";retState.q[1]=1;const p=prod("p1");addToLines(retState.newItems,p.variants.find(x=>x.o[0]==="Navy"&&x.o[1]==="XL").id,1);saveReturn();
    openStockOp("in","p1");stockOp.val[p.variants[0].id]="5";saveStockOp();
    settings.lowStock=4;saveSettings();enqueue({type:"settings"});
    await flushSbQueue();`);
  check('return + exchange uploaded with their lines', tbl('hangtag_returns').length === 2 && tbl('hangtag_return_items').length === 2 && tbl('hangtag_sales').length === 2, { r: tbl('hangtag_returns').length, ri: tbl('hangtag_return_items').length, s: tbl('hangtag_sales').length });
  check('stock in and settings uploaded', tbl('hangtag_stock_moves').some(m => m.type === 'RESTOCK' && m.qty === 5) && tbl('hangtag_meta').some(m => m.key === 'settings' && m.value.lowStock === 4));
  check('queue empty afterwards', (await run(A, 'return sbOfflineQueue.length')) === 0);
  check('every uploaded column exists in the new database', badCols.length === 0, [...new Set(badCols)]);
  // edit a product: change a colour's price, hide a size that has stock history, archive another product
  await run(A, `openEditor("p5");editor.cells[tupleKey(["Beige","XL"])].price="1299";Object.assign(editor,removeValue(editor,1,editor.opts[1].v.indexOf("M")));saveEditor();setArchived("p11",true);await flushSbQueue();`);
  const p5 = () => tbl('hangtag_variants').filter(v => v.product_id === 'p5');
  check('editor save: variant price and archive uploaded', p5().some(v => v.color === 'Beige' && v.size === 'XL' && v.price === 1299) && tbl('hangtag_products').find(p => p.id === 'p11').archived === true);
  check('removed size with stock history stays in the cloud as inactive, stock taken to 0', p5().filter(v => v.size === 'M').length === 2 && p5().filter(v => v.size === 'M').every(v => v.active === false)
    && (await run(A, 'return prod("p5").variants.filter(v=>v.o[1]==="M").map(v=>stockOf(v.id)).join(",")')) === '0,0', p5().filter(v => v.size === 'M').map(v => [v.color, v.active]));
  // a size added without stock and removed again has no history, so it is deleted everywhere
  await run(A, `openEditor("p5");Object.assign(editor,addValues(editor,1,"XXL"));saveEditor();await flushSbQueue();`);
  const added = p5().filter(v => v.size === 'XXL').length;
  await run(A, `openEditor("p5");Object.assign(editor,removeValue(editor,1,editor.opts[1].v.indexOf("XXL")));saveEditor();await flushSbQueue();`);
  check('a new size with no history is created, then deleted from the cloud when removed', added === 2 && p5().filter(v => v.size === 'XXL').length === 0 && (await run(A, 'return prod("p5").variants.filter(v=>v.o[1]==="XXL").length')) === 0, { added, after: p5().filter(v => v.size === 'XXL').length });
  const snapA = await run(A, `return {stock:products().map(p=>p.variants.map(v=>v.id+"="+stockOf(v.id)).join(",")).join("|"),sales:D().sales.map(s=>s.no+":"+s.total+":"+s.items.length).join(","),rets:Object.keys(returnsMap).sort().join(","),cust:Object.values(customers).map(c=>c.name).join(","),low:settings.lowStock,arch:products().filter(p=>p.archived).map(p=>p.id).join(","),report:(()=>{prefs.period="all";const R=periodRange(),d=periodData(R.from,R.to),K=kstats(d.live,d.rets);return K.rev+"/"+K.pcs})()}`);
  // device 2: same account, nothing on this device
  const B = await device('B');
  const snapB = await run(B, `return {stock:products().map(p=>p.variants.map(v=>v.id+"="+stockOf(v.id)).join(",")).join("|"),sales:D().sales.map(s=>s.no+":"+s.total+":"+s.items.length).join(","),rets:Object.keys(returnsMap).sort().join(","),cust:Object.values(customers).map(c=>c.name).join(","),low:settings.lowStock,arch:products().filter(p=>p.archived).map(p=>p.id).join(","),report:(()=>{prefs.period="all";const R=periodRange(),d=periodData(R.from,R.to),K=kstats(d.live,d.rets);return K.rev+"/"+K.pcs})()}`);
  check("device 2 downloads the same stock for every variant", snapA.stock === snapB.stock, { a: snapA.stock.slice(0, 120), b: snapB.stock.slice(0, 120) });
  check('device 2 has the same bills, returns, customers, settings and archive', snapA.sales === snapB.sales && snapA.rets === snapB.rets && snapA.cust === snapB.cust && snapA.low === snapB.low && snapA.arch === snapB.arch, { snapA, snapB });
  check('device 2 reports the same totals', snapA.report === snapB.report, [snapA.report, snapB.report]);
  const bill = await run(B, 'const s=D().sales.find(s=>s.kind==="sale");return receiptText(s)');
  check('device 2 prints the same bill (colour / size and customer from the saved copy)', /Oversized Tee \(Black \/ L\) × 2/.test(bill) && /Customer: Riya/.test(bill), bill.split('\n').slice(3, 8));
  const prof = await run(B, 'return profile&&profile.shop_name');
  check('profile loaded on device 2', prof === 'Owner Shop');
  // both devices return the last Black L from the same bill before seeing each other's return
  await run(A, `const s=D().sales.find(s=>s.kind==="sale");openReturn(s.id);retState.q[0]=1;saveReturn();await flushSbQueue();`);
  const retsBefore = tbl('hangtag_returns').length;
  const bRet = await run(B, `const s=D().sales.find(s=>s.kind==="sale");openReturn(s.id);const left=returnable(s,s.items[0],0);retState.q[0]=1;saveReturn();
    const rid=Object.values(returnsMap).sort((a,b)=>b.t-a.t)[0].id;
    addToLines(cart,prod("p3").variants[0].id,1);await checkout("cash");await flushSbQueue();
    return {left,rid,q:sbOfflineQueue.map(i=>i.type+":"+(i.err||"")),review:syncReview.map(x=>x.item.type+":"+x.err),kept:!!returnsMap[rid],pill:$("#sync").textContent}`);
  check('device 2 thought 1 was still returnable (offline view)', bRet.left === 1, bRet);
  check('database refuses the second return: no header left behind in the cloud', tbl('hangtag_returns').length === retsBefore && tbl('hangtag_return_items').filter(i => i.sale_line_no === 0).reduce((a, i) => a + i.quantity, 0) === 2);
  check('refused return goes to the review list with its reason (not applied on device 2); the later bill still uploads', bRet.q.length === 0 && bRet.review.length === 1 && /already returned/.test(bRet.review[0]) && !bRet.kept && tbl('hangtag_sales').length === 3, bRet);
  check('the sync status says there is something to review', /Sync problem/.test(bRet.pill), bRet.pill);
  const panel = await run(B, 'openSyncPanel();return $("#modalHost").textContent');
  check('the sync panel lists it with the reason and a Discard button', /Needs review \(1\)/.test(panel) && /already returned/.test(panel) && /Discard/.test(panel), panel.slice(0, 300));
  const bothStock = await run(B, `await pullFromSupabase(false);const s=D().sales.find(s=>s.kind==="sale");return D().retLine[s.id+"|0"]`);
  check('device 2 counts only the return the database accepted', bothStock === 2, bothStock);
} finally { await browser.close(); }
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
