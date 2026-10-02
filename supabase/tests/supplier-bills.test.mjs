// Supplier bills (schema.sql section 3p (c), with 3n): hangtag_import_stock adds a reviewed supplier bill's stock in one step
// — serial-tracked lines with one serial per piece (into the serial register), batch lines with their batch and expiry
// date (into the batches), decimal quantities as their unit allows — and keeps where the bill's original is (a path in the
// shop's own private folder). A bill with a supplier chosen is a purchase from them (lines, GST and stock agree); its
// original can be attached once, later, and never replaced. New products only with the capabilities they need; shop B
// never meets shop A's. PGlite with Supabase stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import crypto from 'crypto';

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
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message }; } };
const rows = async (db, who, sql, params) => (await as(db, who, sql, params)).rows;
const one = async (db, who, sql, params) => (await rows(db, who, sql, params))[0];
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');


const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]);
await db.exec(NEW); await db.exec(NEW);
// shop A keeps serials, batches with expiry and weights (its own choices); shop B is a plain retail shop
await as(db, A, `INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', '{"caps":{"uses_serials":true,"uses_batches":true,"uses_expiry":true,"uses_weight":true}}')`);
for (const o of [A, B]) {
  await as(db, o, `INSERT INTO public.hangtag_products (id, name, price, tracking, unit, tracks_expiry, options) VALUES ('ph', 'Phone', 9000, 'serial', 'pcs', false, '{"opts":[]}'),
    ('rice', 'Rice', 60, 'batch', 'kg', true, '{"opts":[]}'), ('cloth', 'Cloth', 120, 'none', 'm', false, '{"opts":[]}')`);
  await as(db, o, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('ph:', 'ph', '[]'), ('rice:', 'rice', '[]'), ('cloth:', 'cloth', '[]')`);
  await as(db, o, `INSERT INTO public.hangtag_suppliers (id, name, gstin) VALUES ('sup1', 'Ravi Traders', '27ABCDE1234F1Z5')`);
}
const T0 = 1790000000000;
const mv = (id, v, p, qty, extra = {}) => ({ id, variant_id: v, product_id: p, qty, cost_price: 100, t: T0, device_id: 'dev-a', ...extra });
const imp = (who, i, moves, { products = [], variants = [], dup = false } = {}) => tryAs(db, who, `SELECT public.hangtag_import_stock($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5) AS r`,
  [JSON.stringify(i), JSON.stringify(products), JSON.stringify(variants), JSON.stringify(moves), dup]);
const res = (r) => r.r && r.r.rows[0].r;
const count = async (who, t, where = '') => (await one(db, who, `SELECT count(*)::int AS n FROM public.${t} ${where}`)).n;
const snapshot = async () => [await count(A, 'hangtag_stock_imports'), await count(A, 'hangtag_stock_moves'), await count(A, 'hangtag_serials'), await count(A, 'hangtag_batches')].join('/');

console.log('=== a supplier bill with serial, batch and decimal lines, and its original ===');
{
  const r = await imp(A, { id: 'si1', file_hash: 'h1', file_name: 'bill.pdf', file_type: 'application/pdf', document_path: `${A}/si1.pdf`, supplier_name: 'Ravi Traders', invoice_no: 'RT-101', invoice_date: '2026-09-29', line_count: 3 }, [
    mv('si1:0', 'ph:', 'ph', 2, { serials: ['SN-001', 'SN-002'] }),
    mv('si1:1', 'rice:', 'rice', 2.5, { batch_no: 'b7', expiry: '2027-01-31' }),
    mv('si1:2', 'cloth:', 'cloth', 1.25),
  ]);
  check('saved in one step: 3 stock-in records, 5.75 units (decimals as the units allow)', res(r) && res(r).status === 'imported' && res(r).moves === 3 && +res(r).units === 5.75, r);
  const s1 = await one(db, A, `SELECT status, import_id FROM public.hangtag_serials WHERE serial = 'SN-001'`);
  check('the serials are in the register, in stock, from this bill', s1 && s1.status === 'IN_STOCK' && s1.import_id === 'si1', s1);
  const b = await one(db, A, `SELECT batch_no, expiry::text AS e FROM public.hangtag_batches WHERE variant_id = 'rice:'`);
  check('the batch (upper case) with its expiry date; 2.5 kg left in it', b && b.batch_no === 'B7' && b.e === '2027-01-31' && +(await db.query(`SELECT public.hangtag_batch_left($1, 'rice:', 'B7') AS n`, [A])).rows[0].n === 2.5, b);
  const d = await one(db, A, `SELECT document_path, kind FROM public.hangtag_stock_imports WHERE id = 'si1'`);
  check('the bill points at its original in the shop\'s own folder', d && d.document_path === `${A}/si1.pdf` && d.kind === 'import', d);
  const again = await imp(A, { id: 'si1', file_hash: 'h1' }, [mv('si1:0', 'ph:', 'ph', 2, { serials: ['SN-001', 'SN-002'] })]);
  check('the same bill sent again (a retry) changes nothing', res(again) && res(again).status === 'already_imported');
}

console.log('=== what is refused (nothing of it is kept) ===');
{
  const before = await snapshot();
  const cases = [
    ['a serial-tracked line without its serials', { id: 'x1' }, [mv('x1:0', 'ph:', 'ph', 1)], /serial-tracked line needs/],
    ['a serial-tracked line with fewer serials than pieces', { id: 'x2' }, [mv('x2:0', 'ph:', 'ph', 2, { serials: ['SN-100'] })], /serial|piece/i],
    ['a serial that is already in stock', { id: 'x3' }, [mv('x3:0', 'ph:', 'ph', 1, { serials: ['SN-001'] })], /SN-001|already|serial/i],
    ['a batch line without the expiry date this product keeps', { id: 'x4' }, [mv('x4:0', 'rice:', 'rice', 1, { batch_no: 'B8' })], /batch and expiry date/],
    ['a batch or expiry on a product not tracked by batch', { id: 'x5' }, [mv('x5:0', 'cloth:', 'cloth', 1, { batch_no: 'B1' })], /not tracked by serial or batch/],
    ['more decimals than the unit allows (1.255 m)', { id: 'x6' }, [mv('x6:0', 'cloth:', 'cloth', 1.255)], /decimal places/],
    ['the original in another shop\'s folder', { id: 'x7', document_path: `${B}/x7.pdf` }, [mv('x7:0', 'cloth:', 'cloth', 1)], /document_check|check/],
    ['the same file again (a likely repeat)', { id: 'x8', file_hash: 'h1' }, [mv('x8:0', 'cloth:', 'cloth', 1)], /HANGTAG_DUPLICATE_FILE/],
    ['the same supplier invoice again', { id: 'x9', invoice_no: 'rt-101', supplier_name: 'Ravi Traders' }, [mv('x9:0', 'cloth:', 'cloth', 1)], /HANGTAG_DUPLICATE_INVOICE/],
  ];
  for (const [name, i, moves, re] of cases) { const r = await imp(A, i, moves); check('refused: ' + name, !!r.err && re.test(r.err), r.err || res(r)); }
  check('…and nothing of any of them was kept', (await snapshot()) === before, { before, after: await snapshot() });
  const ok = await imp(A, { id: 'x8b', file_hash: 'h1' }, [mv('x8b:0', 'cloth:', 'cloth', 1)], { dup: true });
  check('a repeat the merchant confirms goes through', res(ok) && res(ok).status === 'imported', ok);
}

console.log('=== a supplier bill recorded as a purchase from the supplier ===');
{
  const lines = [{ p: 'ph', v: 'ph:', n: 'Phone', q: 1, cost: 8000, gst: 18, tx: 8000, tax: 1440, total: 9440 }, { p: 'rice', v: 'rice:', n: 'Rice', q: 10, cost: 50, gst: 5, tx: 500, tax: 25, total: 525 }];
  const P = { id: 'pb1', kind: 'purchase', supplier_id: 'sup1', invoice_no: 'RT-202', subtotal: 8500, tax_amount: 1465, total_amount: 9965, lines, t: T0 };
  const moves = [mv('pb1:0', 'ph:', 'ph', 1, { serials: ['SN-201'] }), mv('pb1:1', 'rice:', 'rice', 10, { batch_no: 'B9', expiry: '2027-03-31' })];
  let r = await imp(A, { ...P, total_amount: 9000 }, moves);
  check('lines, GST and total that don\'t add up are refused', !!r.err && /add up/.test(r.err), r);
  r = await imp(A, { ...P, supplier_id: 'nobody' }, moves);
  check('a supplier the shop doesn\'t have is refused', !!r.err && /supplier was not found/.test(r.err), r);
  r = await imp(A, P, moves);
  const row = await one(db, A, `SELECT kind, supplier_name, supplier_gstin, total_amount::float AS t, status, document_path FROM public.hangtag_stock_imports WHERE id = 'pb1'`);
  check('saved as a purchase from Ravi Traders (its GSTIN), with serials and batch in stock', res(r) && res(r).purchase === true && row.kind === 'purchase' && row.supplier_name === 'Ravi Traders'
    && row.supplier_gstin === '27ABCDE1234F1Z5' && row.t === 9965 && row.status === 'posted' && row.document_path === null
    && (await one(db, A, `SELECT status FROM public.hangtag_serials WHERE serial = 'SN-201'`)).status === 'IN_STOCK', { r, row });
  r = await tryAs(db, A, `UPDATE public.hangtag_stock_imports SET document_path = $1 WHERE id = 'pb1'`, [`${A}/pb1.jpg`]);
  check('its original, uploaded later (it couldn\'t reach the cloud at first), is attached once', !r.err && (await one(db, A, `SELECT document_path FROM public.hangtag_stock_imports WHERE id = 'pb1'`)).document_path === `${A}/pb1.jpg`, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_stock_imports SET document_path = $1 WHERE id = 'pb1'`, [`${A}/other.jpg`]);
  check('…and never replaced', !!r.err && /can't be replaced/.test(r.err), r);
  r = await tryAs(db, A, `UPDATE public.hangtag_stock_imports SET total_amount = 1 WHERE id = 'pb1'`);
  check('a saved purchase itself can\'t be changed', !!r.err, r);
  r = await imp(A, { id: 'pb2', kind: 'purchase', supplier_id: 'sup1', subtotal: 0, tax_amount: 0, total_amount: 0, lines: [] }, []);
  check('a purchase with no stock lines is refused (a plain import record is allowed, as before)', !!r.err && /no stock to add/.test(r.err), r);
}

console.log('=== capabilities and shops ===');
{
  const np = (id, tracking, extra = {}) => ({ id, name: 'New ' + id, price: 100, tracking, unit: 'pcs', options: { opts: [] }, ...extra });
  let r = await imp(B, { id: 'bx1' }, [mv('bx1:0', 'nv:', 'np1', 1, { serials: ['S1'] })], { products: [np('np1', 'serial')], variants: [{ id: 'nv:', product_id: 'np1', option_values: [] }] });
  check('a plain retail shop can\'t create a serial-tracked product from a bill (Serial tracking is off)', !!r.err && /Serial tracking is switched off/.test(r.err), r);
  r = await imp(B, { id: 'bx2' }, [mv('bx2:0', 'nv2:', 'np2', 1.5)], { products: [np('np2', 'none', { unit: 'kg' })], variants: [{ id: 'nv2:', product_id: 'np2', option_values: [] }] });
  check('…nor a product sold by weight (Weight is off)', !!r.err && /Weight-based products are switched off/.test(r.err), r);
  r = await imp(A, { id: 'ax1' }, [mv('ax1:0', 'nv:', 'np1', 1, { serials: ['NEW-1'] })], { products: [np('np1', 'serial')], variants: [{ id: 'nv:', product_id: 'np1', option_values: [] }] });
  check('shop A (serials on) can, and the serial goes into its register', res(r) && res(r).status === 'imported' && (await one(db, A, `SELECT status FROM public.hangtag_serials WHERE serial = 'NEW-1'`)).status === 'IN_STOCK', r);
  r = await imp(B, { id: 'si1', file_hash: 'h1', invoice_no: 'RT-101', supplier_name: 'Ravi Traders', document_path: `${B}/si1.pdf` }, [mv('bsi1:0', 'cloth:', 'cloth', 2)]);
  check('A\'s file, invoice and import id don\'t block B (its own folder, its own bill)', res(r) && res(r).status === 'imported', r);
  r = await imp(B, { id: 'bx3', document_path: `${A}/steal.pdf` }, [mv('bx3:0', 'cloth:', 'cloth', 1)]);
  check('B can\'t point a bill at A\'s folder', !!r.err, r);
  check('B sees none of A\'s imports, serials or batches', (await count(B, 'hangtag_stock_imports', `WHERE owner_id = '${A}'`)) === 0 && (await count(B, 'hangtag_serials', `WHERE owner_id = '${A}'`)) === 0
    && (await count(B, 'hangtag_batches', `WHERE owner_id = '${A}'`)) === 0);
  r = await imp(null, { id: 'anon1' }, [mv('anon1:0', 'cloth:', 'cloth', 1)]);
  check('signed out: nothing', !!r.err, r);
  const rep = await report(db);
  check('the migration report: every row ok (incl. bill originals in the shop\'s own folder)', rep.length === 52 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
