// Tests for the Phase 1 database foundation (supabase/migrations/*.sql).
// Runs the migrations in a real Postgres (PGlite) with Supabase's roles, auth.uid() and default grants
// stubbed in, then checks every rule as signed-in users of two separate shops.
// Run: npm install && npm run test:db
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'migrations');
// (a migration for the live hangtag_* tables that needs schema.sql first is tested on top of it, in its own test)
const MIGRATIONS = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8')).filter((sql) => !/^-- Requires: supabase\/schema\.sql/m.test(sql));

// What a Supabase project provides before any migration runs
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT now());
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;
`;

// an unexpected error: show the database message, not the whole script it came from
process.on('uncaughtException', (e) => {
  console.error(`\nUNEXPECTED ERROR: ${e.message}${e.where ? `\n  ${e.where}` : ''}`);
  process.exit(1);
});

let passed = 0, failed = 0;
function check(name, ok, info) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '\n     ' + JSON.stringify(info) : ''));
}

const db = new PGlite();
await db.exec(SUPABASE);
for (const sql of MIGRATIONS) await db.exec(sql);

const A = { id: 'aaaaaaaa-0000-4000-8000-00000000000a' };
const B = { id: 'bbbbbbbb-0000-4000-8000-00000000000b' };
const C = { id: 'cccccccc-0000-4000-8000-00000000000c' };   // signed in, no shop yet
const ANON = null;
await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${A.id}','a@example.com'), ('${B.id}','b@example.com'), ('${C.id}','c@example.com')`);

// Run SQL as a user, in its own transaction (end-of-transaction checks run at COMMIT, like in Supabase)
async function as(user, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user ? user.id : '']);
    await tx.exec(`SET LOCAL ROLE ${user ? 'authenticated' : 'anon'}`);
    return (await tx.query(sql, params)).rows;
  });
}
const one = async (user, sql, params) => (await as(user, sql, params))[0];
async function error(user, sql, params) {
  try { await as(user, sql, params); return null; } catch (e) { return e.message; }
}
const refused = (msg, re) => msg !== null && (re ? re.test(msg) : true);
const num = (x) => Number(x);
const bill = (user, header, items) => one(user, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify(header), JSON.stringify(items)]);
const ret = (user, header, items) => one(user, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify(header), JSON.stringify(items)]);
const stock = async (user, vid) => num((await one(user, `SELECT on_hand FROM public.variant_catalog WHERE variant_id = $1`, [vid])).on_hand);

// ---------- migration ----------
check('migration runs a second time without errors (safe to re-run)', (await db.exec(MIGRATIONS.join('\n')).then(() => true, (e) => e.message)) === true);

// ---------- shops ----------
const shopA = await one(A, `INSERT INTO public.shops (name, gstin) VALUES ('Shop A', '27AAPFU0939F1ZV') RETURNING id, owner_id`);
const memberA = await one(A, `SELECT role FROM public.shop_members WHERE shop_id = $1`, [shopA.id]);
check('a user creates a shop and is added as its owner', shopA.owner_id === A.id && memberA?.role === 'owner');
const shopB = await one(B, `INSERT INTO public.shops (name, invoice_prefix) VALUES ('Shop B', 'SB') RETURNING id`);
const seenByB = await as(B, `SELECT id FROM public.shops`);
check('each user sees only their own shop', seenByB.length === 1 && seenByB[0].id === shopB.id);
check("can't create a shop owned by someone else",
  refused(await error(B, `INSERT INTO public.shops (name, owner_id) VALUES ('Fake', $1)`, [A.id]), /row-level security/));
check("can't change another user's shop",
  (await as(B, `UPDATE public.shops SET name = 'Taken' WHERE id = $1 RETURNING id`, [shopA.id])).length === 0);
check("can't add yourself to another shop",
  refused(await error(B, `INSERT INTO public.shop_members (shop_id, user_id, role) VALUES ($1, $2, 'owner')`, [shopA.id, B.id]), /permission denied/));
check('shop details are validated (GSTIN, PIN code, invoice prefix)',
  refused(await error(A, `UPDATE public.shops SET gstin = '27ABC' WHERE id = $1`, [shopA.id]), /shops_gstin_check/)
  && refused(await error(A, `UPDATE public.shops SET pincode = '01234' WHERE id = $1`, [shopA.id]), /shops_pincode_check/)
  && refused(await error(A, `UPDATE public.shops SET invoice_prefix = 'inv-2026' WHERE id = $1`, [shopA.id]), /shops_invoice_prefix_check/));

