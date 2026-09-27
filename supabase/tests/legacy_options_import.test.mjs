// Generic options + supplier bill imports (schema.sql section 3c), on PGlite with Supabase stand-ins.
// Upgrade from the colour + size version (fixtures/legacy/schema_v5.sql = what commit 324300d ships), fresh install,
// re-runs, the compat trigger, uniqueness, and the import RPC: happy path, safe retry, duplicates, atomicity, RLS.
// Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const V5 = fs.readFileSync(new URL('./fixtures/legacy/schema_v5.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id), provider text, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
`;
async function as(db, uid, sql, params) {
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
async function tryAs(db, uid, sql, params) { try { return { r: await as(db, uid, sql, params) }; } catch (e) { return { err: e.message, detail: e.detail }; } }
async function run(db, uid, sql) {
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.exec(sql); } finally { await db.exec('RESET ROLE'); }
}
const rows = async (db, uid, sql, params) => (await as(db, uid, sql, params)).rows;
async function fresh() {
  const db = new PGlite();
  await db.exec(SUPABASE);
  await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.in'), ($2, 'b@shop.in')`, [A, B]);
  return db;
}
const report = async (db) => (await db.query(NEW.slice(NEW.lastIndexOf('SELECT check_name')))).rows;

// ---------- upgrade from colour + size ----------
console.log('=== upgrade from the colour + size version ===');
{
  const db = await fresh();
  await db.exec(V5);
  await run(db, A, `
    INSERT INTO public.hangtag_products (id, name, price, options) VALUES
      ('tee','Tee',499,'{"colors":["Black","White"],"sizes":["S","M"]}'),
      ('jeans','Jeans',999,'{"colors":[],"sizes":["30","32"]}'),
      ('tote','Tote',399,'{"colors":[],"sizes":[]}'),
      ('bare','Bare',299,'{}');
    INSERT INTO public.hangtag_variants (id, product_id, color, size, sku, barcode, active) VALUES
      ('t1','tee','Black','S','T-B-S','4006381333931',true), ('t2','tee','White','M',null,null,true), ('t3','tee','Navy','M',null,null,true),
      ('j1','jeans','','30',null,null,true), ('j2','jeans','Blue','32',null,null,false),
      ('o1','tote','','','TOTE',null,true),
      ('b1','bare','Red','',null,null,true);
    INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('m1','t1','tee','OPENING',5,1);`);
  await db.exec(NEW);
  const v = Object.fromEntries((await db.query(`SELECT id, option_values, active FROM public.hangtag_variants`)).rows.map((r) => [r.id, r]));
  const p = Object.fromEntries((await db.query(`SELECT id, options FROM public.hangtag_products`)).rows.map((r) => [r.id, r.options]));
  check('colours then sizes become options (Colour, Size)', JSON.stringify(p.tee.opts) === JSON.stringify([{ name: 'Colour', values: ['Black', 'White', 'Navy'] }, { name: 'Size', values: ['S', 'M'] }]), p.tee);
  check('variant values in option order', JSON.stringify(v.t1.option_values) === '["Black","S"]' && v.t1.active);
  check('a colour for sale that the list missed is added (Navy)', JSON.stringify(v.t3.option_values) === '["Navy","M"]' && v.t3.active);
  check('sizes only → one Size option', JSON.stringify(p.jeans.opts) === JSON.stringify([{ name: 'Size', values: ['30', '32'] }]) && JSON.stringify(v.j1.option_values) === '["30"]');
  check('a leftover with a colour on a product without colours keeps its values, switched off', JSON.stringify(v.j2.option_values) === '["Blue","32"]' && v.j2.active === false);
  check('no colours or sizes → a simple product (no options, one variant with none)', JSON.stringify(p.tote.opts) === '[]' && JSON.stringify(v.o1.option_values) === '[]');
  check('a product with no lists takes its options from its variants for sale', JSON.stringify(p.bare.opts) === JSON.stringify([{ name: 'Colour', values: ['Red'] }]) && JSON.stringify(v.b1.option_values) === '["Red"]');
  check('compat copies of colours/sizes kept on the product', JSON.stringify(p.tee.colors) === '["Black","White","Navy"]');
  check('SKU, barcode and stock untouched', (await db.query(`SELECT sku, barcode FROM public.hangtag_variants WHERE id='t1'`)).rows[0].barcode === '4006381333931'
    && (await db.query(`SELECT sum(qty)::int AS q FROM public.hangtag_stock_moves WHERE variant_id='t1'`)).rows[0].q === 5);
  check('a safety copy of products and variants was made', (await db.query(`SELECT count(*)::int AS n FROM public.hangtag_backup_v3_variants`)).rows[0].n === 7);
  const rep = await report(db);
  check('migration report: every row ok', rep.length === 9 && rep.every((r) => r.ok), rep.map((r) => `${r.check_name}: ${r.value}/${r.expected}`));
  await db.exec(NEW);
  const again = (await db.query(`SELECT id, option_values, active FROM public.hangtag_variants ORDER BY id`)).rows;
  check('running the script again changes nothing', JSON.stringify(again.map((r) => [r.id, r.option_values, r.active])) === JSON.stringify(Object.values(v).sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, r.option_values, r.active])));
  check('the old colour + size unique rule is gone', !(await db.query(`SELECT 1 FROM pg_indexes WHERE indexname='uq_hangtag_variants_combo'`)).rows.length);
  await db.close();
}

