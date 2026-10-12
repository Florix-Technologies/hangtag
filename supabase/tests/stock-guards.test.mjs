// Stock and catalog write guards (schema.sql section 3za, migration 20261013120000; PLAN.md I2 and I3): a new serial number
// taken back only from a write-off, never from another device's insert; supplier bills locked on their file and invoice
// number; field values kept on products made from a bill; updated_at kept by the database; a product's unit kept once it
// has history. PGlite runs one session, so the races themselves can't run here: the guards are checked in the functions'
// text (report row 94 does the same on a live database), and every path one device takes is run.
// Run: node supabase/tests/stock-guards.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { REPORT_ROWS } from './report-rows.mjs';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const A = 'eeeeeeee-0000-0000-0000-000000000001';
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
const db = new PGlite();
async function as(q, params) {
  await db.exec('SET ROLE authenticated');
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [A, JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(q, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (q, params) => { try { return { r: await as(q, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const one = async (q, params) => (await as(q, params)).rows[0];
const refused = (r, re) => !!r.err && re.test(r.err);
const report = async () => (await db.query(NEW.slice(NEW.lastIndexOf('SELECT check_name')))).rows;
const fn = async (name) => (await db.query(`SELECT pg_get_functiondef(p.oid) d FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1`, [name])).rows[0].d;

await db.exec(SUPABASE);
await db.exec(NEW);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.test')`, [A]);
await db.query(`SELECT public.hangtag_subscription_ensure($1)`, [A]);
await as(`INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', '{"caps":{"uses_serials":true,"uses_weight":true},"capsAt":1}'::jsonb)
  ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`);

console.log('=== the report ===');
let rep = await report();
check('report: all rows ok, with 94 (serials and supplier bills) and 95 (updated_at and the unit kept)', rep.length === REPORT_ROWS && rep.every((x) => x.ok)
  && rep.some((x) => /^A new serial number can't take one/.test(x.check_name) && x.ok) && rep.some((x) => /^Products and variants keep the database's updated_at/.test(x.check_name) && x.ok), rep.filter((x) => !x.ok));

console.log('=== serial numbers ===');
const track = await fn('hangtag_track_move');
check('a new serial\'s insert takes the row only from a write-off, and is refused when it wrote nothing (another device\'s insert won)',
  /ON CONFLICT \(owner_id, serial\) DO UPDATE[\s\S]*WHERE x\.status IN \('DAMAGED','CANCELLED'\);/.test(track) && /GET DIAGNOSTICS n = ROW_COUNT;\s*IF n = 0 THEN RAISE EXCEPTION 'Serial % is already in stock\.'/.test(track));
await as(`INSERT INTO public.hangtag_products (id, name, price, tracking, unit, options) VALUES ('ph', 'Phone', 9000, 'serial', 'pcs', '{"opts":[]}')`);
await as(`INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('ph:', 'ph', '[]')`);
const move = (id, qty, sn) => tryAs(`INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t, serials) VALUES ($1, 'ph:', 'ph', $2, $3, 1, $4)`,
  [id, qty > 0 ? 'RESTOCK' : 'ADJUST', qty, sn]);
const sn = () => one(`SELECT status, move_id FROM public.hangtag_serials WHERE serial = 'SN1'`);
let r = await move('m1', 1, ['SN1']);
check('a new serial goes into the register', !r.err && (await sn()).status === 'IN_STOCK', r);
r = await move('m2', 1, ['SN1']);
check('…the same serial again is refused (in stock)', refused(r, /Serial SN1 is already in stock/), r);
r = await move('m3', -1, ['SN1']);
check('written off (damaged)', !r.err && (await sn()).status === 'DAMAGED', r);
r = await move('m4', 1, ['SN1']);
const back = await sn();
check('…and found again: back in stock, from the new record', !r.err && back.status === 'IN_STOCK' && back.move_id === 'm4', { r, back });

console.log('=== supplier bills ===');
const imp = await fn('hangtag_import_stock');
check('a bill locks on its file, then its invoice number, before its duplicate check',
  /pg_advisory_xact_lock\(hashtextextended\('hangtag_import_file\|'/.test(imp) && /pg_advisory_xact_lock\(hashtextextended\('hangtag_import_invoice\|'/.test(imp)
  && imp.indexOf('hangtag_import_file|') < imp.indexOf('hangtag_import_invoice|') && imp.indexOf('hangtag_import_invoice|') < imp.indexOf('HANGTAG_DUPLICATE_FILE'));
await as(`INSERT INTO public.hangtag_attributes (id, name, type) VALUES ('mat', 'Material', 'text')`);
const bill = (id, hash, inv, products, moves, again = false) => tryAs(`SELECT public.hangtag_import_stock($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, $5) AS r`,
  [JSON.stringify({ id, file_hash: hash, file_name: id + '.pdf', file_type: 'application/pdf', supplier_name: 'Loom House', invoice_no: inv, line_count: 1 }),
    JSON.stringify(products), JSON.stringify(products.map((p) => ({ id: p.id + ':', product_id: p.id, option_values: [] }))), JSON.stringify(moves), again]);
r = await bill('b1', 'h1', 'INV-1', [{ id: 'tote', name: 'Tote', price: 300, unit: 'pcs', options: { opts: [] }, attrs: { mat: 'Jute' } }], [{ id: 'b1:0', variant_id: 'tote:', product_id: 'tote', qty: 5, cost_price: 120, t: 1 }]);
check('a bill that makes a product keeps its field values (attrs)', !r.err && r.r.rows[0].r.status === 'imported'
  && JSON.stringify((await one(`SELECT attrs FROM public.hangtag_products WHERE id = 'tote'`)).attrs) === '{"mat":"Jute"}', r);
r = await bill('b2', 'h1', 'INV-2', [], [{ id: 'b2:0', variant_id: 'tote:', product_id: 'tote', qty: 5, cost_price: 120, t: 1 }]);
check('the same file again: a duplicate (after its lock)', refused(r, /HANGTAG_DUPLICATE_FILE/), r);
r = await bill('b3', 'h3', 'inv-1 ', [], [{ id: 'b3:0', variant_id: 'tote:', product_id: 'tote', qty: 5, cost_price: 120, t: 1 }]);
check('the same invoice number from the same supplier: a duplicate', refused(r, /HANGTAG_DUPLICATE_INVOICE/), r);
r = await bill('b4', 'h1', 'INV-1', [], [{ id: 'b4:0', variant_id: 'tote:', product_id: 'tote', qty: 5, cost_price: 120, t: 1 }], true);
check('…and taken when the merchant says it is another bill', !r.err && r.r.rows[0].r.status === 'imported', r);

console.log('=== updated_at ===');
const at = async (t, id) => (await one(`SELECT updated_at::text u FROM public.${t} WHERE id = $1`, [id])).u;
let u0 = await at('hangtag_products', 'tote');
await as(`UPDATE public.hangtag_products SET name = 'Tote' WHERE id = 'tote'`);
check('the same row sent again keeps its updated_at', (await at('hangtag_products', 'tote')) === u0);
await as(`UPDATE public.hangtag_products SET updated_at = '2001-01-01' WHERE id = 'tote'`);
check('…an updated_at sent by the app alone changes nothing', (await at('hangtag_products', 'tote')) === u0);
await as(`UPDATE public.hangtag_products SET price = 320 WHERE id = 'tote'`);
const u1 = await at('hangtag_products', 'tote');
check('a real change moves it forward', u1 > u0, { u0, u1 });
u0 = await at('hangtag_variants', 'tote:');
await as(`UPDATE public.hangtag_variants SET sku = sku WHERE id = 'tote:'`);
const v0 = await at('hangtag_variants', 'tote:');
await as(`UPDATE public.hangtag_variants SET sku = 'TOTE-1' WHERE id = 'tote:'`);
check('variants too: kept on a resend, moved on a change', v0 === u0 && (await at('hangtag_variants', 'tote:')) > u0, { u0, v0 });

console.log('=== a product\'s unit ===');
await as(`INSERT INTO public.hangtag_products (id, name, price, unit, options) VALUES ('rice', 'Rice', 60, 'kg', '{"opts":[]}'), ('dal', 'Dal', 90, 'kg', '{"opts":[]}')`);
await as(`INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('rice:', 'rice', '[]'), ('dal:', 'dal', '[]')`);
await as(`INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ('open:rice', 'rice:', 'rice', 'OPENING', 12.5, 1)`);
r = await tryAs(`UPDATE public.hangtag_products SET unit = 'pcs' WHERE id = 'rice'`);
check('rice has stock records in kg: its unit stays (an older app, a re-upload or SQL alike)', refused(r, /Rice has stock records or bills in kg, so its unit stays/) && (await one(`SELECT unit FROM public.hangtag_products WHERE id = 'rice'`)).unit === 'kg', r);
r = await tryAs(`INSERT INTO public.hangtag_products (id, name, price, unit, options) VALUES ('rice', 'Basmati rice', 64, 'kg', '{"opts":[]}')
  ON CONFLICT (owner_id, id) DO UPDATE SET name = EXCLUDED.name, price = EXCLUDED.price, unit = EXCLUDED.unit`);
check('…a whole upload with the same unit is taken', !r.err && (await one(`SELECT name FROM public.hangtag_products WHERE id = 'rice'`)).name === 'Basmati rice', r);
r = await tryAs(`UPDATE public.hangtag_products SET unit = 'pcs' WHERE id = 'dal'`);
check('dal has no history: its unit can change', !r.err && (await one(`SELECT unit FROM public.hangtag_products WHERE id = 'dal'`)).unit === 'pcs', r);
const lock = await fn('hangtag_product_unit_lock');
check('the lock also looks at bill, return and order lines and repacks', ['hangtag_sale_items', 'hangtag_return_items', 'hangtag_order_items', 'hangtag_repacks'].every((t) => lock.includes('public.' + t)));

// AUDIT.md item 55, re-checked: a saved record's serials, batch and expiry never change (section 3n's
// hangtag_tracking_shape), a serial record's quantity is its serial count, and batch quantities are read from the records,
// so the registers can't drift. A quantity correction by the owner or a role with stock adjustments is allowed and
// logged by design (team-tenancy covers the log); "Combine colours" re-points records when it merges products.
console.log('=== saved stock records: corrections allowed, registers kept in step ===');
const resend = (id, v, p, type, qty, sn, note) => tryAs(`INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t, serials, note) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
  ON CONFLICT (owner_id, id) DO UPDATE SET variant_id = EXCLUDED.variant_id, product_id = EXCLUDED.product_id, type = EXCLUDED.type, qty = EXCLUDED.qty,
    serials = EXCLUDED.serials, note = EXCLUDED.note`, [id, v, p, type, qty, sn, note]);
r = await resend('open:rice', 'rice:', 'rice', 'OPENING', 12.5, null, null);
check('the same record sent again (the app\'s upload, repeated) is taken', !r.err, r);
r = await resend('open:rice', 'rice:', 'rice', 'OPENING', 13, null, 'Recounted');
check('the owner may correct a saved record\'s quantity (a logged correction, by design)', !r.err && +(await one(`SELECT qty FROM public.hangtag_stock_moves WHERE id = 'open:rice'`)).qty === 13, r);
r = await resend('m4', 'ph:', 'ph', 'RESTOCK', 1, ['SN9'], null);
let reg = (await as(`SELECT serial, status, move_id FROM public.hangtag_serials ORDER BY serial`)).rows;
check('a saved record\'s serials can\'t change, so the register still has SN1 from it (no SN9)', refused(r, /The serial numbers of a saved record don't change/)
  && JSON.stringify(reg) === JSON.stringify([{ serial: 'SN1', status: 'IN_STOCK', move_id: 'm4' }]), { r, reg });
r = await resend('m4', 'ph:', 'ph', 'RESTOCK', 2, ['SN1'], null);
check('…nor its quantity apart from its serials (one serial per piece)', refused(r, /2 piece\(s\) but 1 serial number\(s\)/), r);

rep = await report();
check('the report is still all ok with all of it in the database', rep.length === REPORT_ROWS && rep.every((x) => x.ok), rep.filter((x) => !x.ok));

await db.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