// ---------- products and variants ----------
const tee = await one(A, `INSERT INTO public.products (name, category, brand, price, cost_price, gst_rate, hsn)
  VALUES ('Oversized Tee', 'T-shirts', 'Hangtag', 599, 320, 5, '6109') RETURNING id, shop_id`);
check('shop_id fills itself in when the user has one shop', tee.shop_id === shopA.id);
const V = {};
for (const c of ['Black', 'White']) for (const s of ['S', 'M', 'L']) {
  const extra = c === 'White' && s === 'L' ? ', 649, 350' : ', NULL, NULL';
  const r = await one(A, `INSERT INTO public.product_variants (product_id, color, size, sku, barcode, price, cost_price)
    VALUES ($1, $2, $3, $4, $5${extra}) RETURNING id`, [tee.id, c, s, `TEE-${{ Black: 'BLK', White: 'WHT' }[c]}-${s}`, `89000${['Black', 'White'].indexOf(c) + 1}${'SML'.indexOf(s) + 1}`]);
  V[`${c}/${s}`] = r.id;
}
check('six colour + size variants created for one product', Object.keys(V).length === 6);
check('the same colour + size twice in a product is refused (Black = black)',
  refused(await error(A, `INSERT INTO public.product_variants (product_id, color, size) VALUES ($1, 'black', 'm')`, [tee.id]), /uq_product_variants_option/));
check('a SKU already used in the shop is refused (not case-sensitive)',
  refused(await error(A, `INSERT INTO public.product_variants (product_id, color, size, sku) VALUES ($1, 'Navy', 'S', 'tee-blk-s')`, [tee.id]), /uq_product_variants_sku/));
check('a barcode already used in the shop is refused',
  refused(await error(A, `INSERT INTO public.product_variants (product_id, color, size, barcode) VALUES ($1, 'Navy', 'S', '8900011')`, [tee.id]), /uq_product_variants_barcode/));
const teeB = await one(B, `INSERT INTO public.products (name, price) VALUES ('B Tee', 499) RETURNING id`);
const vB = await one(B, `INSERT INTO public.product_variants (product_id, color, size, sku, barcode) VALUES ($1, 'Black', 'S', 'TEE-BLK-S', '8900011') RETURNING id`, [teeB.id]);
check('another shop can use the same SKU and barcode', !!vB?.id);
check("a variant can't point at another shop's product (by its shop)",
  refused(await error(B, `INSERT INTO public.product_variants (product_id, color, size) VALUES ($1, 'Red', 'S')`, [tee.id]), /product_variants_product_fkey/));
check("a variant can't be put into another shop's rows",
  refused(await error(B, `INSERT INTO public.product_variants (shop_id, product_id, color, size) VALUES ($1, $2, 'Red', 'S')`, [shopA.id, tee.id]), /row-level security/));
check("another shop's products and variants are invisible",
  (await as(B, `SELECT 1 FROM public.products WHERE shop_id = $1 UNION ALL SELECT 1 FROM public.product_variants WHERE shop_id = $1`, [shopA.id])).length === 0);
check("another shop's products can't be changed or deleted",
  (await as(B, `UPDATE public.products SET price = 1 WHERE id = $1 RETURNING id`, [tee.id])).length === 0
  && (await as(B, `DELETE FROM public.products WHERE id = $1 RETURNING id`, [tee.id])).length === 0);