// ---------- fresh install: options, trigger, uniqueness ----------
console.log('\n=== fresh install ===');
const db = await fresh();
await db.exec(NEW);
await db.exec(NEW);
check('the script runs twice on a fresh database', true);
await as(db, A, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('ph','Phone case',299,'{"opts":[{"name":"Model","values":["A15","S24"]},{"name":"Colour","values":["Blue"]}]}')`);
await as(db, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, sku, barcode) VALUES ('ph1','ph','["A15","Blue"]','PC-A15-BLU','2000000000015')`);
let r = await tryAs(db, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('ph2','ph','["a15","BLUE"]')`);
check('the same combination twice in one product is refused (any case)', /uq_hangtag_variants_options/.test(r.err || ''), r);
r = await tryAs(db, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, sku) VALUES ('ph3','ph','["S24","Blue"]','pc-a15-blu')`);
check('a duplicate SKU in the shop is refused (any case)', /uq_hangtag_variants_sku/.test(r.err || ''), r);
r = await tryAs(db, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, barcode) VALUES ('ph4','ph','["S24","Blue"]','2000000000015')`);
check('a duplicate barcode in the shop is refused', /uq_hangtag_variants_barcode/.test(r.err || ''), r);
await as(db, B, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('ph','Phone case',299,'{"opts":[{"name":"Model","values":["A15"]},{"name":"Colour","values":["Blue"]}]}')`);
r = await tryAs(db, B, `INSERT INTO public.hangtag_variants (id, product_id, option_values, sku, barcode) VALUES ('ph1','ph','["A15","Blue"]','PC-A15-BLU','2000000000015')`);
check('another shop may use the same SKU and barcode', !r.err, r);
await as(db, A, `INSERT INTO public.hangtag_variants (id, product_id, color, size) VALUES ('old1','ph','Red','XL')`);
check('an older app writing only colour/size gets option_values filled', JSON.stringify((await rows(db, A, `SELECT option_values FROM public.hangtag_variants WHERE id='old1'`))[0].option_values) === '["Red","XL"]');
r = await tryAs(db, A, `UPDATE public.hangtag_products SET hsn='62O4' WHERE id='ph'`);
check('HSN must be 4, 6 or 8 digits', /hsn_check/.test(r.err || ''), r);
r = await tryAs(db, A, `UPDATE public.hangtag_products SET gst_rate=120 WHERE id='ph'`);
check('GST rate must be 0–100', /gst_rate_check/.test(r.err || ''), r);
r = await tryAs(db, A, `UPDATE public.hangtag_products SET code_type='pdf417' WHERE id='ph'`);
check('code type is barcode or qr', /code_type_check/.test(r.err || ''), r);
r = await tryAs(db, A, `UPDATE public.hangtag_products SET hsn='620462', gst_rate=5, code_type='qr' WHERE id='ph'`);
check('valid HSN / GST / code type save', !r.err, r);

// ---------- import RPC ----------
console.log('\n=== supplier bill import ===');
const call = (uid, args, allow = false) => tryAs(db, uid, `SELECT public.hangtag_import_stock($1,$2,$3,$4,$5) AS res`,
  [JSON.stringify(args.imp), JSON.stringify(args.products || []), JSON.stringify(args.variants || []), JSON.stringify(args.moves || []), allow]);
