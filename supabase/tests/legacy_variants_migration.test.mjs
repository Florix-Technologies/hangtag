import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const V1 = fs.readFileSync(new URL('./fixtures/legacy/schema_v1.sql', import.meta.url), 'utf8');
const V4 = fs.readFileSync(new URL('./fixtures/legacy/schema_v4.sql', import.meta.url), 'utf8');   // the version on the live database now
const LINE_NO = `ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_sale_items_line ON public.hangtag_sale_items(sale_id, line_no);`;
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); };
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
// what the live database holds before this upgrade: sizes with received counts, bills with lines
const LEGACY = `
INSERT INTO public.hangtag_products (id, name, price, sort_order) VALUES ('p1','Oversized Tee – Black',599,0), ('p2','Oversized Tee – White',599,1), ('p3','Tote Bag',399,2);
INSERT INTO public.hangtag_sizes (product_id, size, stock) VALUES ('p1','S',10),('p1','M',10),('p1','XL',10),('p1','L',10),('p2','S',8),('p2','M',8);
INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s1', 1790000000000, 4193, 4193, 'cash'), ('s2', 1790000100000, 599, 599, 'upi');
INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price) VALUES
 ('s1',0,'p1','Oversized Tee – Black','XL',6,599), ('s1',1,'p2','Oversized Tee – White','M',1,599), ('s2',0,'p1','Oversized Tee – Black','L',1,599);
`;
async function as(db, uid, sql, params) {
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
async function tryAs(db, uid, sql, params) { try { return { r: await as(db, uid, sql, params) }; } catch (e) { return { err: e.message }; } }
const q1 = async (db, uid, sql) => (await as(db, uid, sql)).rows;
async function stockSQL(db, uid, vid) {
  const r = await as(db, uid, `SELECT
     COALESCE((SELECT sum(qty) FROM public.hangtag_stock_moves WHERE variant_id=$1),0)
   - COALESCE((SELECT sum(i.quantity) FROM public.hangtag_sale_items i JOIN public.hangtag_sales s ON s.owner_id=i.owner_id AND s.id=i.sale_id WHERE i.variant_id=$1 AND NOT s.is_void),0)
   + COALESCE((SELECT sum(quantity) FROM public.hangtag_return_items WHERE variant_id=$1),0) AS n`, [vid]);
  return Number(r.rows[0].n);
}
async function lastResult(db, sql) { const res = await db.exec(sql); return res[res.length - 1]; }

(async () => {
  console.log('=== upgrade the live-shaped database to variants ===');
  const db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(V1); await db.exec(LINE_NO); await db.exec(LEGACY);
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${A}','florixenergy@gmail.com'), ('${B}','other@gmail.com')`);
  await db.exec(`INSERT INTO auth.identities (user_id, provider, email) VALUES ('${A}','google','florixenergy@gmail.com'), ('${B}','email','other@gmail.com')`);
  await db.exec(V4);   // the per-account version (already on your database)
  const rep1 = await lastResult(db, NEW);
  check('upgrade runs', true);
  const bad1 = rep1.rows.filter(r => !r.ok);
  check('migration report: every check ok', rep1.rows.length === 64 && !bad1.length, rep1.rows.map(r => `${r.check_name}: ${r.value}/${r.expected}`));
  const rep2 = await lastResult(db, NEW);
  check('runs a second time with the same report (safe to re-run)', JSON.stringify(rep2.rows) === JSON.stringify(rep1.rows));
  const bk = (await db.query(`SELECT (SELECT count(*) FROM public.hangtag_backup_v2_sizes)::int s, (SELECT count(*) FROM public.hangtag_backup_v2_sale_items)::int i`)).rows[0];
  check('backup copy made before changes', bk.s === 6 && bk.i === 3, bk);
  const r = await tryAs(db, A, `SELECT * FROM public.hangtag_backup_v2_sales`);
  check('backup copy not readable through the app', !!r.err || r.r.rows.length === 0, r.err);

  const vars = await q1(db, A, `SELECT id, product_id, color, size FROM public.hangtag_variants ORDER BY id`);
  check('each old size became a variant with a fixed id', JSON.stringify(vars.map(v => v.id)) === JSON.stringify(['p1:L','p1:M','p1:S','p1:XL','p2:M','p2:S','p3:']), vars.map(v => v.id));
  const opt = await q1(db, A, `SELECT id, options FROM public.hangtag_products ORDER BY id`);
  check('size order kept (S, M, L, XL)', JSON.stringify(opt[0].options.sizes) === '["S","M","L","XL"]', opt[0].options);
  check('product without sizes gets one plain variant', vars.some(v => v.id === 'p3:' && v.size === ''));
  // stock in hand identical to the old system: received - sold
  const bxl = await stockSQL(db, A, 'p1:XL'), bl = await stockSQL(db, A, 'p1:L'), wm = await stockSQL(db, A, 'p2:M');
  check('stock kept exactly: Black XL 10 received − 6 sold = 4', bxl === 4, bxl);
  check('stock kept exactly: Black L 10 − 1 = 9, White M 8 − 1 = 7', bl === 9 && wm === 7, { bl, wm });
  const lines = await q1(db, A, `SELECT sale_id, line_no, variant_id, product_name, size, unit_price FROM public.hangtag_sale_items ORDER BY sale_id, line_no`);
  check('old bill lines point at their variant', lines.every(l => l.variant_id === (l.sale_id === 's1' && l.line_no === 1 ? 'p2:M' : l.sale_id === 's1' ? 'p1:XL' : 'p1:L')), lines);
  check('old bill text and prices untouched', lines[0].product_name === 'Oversized Tee – Black' && lines[0].size === 'XL' && lines[0].unit_price === 599);

  // ---- new model, as the app writes it ----
  let x = await tryAs(db, A, `INSERT INTO public.hangtag_variants (id, product_id, color, size, sku, barcode) VALUES ('va1','p1','Navy','M','OT-NVY-M','8901234567890')`);
  check('owner adds a new colour variant with SKU and barcode', !x.err, x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_variants (id, product_id, color, size, sku) VALUES ('va2','p1','Navy','L','ot-nvy-m')`);
  check('SKU must be unique within a shop (any letter case)', !!x.err, x.err && x.err.slice(0, 70));
  x = await tryAs(db, A, `INSERT INTO public.hangtag_variants (id, product_id, color, size, barcode) VALUES ('va3','p1','Navy','XL','8901234567890')`);
  check('barcode must be unique within a shop', !!x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_variants (id, product_id, color, size) VALUES ('va4','p1','Navy','M')`);
  check('same colour + size can\'t be added twice', !!x.err);
  await as(db, B, `INSERT INTO public.hangtag_products (id, name, price) VALUES ('p1','B shirt',100)`);
  x = await tryAs(db, B, `INSERT INTO public.hangtag_variants (id, product_id, color, size, sku, barcode) VALUES ('va1','p1','Navy','M','OT-NVY-M','8901234567890')`);
  check('another shop can use the same SKU, barcode and ids', !x.err, x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, cost_price, note, t) VALUES ('m1','va1','p1','RESTOCK',50,320,'Supplier invoice 12',1790000200000)`);
  check('stock in recorded with cost and note', !x.err, x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, note, t) VALUES ('m2','va1','p1','ADJUST',-1,'Physical count correction',1790000300000)`);
  check('adjustment recorded with reason', !x.err, x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('m3','va1','p1','SALE',-1,1)`);
  check('unknown stock record types refused', !!x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('m4','nope','p1','RESTOCK',5,1)`);
  check('stock record must point at a real variant', !!x.err);
  check('Navy M stock = 50 − 1 = 49', (await stockSQL(db, A, 'va1')) === 49);
  // a sale of new-model lines with snapshots
  x = await tryAs(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method, bill_no, customer_id, customer_name, tax_rate, tax_amount, tax_inclusive, kind) VALUES ('s3',1790000400000,1797,1797,'upi','INV-260925-001','c1','Riya',5,86,true,'sale')`);
  check('bill with number, customer and GST saved', !x.err, x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, variant_id, product_name, color, size, sku, quantity, unit_price, cost_price) VALUES ('s3',0,'p1','va1','Oversized Tee','Navy','M','OT-NVY-M',2,599,320), ('s3',1,'p1','p1:L','Oversized Tee','','L',null,1,599,null)`);
  check('bill lines with variant, colour, SKU and cost saved', !x.err, x.err);
  check('sale lowers only that variant: Navy M 49 − 2 = 47, Black L 9 − 1 = 8', (await stockSQL(db, A, 'va1')) === 47 && (await stockSQL(db, A, 'p1:L')) === 8);
  // customers
  x = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1','Riya','9876543210')`);
  check('customer saved', !x.err, x.err);
  // returns
  x = await tryAs(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, kind, refund_amount, refund_method, value) VALUES ('r1','s3',1790000500000,'return',599,'cash',599)`);
  const ri = await tryAs(db, A, `INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_id, product_name, color, size, quantity, unit_price, value) VALUES ('r1',0,'s3',0,'va1','p1','Oversized Tee','Navy','M',1,599,599)`);
  check('return of 1 of 2 accepted', !x.err && !ri.err, x.err || ri.err);
  check('return puts exactly that variant back: Navy M 47 + 1 = 48', (await stockSQL(db, A, 'va1')) === 48);
  await as(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, value) VALUES ('r2','s3',1790000600000,1198)`);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_name, quantity) VALUES ('r2',0,'s3',0,'va1','Oversized Tee',2)`);
  check('returning more than bought is refused by the database (1 bought left, 2 asked)', !!x.err, x.err && x.err.slice(0, 80));
  x = await tryAs(db, A, `INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_name, quantity) VALUES ('r2',0,'s3',0,'va1','Oversized Tee',1)`);
  check('the last piece can still be returned', !x.err, x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_name, quantity) VALUES ('r2',1,'s3',9,'va1','Oversized Tee',1)`);
  check('return must match a real bill line', !!x.err);
  x = await tryAs(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t) VALUES ('r3','nope',1)`);
  check('return must point at a real bill', !!x.err);
  // exchange: return Black L, sell Black XL
  await as(db, A, `INSERT INTO public.hangtag_returns (id, sale_id, t, kind, exchange_id, value) VALUES ('r4','s2',1790000700000,'exchange','x1',599)`);
  await as(db, A, `INSERT INTO public.hangtag_return_items (return_id, line_no, sale_id, sale_line_no, variant_id, product_name, size, quantity, unit_price, value) VALUES ('r4',0,'s2',0,'p1:L','Oversized Tee – Black','L',1,599,599)`);
  await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method, kind, exchange_id, credit) VALUES ('s4',1790000700001,599,599,'cash','exchange','x1',599)`);
  await as(db, A, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, variant_id, product_name, size, quantity, unit_price) VALUES ('s4',0,'p1','p1:XL','Oversized Tee','XL',1,599)`);
  check('exchange: Black L +1 (8→9), Black XL −1 (4→3)', (await stockSQL(db, A, 'p1:L')) === 9 && (await stockSQL(db, A, 'p1:XL')) === 3);
  // price change doesn't change old bills
  await as(db, A, `UPDATE public.hangtag_products SET price = 699 WHERE id = 'p1'`);
  await as(db, A, `UPDATE public.hangtag_variants SET price = 749, cost_price = 400 WHERE id = 'va1'`);
  const s3 = await q1(db, A, `SELECT unit_price, cost_price FROM public.hangtag_sale_items WHERE sale_id='s3' AND line_no=0`);
  check('editing price and cost leaves bill lines as sold (₹599, cost ₹320)', s3[0].unit_price === 599 && s3[0].cost_price === 320);

  // ---- isolation ----
  for (const t of ['hangtag_variants','hangtag_stock_moves','hangtag_customers','hangtag_returns','hangtag_return_items']) {
    const nB = (await q1(db, B, `SELECT count(*)::int n FROM public.${t}`))[0].n;
    const own = t === 'hangtag_variants' ? 1 : 0;
    check(`${t}: the other shop sees only its own rows`, nB === own, nB);
    const anon = await tryAs(db, null, `SELECT * FROM public.${t}`);
    check(`${t}: signed-out visitors refused`, !!anon.err);
  }
  x = await tryAs(db, B, `INSERT INTO public.hangtag_stock_moves (owner_id, id, variant_id, type, qty, t) VALUES ('${A}','evil','va1','RESTOCK',999,1)`);
  check("can't write stock into another shop", !!x.err);
  x = await tryAs(db, B, `INSERT INTO public.hangtag_returns (id, sale_id, t) VALUES ('rb','s3',1)`);
  check("can't return another shop's bill", !!x.err);
  x = await tryAs(db, B, `UPDATE public.hangtag_variants SET price=1 WHERE owner_id='${A}'`);
  check("can't change another shop's variants", !x.err && x.r.affectedRows === 0);
  // ---- delete cascade (only used for products that never sold) ----
  await as(db, A, `INSERT INTO public.hangtag_products (id, name, price) VALUES ('p9','Temp',1)`);
  await as(db, A, `INSERT INTO public.hangtag_variants (id, product_id, size) VALUES ('p9:M','p9','M')`);
  await as(db, A, `INSERT INTO public.hangtag_stock_moves (id, variant_id, type, qty, t) VALUES ('open:p9:M','p9:M','OPENING',5,1)`);
  await as(db, A, `DELETE FROM public.hangtag_products WHERE id='p9'`);
  const left = await q1(db, A, `SELECT (SELECT count(*) FROM public.hangtag_variants WHERE product_id='p9')::int v, (SELECT count(*) FROM public.hangtag_stock_moves WHERE variant_id='p9:M')::int m`);
  check('deleting a never-sold product removes its variants and stock records', left[0].v === 0 && left[0].m === 0, left[0]);
  // realtime publication list covers the new tables (if the publication exists here)
  await db.close();

  console.log('\n=== fresh install ===');
  const f = new PGlite(); await f.exec(SUPABASE);
  await f.exec(`INSERT INTO auth.users (id, email) VALUES ('${A}','florixenergy@gmail.com')`);
  const fr = await lastResult(f, NEW);
  check('fresh install runs, report all ok', fr.rows.every(r => r.ok), fr.rows.map(r => r.check_name + ': ' + r.value + '/' + r.expected));
  x = await tryAs(f, A, `INSERT INTO public.hangtag_products (id, name, price, category, brand, cost_price, archived, options) VALUES ('p1','Tee',599,'T-shirts','Own',300,false,'{"colors":["Black"],"sizes":["M"]}')`);
  check('product with category, brand, cost, archive and options', !x.err, x.err);
  await f.close();

  // "Combine colours" (products/components/colour-groups.js) keeps variant ids: p2's sizes move under p1 as White and p2
  // is removed. The report must still count those old sizes as migrated (it happened on the live database: 319 vs 314).
  console.log('\n=== after "Combine colours" merged two migrated products ===');
  const g = new PGlite(); await g.exec(SUPABASE);
  await g.exec(V1); await g.exec(LINE_NO); await g.exec(LEGACY);
  await g.exec(`INSERT INTO auth.users (id, email) VALUES ('${A}','florixenergy@gmail.com')`);
  await g.exec(`INSERT INTO auth.identities (user_id, provider, email) VALUES ('${A}','google','florixenergy@gmail.com')`);
  await g.exec(V4); await g.exec(NEW);
  await as(g, A, `UPDATE public.hangtag_variants SET option_values = jsonb_build_array('Black', size) WHERE product_id = 'p1'`);
  await as(g, A, `UPDATE public.hangtag_variants SET product_id = 'p1', option_values = jsonb_build_array('White', size) WHERE product_id = 'p2'`);
  await as(g, A, `UPDATE public.hangtag_stock_moves SET product_id = 'p1' WHERE product_id = 'p2'`);
  await as(g, A, `UPDATE public.hangtag_products SET name = 'Oversized Tee', options = '{"opts":[{"name":"Colour","values":["Black","White"]},{"name":"Size","values":["S","M","L","XL"]}]}' WHERE id = 'p1'`);
  await as(g, A, `DELETE FROM public.hangtag_products WHERE id = 'p2'`);
  const REPORT = NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '');
  const row2 = async () => (await g.query(REPORT)).rows.find((r) => r.check_name === 'Old sizes that became variants');
  const oldExpected = (await g.query(`SELECT count(*)::int n FROM public.hangtag_backup_v2_sizes b WHERE EXISTS (SELECT 1 FROM public.hangtag_products p WHERE p.owner_id = b.owner_id AND p.id = b.product_id)`)).rows[0].n;
  check('the old check would have failed here (6 old sizes, only 4 still under their first product)', oldExpected === 4, oldExpected);
  const rep3 = await lastResult(g, NEW);
  check('after the merge the script still runs and every report row is ok (old sizes 6/6)', rep3.rows.every((r) => r.ok) && Number((await row2()).value) === 6,
    rep3.rows.map((r) => `${r.check_name}: ${r.value}/${r.expected}`));
  await as(g, A, `DELETE FROM public.hangtag_variants WHERE id = 'p1:S'`);
  const r2 = await row2();
  check('a size of a product that is still there without its variant still fails the check (5/6)', Number(r2.value) === 5 && Number(r2.expected) === 6 && r2.ok === false, r2);
  await g.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})();