const cap = await one(A, `INSERT INTO public.products (name, price) VALUES ('Cap', 299) RETURNING id`);
check("a variant can't be moved to another product",
  refused(await error(A, `UPDATE public.product_variants SET product_id = $1 WHERE id = $2`, [cap.id, V['Black/S']]), /can't be moved/));
check('product values are validated (negative price, HSN, empty name)',
  refused(await error(A, `INSERT INTO public.products (name, price) VALUES ('X', -1)`), /products_price_check/)
  && refused(await error(A, `INSERT INTO public.products (name, hsn) VALUES ('X', '61')`), /products_hsn_check/)
  && refused(await error(A, `INSERT INTO public.products (name) VALUES ('  ')`), /products_name_check/));

// ---------- stock ledger ----------
const opening = { 'Black/S': 5, 'Black/M': 10, 'Black/L': 8, 'White/S': 4, 'White/M': 6, 'White/L': 3 };
for (const [k, q] of Object.entries(opening))
  await as(A, `INSERT INTO public.stock_movements (variant_id, movement_type, quantity) VALUES ($1, 'OPENING_STOCK', $2)`, [V[k], q]);
await as(A, `INSERT INTO public.stock_movements (variant_id, movement_type, quantity, unit_cost) VALUES ($1, 'STOCK_IN', 5, 300)`, [V['Black/M']]);
await as(A, `INSERT INTO public.stock_movements (variant_id, movement_type, quantity, reason, note) VALUES ($1, 'ADJUSTMENT', -1, 'Damaged', 'Torn seam')`, [V['Black/M']]);
check('stock = opening + stock in + adjustment (10 + 5 − 1 = 14)', (await stock(A, V['Black/M'])) === 14);
check('an adjustment needs a reason',
  refused(await error(A, `INSERT INTO public.stock_movements (variant_id, movement_type, quantity) VALUES ($1, 'ADJUSTMENT', -1)`, [V['Black/M']]), /stock_movements_type_check/));
check('stock in must be a positive number',
  refused(await error(A, `INSERT INTO public.stock_movements (variant_id, movement_type, quantity) VALUES ($1, 'STOCK_IN', -2)`, [V['Black/M']]), /stock_movements_type_check/));
check("the app can't write SALE, RETURN or CANCEL movements itself",
  refused(await error(A, `INSERT INTO public.stock_movements (variant_id, movement_type, quantity) VALUES ($1, 'SALE', -1)`, [V['Black/M']]), /row-level security/));
check("stock history can't be edited or deleted",
  refused(await error(A, `UPDATE public.stock_movements SET quantity = 100`), /permission denied/)
  && refused(await error(A, `DELETE FROM public.stock_movements`), /permission denied/));
check("stock can't be added to another shop's variant",
  refused(await error(B, `INSERT INTO public.stock_movements (variant_id, movement_type, quantity) VALUES ($1, 'STOCK_IN', 5)`, [V['Black/M']]), /stock_movements_variant_fkey/));
const wl = await one(A, `SELECT price, cost_price FROM public.variant_catalog WHERE variant_id = $1`, [V['White/L']]);
const bm = await one(A, `SELECT price, cost_price, gst_rate, hsn FROM public.variant_catalog WHERE variant_id = $1`, [V['Black/M']]);
check('variants use the product price and cost unless they have their own',
  num(bm.price) === 599 && num(bm.cost_price) === 320 && num(wl.price) === 649 && num(wl.cost_price) === 350 && num(bm.gst_rate) === 5 && bm.hsn === '6109', { bm, wl });

// ---------- customers ----------
const riya = await one(A, `INSERT INTO public.customers (name, mobile, email) VALUES ('Riya Sharma', '9876543210', 'riya@example.com') RETURNING id`);
check('the same mobile number twice in a shop is refused',
  refused(await error(A, `INSERT INTO public.customers (name, mobile) VALUES ('Riya S', '9876543210')`), /uq_customers_mobile/));
check('another shop can have a customer with the same mobile',
  !!(await one(B, `INSERT INTO public.customers (name, mobile) VALUES ('Riya', '9876543210') RETURNING id`))?.id);
check('customer GSTIN, mobile and email are validated',
  refused(await error(A, `INSERT INTO public.customers (name, gstin) VALUES ('Co', '12ABC')`), /customers_gstin_check/)
  && refused(await error(A, `INSERT INTO public.customers (name, mobile) VALUES ('Co', '98-765')`), /customers_mobile_check/)
  && refused(await error(A, `INSERT INTO public.customers (name, email) VALUES ('Co', 'not-an-email')`), /customers_email_check/));
const firm = await one(A, `INSERT INTO public.customers (name, gstin, customer_type) VALUES ('Mehta Traders', '27AAPFU0939F1ZV', 'business') RETURNING id`);
check('a business customer with a valid GSTIN is saved', !!firm?.id);

// ---------- bills ----------
// 2 × Black/M at 599 + 1 × White/L at its own price 649, prices include 5% GST
const b1 = await bill(A, {
  customer_id: riya.id, subtotal: 1847, taxable_amount: 1759.05, gst_amount: 87.95, total: 1847,
  payment_method: 'upi', billed_at: '2026-09-25T10:00:00Z',
}, [
  { variant_id: V['Black/M'], quantity: 2, gst_amount: 57.05 },
  { variant_id: V['White/L'], quantity: 1, gst_amount: 30.90 },
]);
check('bill numbered per shop and financial year: INV/26-27/0001', b1.bill_number === 'INV/26-27/0001', b1.bill_number);
check("customer's name and mobile copied onto the bill", b1.customer_name === 'Riya Sharma' && b1.customer_mobile === '9876543210');
const items1 = await as(A, `SELECT * FROM public.bill_items WHERE bill_id = $1 ORDER BY line_no`, [b1.id]);
check('bill items keep copies of product, colour, size, SKU, HSN, price, cost and GST rate',
  items1.length === 2 && items1[0].product_name === 'Oversized Tee' && items1[0].color === 'Black' && items1[0].size === 'M'
  && items1[0].sku === 'TEE-BLK-M' && items1[0].hsn === '6109' && num(items1[0].unit_price) === 599 && num(items1[0].cost_price) === 320
  && num(items1[0].gst_rate) === 5 && num(items1[0].line_total) === 1198
  && num(items1[1].unit_price) === 649 && num(items1[1].cost_price) === 350, items1);
const sales1 = await as(A, `SELECT quantity FROM public.stock_movements WHERE bill_id = $1 AND movement_type = 'SALE' ORDER BY quantity`, [b1.id]);
check('the bill took its pieces out of stock (SALE −2 and −1)', sales1.map((r) => r.quantity).join(',') === '-2,-1');
check('stock after the bill: Black/M 14 → 12, White/L 3 → 2', (await stock(A, V['Black/M'])) === 12 && (await stock(A, V['White/L'])) === 2);
const again = await bill(A, { id: b1.id, subtotal: 1847, taxable_amount: 1759.05, gst_amount: 87.95, total: 1847, payment_method: 'upi' },
  [{ variant_id: V['Black/M'], quantity: 2 }, { variant_id: V['White/L'], quantity: 1 }]);
const dup = await one(A, `SELECT (SELECT count(*) FROM public.bill_items WHERE bill_id = $1) AS items,
  (SELECT count(*) FROM public.stock_movements WHERE bill_id = $1) AS moves`, [b1.id]);
check('sending the same bill again returns it without saving it twice', again.bill_number === b1.bill_number && num(dup.items) === 2 && num(dup.moves) === 2);

check('a bill whose subtotal differs from its items is refused',
  refused(await error(A, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify({ subtotal: 999, taxable_amount: 951.43, gst_amount: 47.57, total: 999, payment_method: 'cash' }),
    JSON.stringify([{ variant_id: V['Black/S'], quantity: 1, gst_amount: 47.57 }])]), /subtotal is 999\.00 but its items add up to 599\.00/));
check('a bill whose GST differs from its items is refused',
  refused(await error(A, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify({ subtotal: 599, taxable_amount: 570.48, gst_amount: 28.52, total: 599, payment_method: 'cash' }),
    JSON.stringify([{ variant_id: V['Black/S'], quantity: 1 }])]), /GST is 28\.52 but its items add up to 0\.00/));