const stock = async (uid, vid) => (await rows(db, uid, `SELECT COALESCE(sum(qty),0)::int AS q FROM public.hangtag_stock_moves WHERE variant_id=$1`, [vid]))[0].q;
const counts = async (uid) => (await rows(db, uid, `SELECT (SELECT count(*) FROM public.hangtag_products)::int p, (SELECT count(*) FROM public.hangtag_variants)::int v,
  (SELECT count(*) FROM public.hangtag_stock_moves)::int m, (SELECT count(*) FROM public.hangtag_stock_imports)::int i`))[0];
const dress = {
  imp: { id: 'imp1', file_hash: 'aaa', file_name: 'bill.pdf', file_type: 'application/pdf', supplier_name: 'Ravi Textiles', supplier_gstin: '27ABCDE1234F1Z5', invoice_no: 'INV-123', invoice_date: '2026-09-20', line_count: 3, amount: 11900, lines: [{ name: 'Dress' }] },
  products: [{ mode: 'insert', id: 'dr', name: 'Dress', price: 999, cost_price: 600, hsn: '6204', gst_rate: 5, options: { opts: [{ name: 'Colour', values: ['Black', 'White'] }, { name: 'Size', values: ['M'] }], colors: ['Black', 'White'], sizes: ['M'] } },
    { mode: 'update_options', id: 'ph', options: { opts: [{ name: 'Model', values: ['A15', 'S24'] }, { name: 'Colour', values: ['Blue', 'Red'] }] } }],
  variants: [{ id: 'drb', product_id: 'dr', option_values: ['Black', 'M'], color: 'Black', size: 'M', sku: 'DR-BLK-M' }, { id: 'drw', product_id: 'dr', option_values: ['White', 'M'], color: 'White', size: 'M' },
    { id: 'phr', product_id: 'ph', option_values: ['A15', 'Red'], color: 'Red' }],
  moves: [{ id: 'im1', variant_id: 'drb', product_id: 'dr', qty: 5, cost_price: 600, note: 'Supplier bill INV-123', t: 1 }, { id: 'im2', variant_id: 'drw', product_id: 'dr', qty: 3, t: 1 },
    { id: 'im3', variant_id: 'ph1', product_id: 'ph', qty: 7, t: 1 }, { id: 'im4', variant_id: 'phr', product_id: 'ph', qty: 2, t: 1 }],
};
r = await call(null, dress);
check('signed-out callers cannot import', !!r.err, r);
r = await call(A, dress);
const res = r.r && r.r.rows[0].res;
check('import: products, variants, moves and the import row in one call', res && res.status === 'imported' && res.products === 2 && res.variants === 3 && res.moves === 4 && res.units === 17, r);
check('stock added through RESTOCK moves tagged with the import', await stock(A, 'drb') === 5 && await stock(A, 'ph1') === 7
  && (await rows(db, A, `SELECT count(*)::int n FROM public.hangtag_stock_moves WHERE import_id='imp1' AND type='RESTOCK'`))[0].n === 4);
check('new product has HSN/GST from the bill', (await rows(db, A, `SELECT hsn, gst_rate::float g FROM public.hangtag_products WHERE id='dr'`))[0].g === 5);
check('an existing product got its new option value (update_options)', JSON.stringify((await rows(db, A, `SELECT options FROM public.hangtag_products WHERE id='ph'`))[0].options.opts[1].values) === '["Blue","Red"]');
const before = await counts(A);
r = await call(A, dress);
check('the same import again is a safe retry (nothing added)', r.r && r.r.rows[0].res.status === 'already_imported' && JSON.stringify(await counts(A)) === JSON.stringify(before), r);
r = await call(A, { imp: { ...dress.imp, id: 'imp2', invoice_no: 'X' }, moves: [{ id: 'dup1', variant_id: 'drb', product_id: 'dr', qty: 1 }] });
check('the same file again → HANGTAG_DUPLICATE_FILE with details', r.err === 'HANGTAG_DUPLICATE_FILE' && JSON.parse(r.detail).invoice_no === 'INV-123', r);
r = await call(A, { imp: { ...dress.imp, id: 'imp3', file_hash: 'bbb', invoice_no: ' inv-123 ', supplier_name: 'Other name' }, moves: [{ id: 'dup2', variant_id: 'drb', product_id: 'dr', qty: 1 }] });
check('same GSTIN + invoice number (any case/spaces) → HANGTAG_DUPLICATE_INVOICE', r.err === 'HANGTAG_DUPLICATE_INVOICE', r);
r = await call(A, { imp: { ...dress.imp, id: 'imp4', file_hash: 'ccc', supplier_gstin: null, supplier_name: 'Other Supplier' }, moves: [{ id: 'ok1', variant_id: 'drb', product_id: 'dr', qty: 1 }] });
check('same invoice number from another supplier is fine', r.r && r.r.rows[0].res.status === 'imported', r);
r = await call(A, { imp: { ...dress.imp, id: 'imp5' }, moves: [{ id: 'ok2', variant_id: 'drb', product_id: 'dr', qty: 2 }] }, true);
check('a repeat is allowed when the merchant confirms (allow duplicate)', r.r && r.r.rows[0].res.status === 'imported' && await stock(A, 'drb') === 8, r);

