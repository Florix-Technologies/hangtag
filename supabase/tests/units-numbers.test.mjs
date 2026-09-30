// Units, decimal quantities, device-scoped numbers and who made a record (schema.sql section 3k): the schema runs twice and
// the report's rows 35-39 are ok; products carry a known unit; a bill of 2.5 kg, a return of 0.75 kg (and never more than
// is left, in kg), stock records with decimals that add up exactly; a bill (credit note) number another bill of the shop
// has is refused for a new bill or a changed number (the app sends it to the sync review), while bills that already had
// the same number stay and another shop may use it; user_id is always the signed-in account (a team member's own id).
// PGlite with Supabase stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { quoteReturn } from '../../src/domain/returns/return-value.js';
import { deviceCode, nextDocNo } from '../../src/domain/sales/sale.js';
import { numberTaken } from '../../src/domain/sync/queue-rules.js';
import { billArgs, moveRow, returnArgs, rowToItem, rowToMove, rowToReturnItem } from '../../src/infrastructure/supabase/mappers.js';
import { toAppError } from '../../src/infrastructure/supabase/errors.js';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : '')); };
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, provider text, email text);
CREATE TABLE auth.sessions (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;`;

/* who: an owner's id, or a member { id, key } asking from the device with that key */
async function as(db, who, sql, params) {
  const id = typeof who === 'string' ? who : who && who.id, key = who && typeof who === 'object' ? who.key : null;
  await db.exec(`SET ROLE ${id ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
    [id || '', key ? JSON.stringify({ authorization: 'Bearer x', 'x-hangtag-device': key }) : JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
async function asService(db, sql, params) {
  await db.exec('SET ROLE service_role');
  await db.query(`SELECT set_config('request.jwt.claim.sub', '', false), set_config('request.headers', '', false)`);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message, e }; } };
const rows = async (db, who, sql, params) => (await as(db, who, sql, params)).rows;
const one = async (db, who, sql, params) => (await rows(db, who, sql, params))[0];
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const num = (v) => (v == null ? null : +v);

const RICE = { p: 'rice', v: 'rice:', n: 'Rice', price: 43 }, TEE = { p: 'tee', v: 'tee:', n: 'Tee', price: 500 };
/* A bill as the app makes it: lines [{ ...product, q }] (a weighed line has its unit), number `no` */
function bill(id, lines, { no, t = 1790000000000, dev = 'dev-a' } = {}) {
  const T = computeCheckout({ lines: lines.map((l) => ({ q: l.q, price: l.price, rate: 0 })), billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, T.total > 0 ? [{ method: 'cash', amount: T.total }] : []);
  return { id, no: no || 'INV-' + id, t, dev, kind: 'sale', ex: null, credit: 0, cust: null,
    items: lines.map((l, k) => { const L = T.lines[k]; return { ln: k, p: l.p, v: l.v, n: l.n, c: '', s: '', vl: '', ov: [], sku: '', q: l.q, ...(l.u ? { u: l.u } : {}), price: l.price, cost: null,
      dAmt: 0, bdAmt: 0, gst: 0, hsn: '', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total }; }),
    sub: T.sub, disc: T.disc, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'cash', payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
/* A return as RecordReturn makes it from the saved bill */
function ret(id, sale, picks, prior = [], { no } = {}) {
  const Q = quoteReturn(sale, picks, prior);
  if (Q.error) throw new Error(Q.error);
  return { id, no: no || 'CN-' + id, sale: sale.id, t: sale.t + 5000, kind: 'return', ex: null, refund: Q.value, pay: 'cash', value: Q.value, ro: Q.roundOff, note: '', dev: 'dev-a',
    items: Q.lines.map((L) => { const i = sale.items.find((x) => x.ln === L.ln); return { ln: L.ln, v: i.v, p: i.p, n: i.n, c: '', s: '', vl: '', ov: [], sku: '', q: L.q, price: L.unit, value: L.value, cost: null, restock: true,
      tx: L.tx, cgst: L.cgst, sgst: L.sgst, igst: L.igst, gst: L.rate, hsn: L.hsn }; }) };
}
const saveBill = (db, who, b) => tryAs(db, who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([billArgs(b)])]);
const saveRet = (db, who, r) => { const a = returnArgs(r); return tryAs(db, who, `SELECT public.hangtag_save_return($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a.p_return), JSON.stringify(a.p_items)]); };

const uid = (n) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CA = { id: uid(1), key: 'key-cashier-0001-abcdefghijklmnop', dev: 'dev-cashier-1' };   // a cashier of shop A
const KA = { id: uid(2), key: 'key-kitchen-0002-abcdefghijklmnop', dev: 'dev-kitchen-2' };   // kitchen staff of shop A

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
for (const m of [CA, KA]) await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ($1, $2, '{"staff":true}')`, [m.id, m.id.slice(-4) + '@staff.hangtag.invalid']);
await db.exec(NEW); await db.exec(NEW);

console.log('=== the schema runs twice; quantities keep 3 decimals ===');
{
  const rep = await report(db);
  check('migration report: 46 rows, all ok (rows 35-39: decimals, units, unique numbers, who made it)', rep.length === 46 && rep.every((r) => r.ok) && rep.filter((r) => /3 decimals|known unit|no other|who made/.test(r.check_name)).length === 5, rep.filter((r) => !r.ok));
  const cols = (await db.query(`SELECT table_name || '.' || column_name AS c, numeric_precision AS p, numeric_scale AS s FROM information_schema.columns WHERE table_schema = 'public'
      AND (table_name, column_name) IN (('hangtag_sale_items','quantity'), ('hangtag_return_items','quantity'), ('hangtag_stock_moves','qty'), ('hangtag_sales','subtotal')) ORDER BY 1`)).rows;
  check('bill / return line quantities and stock records are NUMERIC(12,3); a bill\'s subtotal NUMERIC(12,2)', cols.length === 4 && cols.every((c) => c.p === 12 && c.s === (c.c === 'hangtag_sales.subtotal' ? 2 : 3)), cols);
  const u = (await db.query(`SELECT column_default AS d, is_nullable AS n FROM information_schema.columns WHERE table_name = 'hangtag_products' AND column_name = 'unit'`)).rows[0];
  check('products.unit: pieces unless set, never empty', /'pcs'/.test(u.d) && u.n === 'NO', u);
}

console.log('\n=== team: a cashier and a kitchen member of shop A ===');
{
  for (const [m, role] of [[CA, 'cashier'], [KA, 'kitchen']]) {
    await asService(db, `INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1, $2, $3, $4, $5, 'active', $2)`, [m.id, A, 'Staff ' + role, role + '1', role]);
    await asService(db, `INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Counter', 'Android', $4)`, [A, m.dev, m.id, hash(m.key)]);
  }
  const me = await one(db, CA, `SELECT public.hangtag_shop_id()::text AS shop, public.hangtag_can('create_sale') AS sell`);
  check('the cashier works in shop A and may sell', me.shop === A && me.sell === true, me);
}

console.log('\n=== products in units ===');
{
  for (const owner of [A, B]) {
    await as(db, owner, `INSERT INTO public.hangtag_products (id, name, price, unit) VALUES ('rice', 'Rice', 43, 'kg'), ('tee', 'Tee', 500, DEFAULT)`);
    await as(db, owner, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('rice:', 'rice', '[]'), ('tee:', 'tee', '[]')`);
  }
  const p = await rows(db, A, `SELECT id, unit FROM public.hangtag_products ORDER BY id`);
  check('a product sold by the kg, one by the piece (the default)', p.map((x) => x.id + ':' + x.unit).join() === 'rice:kg,tee:pcs', p);
  const bad = await tryAs(db, A, `INSERT INTO public.hangtag_products (id, name, price, unit) VALUES ('x', 'X', 1, 'tonne')`);
  check('an unknown unit is refused', /unit_check/.test(bad.err || ''), bad);
}

console.log('\n=== a bill of 2.5 kg, returns of weights ===');
const day = new Date(2026, 8, 29, 11).getTime();
const noA1 = nextDocNo('INV-', [], day, 'dev-a');
const s1 = bill('s1', [{ ...RICE, q: 2.5, u: 'kg' }, { ...TEE, q: 1 }, { ...RICE, q: 0.335, u: 'kg' }], { no: noA1, t: day });
{
  const r = await saveBill(db, A, s1);
  check('the bill saves: 2.5 kg × ₹43 + 1 Tee + 0.335 kg × ₹43 (₹14.41)', !r.err && s1.sub === 621.91, r.err || s1.sub);
  const it = await rows(db, A, `SELECT line_no, quantity, unit FROM public.hangtag_sale_items WHERE sale_id = 's1' ORDER BY line_no`);
  check('lines keep 2.500 kg, 1 pcs, 0.335 kg (the unit from the product)', it.map((x) => num(x.quantity) + x.unit).join() === '2.5kg,1pcs,0.335kg', it);
  check('read back: the app gets 2.5 with its unit kg (pieces have no unit field)', rowToItem(it[0]).q === 2.5 && rowToItem(it[0]).u === 'kg' && rowToItem(it[1]).u === undefined);
  const s = await one(db, A, `SELECT subtotal, bill_no FROM public.hangtag_sales WHERE id = 's1'`);
  check('the bill\'s subtotal keeps its paise and its device number', num(s.subtotal) === 621.91 && s.bill_no === noA1 && new RegExp(deviceCode('dev-a') + '001$').test(s.bill_no), s);
  const r1 = ret('r1', s1, { 0: 0.75 });
  const a = await saveRet(db, A, r1);
  const ri = await one(db, A, `SELECT quantity, unit FROM public.hangtag_return_items WHERE return_id = 'r1'`);
  check('a return of 0.75 kg saves, its line in kg (from the bill line)', !a.err && num(ri.quantity) === 0.75 && ri.unit === 'kg' && rowToReturnItem({ ...ri, sale_line_no: 0 }).q === 0.75, a.err || ri);
  // a phone that has not seen r1 asks for 1.8 kg more (only 1.75 are left)
  const tooMuch = { ...ret('r2', s1, { 0: 1.8 }), items: ret('r2', s1, { 0: 1.8 }).items };
  const b = await saveRet(db, A, tooMuch);
  check('more than is left is refused, in kg', /Can't return 1\.8 kg: 2\.5 bought, 0\.75 already returned/.test(b.err || ''), b.err);
  const c = await saveRet(db, A, ret('r3', s1, { 0: 1.75 }, [{ items: [{ ln: 0, q: 0.75, value: r1.value, tx: r1.items[0].tx, cgst: 0, sgst: 0, igst: 0 }] }]));
  check('the rest (1.75 kg) comes back', !c.err, c.err);
  const left = await one(db, A, `SELECT i.quantity - COALESCE((SELECT sum(x.quantity) FROM public.hangtag_return_items x WHERE x.sale_id = i.sale_id AND x.sale_line_no = i.line_no), 0) AS left
      FROM public.hangtag_sale_items i WHERE i.sale_id = 's1' AND i.line_no = 0`);
  check('nothing of the line is left, exactly (2.5 − 0.75 − 1.75 = 0)', num(left.left) === 0, left);
}

console.log('\n=== stock records with decimals ===');
{
  const moves = [{ id: 'o1', v: 'rice:', p: 'rice', type: 'OPENING', q: 10, t: 1 }, { id: 'm1', v: 'rice:', p: 'rice', type: 'RESTOCK', q: 0.1, t: 2 }, { id: 'm2', v: 'rice:', p: 'rice', type: 'RESTOCK', q: 0.2, t: 3 },
    { id: 'm3', v: 'rice:', p: 'rice', type: 'ADJUST', q: -0.125, t: 4 }];
  for (const m of moves) await as(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t, device_id) VALUES ($1, $2, $3, $4, $5, $6, 'dev-a')`,
    (({ id, variant_id, product_id, type, qty, t }) => [id, variant_id, product_id, type, qty, t])(moveRow({ ...m, dev: 'dev-a' })));
  const s = await one(db, A, `SELECT sum(qty) AS q FROM public.hangtag_stock_moves WHERE variant_id = 'rice:'`);
  check('10 + 0.1 + 0.2 − 0.125 = 10.175 kg exactly', num(s.q) === 10.175 && s.q.toString() === '10.175', s);
  const back = (await rows(db, A, `SELECT * FROM public.hangtag_stock_moves WHERE id = 'm3'`)).map(rowToMove)[0];
  check('read back as −0.125', back.q === -0.125, back);
  const imp = await tryAs(db, A, `SELECT public.hangtag_import_stock($1::jsonb, '[]'::jsonb, '[]'::jsonb, $2::jsonb, false) AS r`,
    [JSON.stringify({ id: 'imp1', supplier_name: 'Mill', invoice_no: 'M-1', line_count: 1 }), JSON.stringify([{ id: 'im1', variant_id: 'rice:', product_id: 'rice', qty: 12.5, cost_price: 38 }])]);
  const u = await one(db, A, `SELECT units FROM public.hangtag_stock_imports WHERE id = 'imp1'`);
  check('a supplier bill of 12.5 kg: stock in 12.5, the import counts 12.5 units', !imp.err && imp.r.rows[0].r.units == 12.5 && num(u.units) === 12.5, imp.err || u);
  const z = await tryAs(db, A, `SELECT public.hangtag_import_stock($1::jsonb, '[]'::jsonb, '[]'::jsonb, $2::jsonb, false) AS r`,
    [JSON.stringify({ id: 'imp2', supplier_name: 'Mill', invoice_no: 'M-2', line_count: 1 }), JSON.stringify([{ id: 'im2', variant_id: 'rice:', product_id: 'rice', qty: 0.0004 }])]);
  check('a quantity that rounds to 0 is refused', /above 0/.test(z.err || ''), z.err);
}

console.log('\n=== one bill number per bill in a shop ===');
{
  const noB1 = nextDocNo('INV-', [], day, 'dev-b');
  const a2 = await saveBill(db, A, bill('s2', [{ ...TEE, q: 1 }], { no: noB1, t: day, dev: 'dev-b' }));
  check('two devices the same day: their own numbers, both saved', !a2.err && noB1 !== noA1, a2.err);
  const again = await saveBill(db, A, s1);
  check('the same bill uploaded again keeps its number (no refusal)', !again.err, again.err);
  const dup = await saveBill(db, A, bill('s3', [{ ...TEE, q: 1 }], { no: noA1, t: day }));
  check('a new bill with a number another bill has is refused', /Bill number .+ is already used by another bill of this shop/.test(dup.err || '') && (await one(db, A, `SELECT count(*)::int n FROM public.hangtag_sales WHERE id = 's3'`)).n === 0, dup.err);
  const app = toAppError(dup.e);
  check('the app reads it as a conflict with the database\'s words → sync review, "give it a new number"', app.code === 'CONFLICT' && app.message === dup.err
    && numberTaken({ item: { type: 'sale' }, code: app.code, err: app.message }), { code: app.code, msg: app.message });
  const ren = await tryAs(db, A, `UPDATE public.hangtag_sales SET bill_no = $1 WHERE id = 's2'`, [noA1]);
  check('changing a bill\'s number to a taken one is refused', /already used/.test(ren.err || ''), ren.err);
  const other = await saveBill(db, B, bill('s1', [{ ...TEE, q: 1 }], { no: noA1, t: day }));
  check('another shop may have the same number (and learns nothing about shop A)', !other.err, other.err);
  // two bills that got the same number before this rule
  await db.exec(`ALTER TABLE public.hangtag_sales DISABLE TRIGGER hangtag_doc_no_check`);
  for (const id of ['o1', 'o2']) await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, total, payment_method, bill_no) VALUES ($1, 1780000000000, 100, 0, 100, 'cash', 'INV-250101-001')`, [id]);
  await db.exec(`ALTER TABLE public.hangtag_sales ENABLE TRIGGER hangtag_doc_no_check`);
  const keep = await tryAs(db, A, `UPDATE public.hangtag_sales SET is_void = TRUE, void_reason = 'Test' WHERE id = 'o2'`);
  check('bills that already shared a number stay, and can still be changed (cancelled)', !keep.err, keep.err);
  await db.exec(NEW);
  const rep = await report(db);
  check('the schema runs again with them there; the report is all ok', rep.length === 46 && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  // credit notes
  const cn = nextDocNo('CN-', [], day, 'dev-a');
  const s4 = bill('s4', [{ ...TEE, q: 2 }], { no: nextDocNo('INV-', [{ no: noA1, t: day, dev: 'dev-a' }], day, 'dev-a'), t: day });
  await saveBill(db, A, s4);
  const c1 = await saveRet(db, A, ret('r4', s4, { 0: 1 }, [], { no: cn }));
  const c2 = await saveRet(db, A, ret('r5', s4, { 0: 1 }, [], { no: cn }));
  check('a credit note number is used once too', !c1.err && /Credit note number .+ is already used by another return of this shop/.test(c2.err || '') && toAppError(c2.e).code === 'CONFLICT', [c1.err, c2.err]);
  const c3 = await saveRet(db, A, ret('r4', s4, { 0: 1 }, [], { no: cn }));
  check('the same return sent again is fine', !c3.err, c3.err);
}

console.log('\n=== who made it: user_id is the signed-in account ===');
{
  const s = await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_sales WHERE id = 's1'`);
  check('the owner\'s bill: user_id = the owner', s.u === A, s);
  await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, discount, total, payment_method, user_id) VALUES ('forged', 1790000000000, 1, 0, 1, 'cash', $1)`, [CA.id]);
  check('a user_id sent by the phone is not trusted (the database sets it)', (await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_sales WHERE id = 'forged'`)).u === A);
  const noC = nextDocNo('INV-', [], day, CA.dev);
  const r = await saveBill(db, CA, bill('sc1', [{ ...RICE, q: 1.5, u: 'kg' }], { no: noC, t: day, dev: CA.dev }));
  const c = await one(db, A, `SELECT owner_id::text AS o, user_id::text AS u, bill_no FROM public.hangtag_sales WHERE id = 'sc1'`);
  check('the cashier\'s bill is shop A\'s, made by the cashier, with the cashier\'s device number', !r.err && c && c.o === A && c.u === CA.id && c.bill_no === noC, r.err || c);
  const dupC = await saveBill(db, CA, bill('sc2', [{ ...TEE, q: 1 }], { no: noA1, t: day, dev: CA.dev }));
  check('the cashier can\'t take a number the owner\'s bill has', /already used/.test(dupC.err || ''), dupC.err);
  await as(db, A, `UPDATE public.hangtag_sales SET is_void = TRUE, void_reason = 'Wrong' WHERE id = 'sc1'`);
  check('a change by the owner keeps who made the bill', (await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_sales WHERE id = 'sc1'`)).u === CA.id);
  await as(db, CA, `INSERT INTO public.hangtag_cash_moves (id, type, amount, reason, t) VALUES ('cm1', 'opening', 500, 'Float', 1)`);
  await as(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('m9', 'tee:', 'tee', 'ADJUST', 1, 9)`);
  const cm = await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_cash_moves WHERE id = 'cm1'`), sm = await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_stock_moves WHERE id = 'm9'`);
  const rt = await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_returns WHERE id = 'r1'`);
  check('cash entries, stock records and returns note who made them', cm.u === CA.id && sm.u === A && rt.u === A, { cm, sm, rt });
  await asService(db, `INSERT INTO public.hangtag_cash_moves (owner_id, id, type, amount, reason, t, user_id) VALUES ($1, 'cm-svc', 'opening', 1, 'Server', 1, $2)`, [A, CA.id]);
  check('the server\'s functions keep what they set', (await one(db, A, `SELECT user_id::text AS u FROM public.hangtag_cash_moves WHERE id = 'cm-svc'`)).u === CA.id);
  const k = await saveBill(db, KA, bill('sk1', [{ ...TEE, q: 1 }], { no: nextDocNo('INV-', [], day, KA.dev), t: day, dev: KA.dev }));
  check('kitchen staff (no create_sale) can\'t save a bill, numbered or not', !!k.err && (await one(db, A, `SELECT count(*)::int n FROM public.hangtag_sales WHERE id = 'sk1'`)).n === 0, k.err);
  const bSees = await one(db, B, `SELECT count(*)::int n FROM public.hangtag_sales WHERE user_id = $1`, [A]);
  check('shop B sees none of shop A\'s bills', bSees.n === 0, bSees);
}

await db.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
if (fails) process.exit(1);