check("a bill whose total doesn't add up is refused",
  refused(await error(A, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify({ subtotal: 599, taxable_amount: 599, total: 500, payment_method: 'cash' }),
    JSON.stringify([{ variant_id: V['Black/S'], quantity: 1 }])]), /bills_amounts_check/));
check('a bill with no items is refused',
  refused(await error(A, `SELECT * FROM public.create_bill($1::jsonb, '[]'::jsonb)`, [JSON.stringify({ subtotal: 0, taxable_amount: 0, total: 0, payment_method: 'cash' })]), /at least one item/)
  && refused(await error(A, `INSERT INTO public.bills (subtotal, taxable_amount, total, payment_method) VALUES (0, 0, 0, 'cash')`), /has no items/));
check('items added to a saved bill later are refused (totals would no longer match)',
  refused(await error(A, `INSERT INTO public.bill_items (bill_id, line_no, variant_id, quantity) VALUES ($1, 3, $2, 1)`, [b1.id, V['Black/L']]), /subtotal is 1847\.00 but its items add up to 2446\.00/));
check('refused bills leave no stock change behind', (await stock(A, V['Black/S'])) === 5 && (await stock(A, V['Black/L'])) === 8);

// prices without GST, a price typed at the counter, and rounding: 550 + 5% = 577.50 → 578
const b2 = await bill(A, {
  subtotal: 550, taxable_amount: 550, gst_amount: 27.5, round_off: 0.5, total: 578, prices_include_gst: false,
  payment_method: 'cash', billed_at: '2026-09-25T11:00:00Z',
}, [{ variant_id: V['Black/S'], quantity: 1, unit_price: 550, gst_amount: 27.5 }]);
check('refused bills used no number: the next bill is INV/26-27/0002', b2.bill_number === 'INV/26-27/0002', b2.bill_number);
check('GST-exclusive bill with round-off saved (550 + 27.50 + 0.50 = 578)', num(b2.total) === 578);
const wsBill = (at) => bill(A, { subtotal: 599, taxable_amount: 570.48, gst_amount: 28.52, total: 599, payment_method: 'card', billed_at: at },
  [{ variant_id: V['White/S'], quantity: 1, gst_amount: 28.52 }]);