const snap = await counts(A);
r = await call(A, { imp: { id: 'bad1', file_hash: 'ddd' }, products: [{ mode: 'insert', id: 'np', name: 'New', price: 100 }],
  variants: [{ id: 'npv', product_id: 'np', option_values: [], sku: 'DR-BLK-M' }], moves: [{ id: 'bm1', variant_id: 'npv', product_id: 'np', qty: 1 }] });
check('a SKU clash in the middle undoes everything (no product, variant, move or import)', /uq_hangtag_variants_sku/.test(r.err || '') && JSON.stringify(await counts(A)) === JSON.stringify(snap), r);
r = await call(A, { imp: { id: 'bad2', file_hash: 'eee' }, products: [{ mode: 'insert', id: 'np', name: 'New', price: 100 }],
  variants: [{ id: 'npv', product_id: 'np', option_values: [] }], moves: [{ id: 'bm2', variant_id: 'npv', product_id: 'np', qty: 1 }, { id: 'bm3', variant_id: 'npv', product_id: 'np', qty: 0 }] });
check('a zero quantity anywhere undoes everything', /quantity/.test(r.err || '') && JSON.stringify(await counts(A)) === JSON.stringify(snap), r);
r = await call(A, { imp: { id: 'bad3', file_hash: 'fff' }, products: [{ mode: 'insert', id: 'np', name: 'New', price: 100, hsn: 'abc' }] });
check('an invalid HSN undoes everything', /hsn_check/.test(r.err || '') && JSON.stringify(await counts(A)) === JSON.stringify(snap), r);
r = await call(A, { imp: { id: 'bad4', file_hash: 'ggg' }, products: [{ mode: 'update_options', id: 'nope', options: {} }] });
check('updating a product that does not exist undoes everything', !!r.err && JSON.stringify(await counts(A)) === JSON.stringify(snap), r);

// ---------- isolation ----------
console.log('\n=== shop isolation ===');
check("B can't see A's imports", (await rows(db, B, `SELECT count(*)::int n FROM public.hangtag_stock_imports`))[0].n === 0);
check('anon is refused on imports', /permission denied/.test((await tryAs(db, null, `SELECT * FROM public.hangtag_stock_imports`)).err || ''));
r = await call(B, { imp: { id: 'x1', file_hash: 'aaa' }, moves: [{ id: 'bx', variant_id: 'drb', product_id: 'dr', qty: 50 }] });
check("B can't add stock to A's variant (it doesn't exist in B's shop)", !!r.err && await stock(A, 'drb') === 8, r);
r = await call(B, { imp: { id: 'x2' }, products: [{ mode: 'update_options', id: 'dr', options: { opts: [] } }] });
check("B can't change A's product options", !!r.err && (await rows(db, A, `SELECT options FROM public.hangtag_products WHERE id='dr'`))[0].options.opts.length === 2, r);
r = await call(B, { imp: { ...dress.imp, id: 'imp1' }, moves: [] });
check("A's file hash and invoice don't block B (duplicates are per shop)", r.r && r.r.rows[0].res.status === 'imported', r);
check('only the signed-in role may call the import', !(await db.query(`SELECT has_function_privilege('anon', 'public.hangtag_import_stock(jsonb,jsonb,jsonb,jsonb,boolean)', 'EXECUTE') AS x`)).rows[0].x);
const rep = await report(db);
check('report ok on the fresh database', rep.every((x) => x.ok), rep.map((x) => `${x.check_name}: ${x.value}/${x.expected}`));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