const b3 = await wsBill('2027-03-31T18:29:59Z');   // 31 March 2027, 11:59:59 pm in India
const b4 = await wsBill('2027-03-31T18:30:00Z');   // 1 April 2027, midnight in India
check('financial year changes at midnight on 1 April, India time (INV/26-27/0003 then INV/27-28/0001)',
  b3.bill_number === 'INV/26-27/0003' && b4.bill_number === 'INV/27-28/0001', [b3.bill_number, b4.bill_number]);
const bB = await bill(B, { subtotal: 499, taxable_amount: 499, total: 499, payment_method: 'cash' }, [{ variant_id: vB.id, quantity: 1 }]);
check("each shop has its own bill numbers and prefix (SB/…/0001)", /^SB\/\d{2}-\d{2}\/0001$/.test(bB.bill_number), bB.bill_number);
check('the same bill number twice in a shop is refused',
  refused(await error(A, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_number: 'INV/26-27/0001', subtotal: 599, taxable_amount: 599, total: 599, payment_method: 'cash' }),
    JSON.stringify([{ variant_id: V['Black/L'], quantity: 1 }])]), /bills_number_key/));
check('an unpaid bill may have no payment method, a paid one must have one',
  refused(await error(A, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify({ subtotal: 599, taxable_amount: 599, total: 599 }),
    JSON.stringify([{ variant_id: V['Black/L'], quantity: 1 }])]), /bills_payment_check/));

// ---------- old bills don't change ----------
await as(A, `UPDATE public.products SET name = 'Boxy Tee', price = 699, cost_price = 400 WHERE id = $1`, [tee.id]);
await as(A, `UPDATE public.product_variants SET sku = 'BOXY-BLK-M', color = 'Jet Black' WHERE id = $1`, [V['Black/M']]);
const kept = await one(A, `SELECT product_name, color, sku, unit_price, cost_price FROM public.bill_items WHERE bill_id = $1 AND line_no = 1`, [b1.id]);
check('editing the product, price, cost, colour and SKU later leaves the bill exactly as sold',
  kept.product_name === 'Oversized Tee' && kept.color === 'Black' && kept.sku === 'TEE-BLK-M' && num(kept.unit_price) === 599 && num(kept.cost_price) === 320, kept);
check("a saved bill's amounts, number and customer can't be edited",
  refused(await error(A, `UPDATE public.bills SET total = 1 WHERE id = $1`, [b1.id]), /can't be edited/)
  && refused(await error(A, `UPDATE public.bills SET bill_number = 'X' WHERE id = $1`, [b1.id]), /can't be edited/)
  && refused(await error(A, `UPDATE public.bills SET customer_name = 'Someone' WHERE id = $1`, [b1.id]), /can't be edited/));
check("bill items can't be edited and bills can't be deleted",
  refused(await error(A, `UPDATE public.bill_items SET quantity = 1`), /permission denied/)
  && refused(await error(A, `DELETE FROM public.bill_items`), /permission denied/)
  && refused(await error(A, `DELETE FROM public.bills`), /permission denied/));
const paid = await one(A, `UPDATE public.bills SET payment_status = 'partial', notes = 'Balance on Friday' WHERE id = $1 RETURNING payment_status, notes`, [b2.id]);
check('payment status and notes can still be updated', paid.payment_status === 'partial' && paid.notes === 'Balance on Friday');

// ---------- returns ----------
const lineBM = items1[0].id, lineWL = items1[1].id;
const r1 = await ret(A, { bill_id: b1.id, reason: 'Too small', refund_method: 'cash' }, [{ bill_item_id: lineBM, quantity: 1, amount: 599 }]);
check('a return saves with the refund defaulting to its value', num(r1.total_amount) === 599 && num(r1.refund_amount) === 599 && r1.refund_status === 'refunded' && !!r1.refunded_at);
check('returned piece goes back in stock (Black/M 12 → 13)', (await stock(A, V['Black/M'])) === 13);
check("can't return more pieces than were sold (2 sold, 1 already returned)",
  refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b1.id, refund_method: 'cash' }),
    JSON.stringify([{ bill_item_id: lineBM, quantity: 2, amount: 1198 }])]), /Can't return 2 of Oversized Tee \(Black \/ M\): 2 sold, 1 already returned/));
await ret(A, { bill_id: b1.id, refund_method: 'upi', reason: 'Stain' }, [{ bill_item_id: lineWL, quantity: 1, amount: 649, restock: false }]);
check("a damaged return marked not for resale doesn't go back in stock (White/L stays 2)", (await stock(A, V['White/L'])) === 2);
check("returns can't be worth more than the bill",
  refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b2.id, refund_method: 'cash' }),
    JSON.stringify([{ bill_item_id: (await one(A, `SELECT id FROM public.bill_items WHERE bill_id = $1`, [b2.id])).id, quantity: 1, amount: 600 }])]), /more than the bill total of 578\.00/));
check("an item from a different bill can't be returned against this bill",
  refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b2.id, refund_method: 'cash' }),
    JSON.stringify([{ bill_item_id: lineBM, quantity: 1, amount: 10 }])]), /isn't on the bill being returned/));
check('a return with no items, or a refund above its value, is refused',
  refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, '[]'::jsonb)`, [JSON.stringify({ bill_id: b2.id })]), /at least one item/)
  && refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b1.id, refund_amount: 700, refund_method: 'cash' }),
    JSON.stringify([{ bill_item_id: lineBM, quantity: 1, amount: 599 }])]), /returns_refund_check/));
check("a saved return's items and value can't be edited or deleted",
  refused(await error(A, `UPDATE public.return_items SET quantity = 2`), /permission denied/)
  && refused(await error(A, `DELETE FROM public.returns`), /permission denied/)
  && refused(await error(A, `UPDATE public.returns SET total_amount = 1 WHERE id = $1`, [r1.id]), /can't be edited/));

// exchange: the Black/S from bill 2 is swapped for a White/M on a new bill
// (the product now sells at 699 after the edit above)
const b5 = await bill(A, { subtotal: 699, taxable_amount: 665.71, gst_amount: 33.29, total: 699, payment_method: 'cash', notes: 'Exchange for INV/26-27/0002' },
  [{ variant_id: V['White/M'], quantity: 1, gst_amount: 33.29 }]);
const lineBS = (await one(A, `SELECT id FROM public.bill_items WHERE bill_id = $1`, [b2.id])).id;
const ex = await ret(A, { bill_id: b2.id, kind: 'exchange', exchange_bill_id: b5.id, reason: 'Wanted white' }, [{ bill_item_id: lineBS, quantity: 1, amount: 578 }]);
check('an exchange is a return linked to the new bill (no refund)', ex.kind === 'exchange' && ex.exchange_bill_id === b5.id && num(ex.refund_amount) === 0 && ex.refund_status === 'not_required');
check('exchange stock: Black/S back 4 → 5, White/M out 6 → 5', (await stock(A, V['Black/S'])) === 5 && (await stock(A, V['White/M'])) === 5);
check("an exchange can't point back at its own bill, and a plain return can't have an exchange bill",
  refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b4.id, kind: 'exchange', exchange_bill_id: b4.id }),
    JSON.stringify([{ bill_item_id: (await one(A, `SELECT id FROM public.bill_items WHERE bill_id = $1`, [b4.id])).id, quantity: 1, amount: 10 }])]), /returns_exchange_check/)
  && refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b4.id, exchange_bill_id: b5.id, refund_method: 'cash' }),
    JSON.stringify([{ bill_item_id: (await one(A, `SELECT id FROM public.bill_items WHERE bill_id = $1`, [b4.id])).id, quantity: 1, amount: 10 }])]), /returns_exchange_check/));

// ---------- cancelling ----------
check("a bill with returns can't be cancelled",
  refused(await error(A, `UPDATE public.bills SET status = 'cancelled' WHERE id = $1`, [b1.id]), /has returns, so it can't be cancelled/));
const before3 = await stock(A, V['White/S']);
const c3 = await one(A, `UPDATE public.bills SET status = 'cancelled', cancel_reason = 'Customer left' WHERE id = $1 RETURNING status, cancelled_at`, [b3.id]);
check('cancelling a bill puts its pieces back (White/S +1)', c3.status === 'cancelled' && !!c3.cancelled_at && (await stock(A, V['White/S'])) === before3 + 1);
await as(A, `UPDATE public.bills SET notes = 'Called customer' WHERE id = $1`, [b3.id]);
await as(A, `UPDATE public.bills SET status = 'cancelled' WHERE id = $1`, [b3.id]);
check('saving a cancelled bill again never puts stock back twice',
  num((await one(A, `SELECT count(*) AS n FROM public.stock_movements WHERE bill_id = $1 AND movement_type = 'CANCEL'`, [b3.id])).n) === 1
  && (await stock(A, V['White/S'])) === before3 + 1);
check("a cancelled bill can't be reopened",
  refused(await error(A, `UPDATE public.bills SET status = 'completed', cancelled_at = NULL WHERE id = $1`, [b3.id]), /can't be reopened/));
check("nothing can be added to or returned from a cancelled bill",
  refused(await error(A, `INSERT INTO public.bill_items (bill_id, line_no, variant_id, quantity) VALUES ($1, 2, $2, 1)`, [b3.id, V['White/S']]), /cancelled bill/)
  && refused(await error(A, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b3.id, refund_method: 'cash' }),
    JSON.stringify([{ bill_item_id: (await one(A, `SELECT id FROM public.bill_items WHERE bill_id = $1`, [b3.id])).id, quantity: 1, amount: 599 }])]), /is cancelled/));

// ---------- the ledger explains every piece ----------
// Black/M: 10 opening + 5 in − 1 damaged − 2 sold + 1 returned = 13
// White/S: 4 opening − 1 (bill 3) − 1 (bill 4) + 1 (bill 3 cancelled) = 3
const ledger = await as(A, `SELECT variant_id, movement_type, quantity FROM public.stock_movements ORDER BY created_at`);
const sum = (vid) => ledger.filter((m) => m.variant_id === vid).reduce((a, m) => a + m.quantity, 0);
check('final stock matches the hand count for every variant',
  (await stock(A, V['Black/M'])) === 13 && sum(V['Black/M']) === 13 && (await stock(A, V['White/S'])) === 3
  && (await stock(A, V['White/L'])) === 2 && (await stock(A, V['Black/S'])) === 5 && (await stock(A, V['White/M'])) === 5 && (await stock(A, V['Black/L'])) === 8);
check('every movement type is in the ledger',
  ['OPENING_STOCK', 'STOCK_IN', 'ADJUSTMENT', 'SALE', 'RETURN', 'CANCEL'].every((t) => ledger.some((m) => m.movement_type === t)));
const vs = await one(A, `SELECT on_hand FROM public.variant_stock WHERE variant_id = $1`, [V['Black/M']]);
check('variant_stock view gives the same number', num(vs.on_hand) === 13);

// ---------- deleting ----------
check("a product with stock or sales history can't be deleted (archive it instead)",
  refused(await error(A, `DELETE FROM public.products WHERE id = $1`, [tee.id]), /foreign key/));
await as(A, `UPDATE public.products SET is_archived = true WHERE id = $1`, [tee.id]);
check('archiving a product hides it from sale but keeps its stock',
  (await one(A, `SELECT bool_and(NOT is_sellable) AS hidden FROM public.variant_catalog WHERE product_id = $1`, [tee.id])).hidden === true && (await stock(A, V['Black/M'])) === 13);
await as(A, `INSERT INTO public.product_variants (product_id, color, size) VALUES ($1, 'Red', 'Free')`, [cap.id]);
const capGone = await as(A, `DELETE FROM public.products WHERE id = $1 RETURNING id`, [cap.id]);
check('a product with no history can be deleted, with its variants',
  capGone.length === 1 && (await as(A, `SELECT 1 FROM public.product_variants WHERE product_id = $1`, [cap.id])).length === 0);
await as(A, `DELETE FROM public.customers WHERE id = $1`, [riya.id]);
const afterCust = await one(A, `SELECT customer_id, customer_name FROM public.bills WHERE id = $1`, [b1.id]);
check("deleting a customer keeps their name on old bills", afterCust.customer_id === null && afterCust.customer_name === 'Riya Sharma');

// ---------- tenant isolation ----------
const tables = ['shops', 'shop_members', 'bill_counters', 'products', 'product_variants', 'customers', 'bills', 'bill_items', 'returns', 'return_items', 'stock_movements', 'variant_stock', 'variant_catalog'];
const leaks = [];
for (const t of tables) {
  const col = t === 'shops' ? 'id' : 'shop_id';
  const n = num((await one(B, `SELECT count(*) AS n FROM public.${t} WHERE ${col} = $1`, [shopA.id])).n);
  if (n) leaks.push(t);
}
check("shop B can't read a single row of shop A in any table or view", leaks.length === 0, leaks);
check("shop B can't create a bill in shop A",
  refused(await error(B, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify({ shop_id: shopA.id, subtotal: 599, taxable_amount: 599, total: 599, payment_method: 'cash' }),
    JSON.stringify([{ variant_id: V['Black/L'], quantity: 1 }])]), /don't have access to this shop/));
check("shop B can't sell shop A's variants on its own bill",
  refused(await error(B, `SELECT * FROM public.create_bill($1::jsonb, $2::jsonb)`, [JSON.stringify({ subtotal: 599, taxable_amount: 599, total: 599, payment_method: 'cash' }),
    JSON.stringify([{ variant_id: V['Black/L'], quantity: 1 }])]), /was not found in this shop/));
check("shop B can't return shop A's bill",
  refused(await error(B, `SELECT * FROM public.create_return($1::jsonb, $2::jsonb)`, [JSON.stringify({ bill_id: b2.id, refund_method: 'cash' }),
    JSON.stringify([{ bill_item_id: lineBS, quantity: 1, amount: 1 }])]), /was not found in this shop/));
check("shop B can't cancel or change shop A's bills",
  (await as(B, `UPDATE public.bills SET status = 'cancelled' WHERE id = $1 RETURNING id`, [b4.id])).length === 0);
const anonBlocked = [];
for (const t of tables) if (!refused(await error(ANON, `SELECT 1 FROM public.${t} LIMIT 1`), /permission denied/)) anonBlocked.push(t);
check('signed-out visitors can read nothing', anonBlocked.length === 0, anonBlocked);
check("signed-out visitors can't create bills or returns",
  refused(await error(ANON, `SELECT * FROM public.create_bill('{}'::jsonb, '[]'::jsonb)`), /permission denied/)
  && refused(await error(ANON, `SELECT * FROM public.create_return('{}'::jsonb, '[]'::jsonb)`), /permission denied/));
check("helper functions aren't callable from the API",
  refused(await error(A, `SELECT private.is_shop_member($1)`, [shopA.id]), /permission denied/));
check('a signed-in user with no shop sees nothing and can\'t add products',
  (await as(C, `SELECT 1 FROM public.products UNION ALL SELECT 1 FROM public.bills`)).length === 0
  && refused(await error(C, `INSERT INTO public.products (name) VALUES ('X')`), /row-level security|shop_id/));

// ---------- running the migration again keeps data ----------
const countsBefore = await db.query(`SELECT (SELECT count(*) FROM public.bills) b, (SELECT count(*) FROM public.stock_movements) m, (SELECT count(*) FROM public.returns) r`);
await db.exec(MIGRATIONS.join('\n'));
const countsAfter = await db.query(`SELECT (SELECT count(*) FROM public.bills) b, (SELECT count(*) FROM public.stock_movements) m, (SELECT count(*) FROM public.returns) r`);
check('running the migration again changes no data', JSON.stringify(countsBefore.rows) === JSON.stringify(countsAfter.rows));

// ---------- deleting an account removes its shop and nothing else ----------
const bRowsBefore = num((await one(B, `SELECT (SELECT count(*) FROM public.bills) + (SELECT count(*) FROM public.stock_movements) + (SELECT count(*) FROM public.products) AS n`)).n);
await db.exec(`DELETE FROM auth.users WHERE id = '${A.id}'`);
const leftA = await db.query(`SELECT (SELECT count(*) FROM public.shops WHERE owner_id = '${A.id}') + (SELECT count(*) FROM public.bills WHERE shop_id = '${shopA.id}')
  + (SELECT count(*) FROM public.stock_movements WHERE shop_id = '${shopA.id}') + (SELECT count(*) FROM public.products WHERE shop_id = '${shopA.id}') AS n`);
const bRowsAfter = num((await one(B, `SELECT (SELECT count(*) FROM public.bills) + (SELECT count(*) FROM public.stock_movements) + (SELECT count(*) FROM public.products) AS n`)).n);
check("deleting an account removes all of its shop's data, and nobody else's", num(leftA.rows[0].n) === 0 && bRowsAfter === bRowsBefore && bRowsBefore > 0);

await db.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
