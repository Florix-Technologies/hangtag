// The shop's own product fields and units in the database (schema.sql section 3z, migration 20261012120000): fields of
// every kind with their checks, product values checked against their field, options taking their values from a field,
// a field or unit in use kept (archived, not removed; its kind and decimals fixed), a shop's own units on products and
// on bill lines, supplier bills and quotations taking a quantity with the decimals of the shop's unit, each shop's
// fields and units its own, a cashier reading but not changing them, the account removed with all of it, the team's
// poll seeing changes, and the report all ok. PGlite with Supabase stand-ins.
// Run: node supabase/tests/custom-fields.test.mjs
import { PGlite } from '@electric-sql/pglite';
import crypto from 'crypto';
import fs from 'fs';
import { orderArgs } from '../../src/infrastructure/supabase/mappers.js';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const A = 'dddddddd-0000-0000-0000-000000000001', B = 'dddddddd-0000-0000-0000-000000000002';
const CASH = { id: 'dddddddd-0000-0000-0000-000000000003', key: 'cashier-device-key-0123456789abcdef', dev: 'dev-cashier-1' };
const MGR = { id: 'dddddddd-0000-0000-0000-000000000004', key: 'manager-device-key-0123456789abcdef', dev: 'dev-manager-1' };
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
async function as(who, q, params) {
  const id = typeof who === 'string' ? who : who && who.id, key = who && typeof who === 'object' ? who.key : null;
  await db.exec(`SET ROLE ${id ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
    [id || '', JSON.stringify(key ? { authorization: 'Bearer x', 'x-hangtag-device': key } : { authorization: 'Bearer x' })]);
  try { return await db.query(q, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (who, q, params) => { try { return { r: await as(who, q, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const rows = async (who, q, params) => (await as(who, q, params)).rows;
const svc = async (q, params) => { await db.exec('SET ROLE service_role'); try { return await db.query(q, params); } finally { await db.exec('RESET ROLE'); } };
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const field = (who, id, name, type, extra = {}) => tryAs(who, `INSERT INTO public.hangtag_attributes (id, name, type, options, rules, categories) VALUES ($1, $2, $3, $4, $5, $6)`,
  [id, name, type, JSON.stringify(extra.options || []), JSON.stringify(extra.rules || {}), JSON.stringify(extra.cats || [])]);
const setAttrs = (who, pid, attrs) => tryAs(who, `UPDATE public.hangtag_products SET attrs = $2 WHERE id = $1`, [pid, JSON.stringify(attrs)]);
const refused = (r, re) => !!r.err && re.test(r.err);
const report = async () => (await db.query(NEW.slice(NEW.lastIndexOf('SELECT check_name')))).rows;

await db.exec(SUPABASE);
await db.exec(NEW);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.test'), ($2, 'b@shop.test'), ($3, 'cash@shop.test'), ($4, 'mgr@shop.test')`, [A, B, CASH.id, MGR.id]);
for (const o of [A, B]) await db.query(`SELECT public.hangtag_subscription_ensure($1)`, [o]);
for (const [m, role] of [[CASH, 'cashier'], [MGR, 'manager']]) {
  await svc(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, created_by) VALUES ($1, $2, $3, $4, $5, $2)`, [m.id, A, role, role + '1', role]);
  await svc(`INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Phone', 'Android', $4)`, [A, m.dev, m.id, hash(m.key)]);
}

console.log('=== fields of every kind, checked when saved ===');
const made = await Promise.all([]);
let r;
for (const [id, name, type, extra] of [
  ['watt', 'Wattage', 'choice', { options: ['100 W', '200 W'], cats: ['Grow lights'] }], ['spec', 'Spectrum', 'multi', { options: ['Bloom', 'Veg'] }],
  ['year', 'Pressing year', 'number', { rules: { min: 1900, max: 2100, required: false } }], ['beam', 'Beam angle', 'decimal', { rules: { dp: 1, unit: '°', min: 0, max: 360 } }],
  ['tested', 'Tested on', 'date'], ['knot', 'Hand-knotted', 'yesno'], ['origin', 'Origin', 'text', { rules: { maxLen: 40 } }]]) {
  r = await field(A, id, name, type, extra);
  made.push(!r.err || r.err);
}
check('fields of each kind are saved: one choice, several, whole and decimal numbers, date, yes/no, text', made.every((x) => x === true), made);
const fa = await rows(A, `SELECT id, name, type FROM public.hangtag_attributes ORDER BY id`);
check('…and read back by the shop', fa.length === 7 && fa.find((x) => x.id === 'watt').type === 'choice', fa);
check('a field with choices needs one; a choice twice (any case) or too long is refused',
  refused(await field(A, 'f1', 'Finish', 'choice'), /needs at least one choice/) && refused(await field(A, 'f1', 'Finish', 'choice', { options: ['Matte', 'MATTE'] }), /twice/)
  && refused(await field(A, 'f1', 'Finish', 'multi', { options: ['x'.repeat(41)] }), /1 to 40 characters/) && refused(await field(A, 'f1', 'Finish', 'choice', { options: [12] }), /1 to 40 characters/));
check('only a field with choices has choices', refused(await field(A, 'f1', 'Finish', 'text', { options: ['a'] }), /Only a field with choices/));
check('rules: only the known ones, each of its kind; lowest not above highest',
  refused(await field(A, 'f1', 'Finish', 'number', { rules: { colour: 'red' } }), /rules of the field/) && refused(await field(A, 'f1', 'Finish', 'number', { rules: { min: 10, max: 5 } }), /rules of the field/)
  && refused(await field(A, 'f1', 'Finish', 'decimal', { rules: { dp: 5 } }), /rules of the field/) && refused(await field(A, 'f1', 'Finish', 'text', { rules: { maxLen: 400 } }), /rules of the field/)
  && refused(await field(A, 'f1', 'Finish', 'number', { rules: { unit: 'x'.repeat(13) } }), /rules of the field/) && refused(await field(A, 'f1', 'Finish', 'yesno', { rules: { required: 'yes' } }), /rules of the field/));
check('a name: 1 to 32 characters, not starting with #, one field of a name in use (any case and spacing)',
  refused(await field(A, 'f1', ' ', 'text'), /check/) && refused(await field(A, 'f1', 'x'.repeat(33), 'text'), /check/) && refused(await field(A, 'f1', '#Notes', 'text'), /check/)
  && refused(await field(A, 'f1', ' pressing   YEAR ', 'text'), /uq_hangtag_attributes_name|duplicate/));
check('a kind it doesn\'t have, a bad id, categories that aren\'t names: refused', refused(await field(A, 'f1', 'Finish', 'colour'), /check/) && refused(await field(A, 'bad id!', 'Finish', 'text'), /check/)
  && refused(await field(A, 'f1', 'Finish', 'text', { cats: [3] }), /categories are names/));
r = await field(A, 'f1', ' Finish ', 'text');
check('names are kept tidy', !r.err && (await rows(A, `SELECT name FROM public.hangtag_attributes WHERE id = 'f1'`))[0].name === 'Finish', r);
await as(A, `UPDATE public.hangtag_attributes SET archived = true WHERE id = 'f1'`);
r = await field(A, 'f2', 'finish', 'choice', { options: ['Gloss'] });
check('an archived field\'s name can be used again', !r.err, r);
for (let i = 0; i < 52; i++) await field(A, 'many' + i, 'Field ' + i, 'text');
r = await field(A, 'one-more', 'One more', 'text');
check('at most 60 fields in use (archived ones don\'t count)', refused(r, /up to 60 fields/) && (await rows(A, `SELECT count(*)::int n FROM public.hangtag_attributes WHERE NOT archived`))[0].n === 60, r);
r = await tryAs(A, `UPDATE public.hangtag_attributes SET archived = false WHERE id = 'f1'`);
check('…restoring one past the limit is refused too', refused(r, /up to 60 fields/), r);
await as(A, `DELETE FROM public.hangtag_attributes WHERE id LIKE 'many%'`);

console.log('\n=== a product\'s values, checked against their fields ===');
await as(A, `INSERT INTO public.hangtag_products (id, name, price, category, options) VALUES ('lamp', 'LED Grow Light', 4999, 'Grow lights', '{"opts":[]}'), ('lp', 'Kind of Blue', 2499, 'Vinyl', '{"opts":[]}')`);
r = await setAttrs(A, 'lamp', { watt: '200 W', spec: ['Bloom', 'Veg'], beam: 120.5, tested: '2026-10-05', knot: false, origin: 'Pune', year: 2024 });
check('values of every kind are taken', !r.err && (await rows(A, `SELECT attrs->>'watt' w, attrs->'spec' s FROM public.hangtag_products WHERE id = 'lamp'`))[0].w === '200 W', r);
const wrong = [[{ year: 'nineteen' }, 'number'], [{ year: 1959.5 }, 'number'], [{ tested: '2026-02-30' }, 'date'], [{ tested: '05/10/2026' }, 'date'], [{ knot: 'yes' }, 'yesno'],
  [{ watt: 200 }, 'choice'], [{ spec: ['Bloom', 7] }, 'multi'], [{ spec: [] }, 'multi'], [{ origin: 'x'.repeat(301) }, 'text'], [{ beam: '120' }, 'decimal']];
const res = [];
for (const [v, kind] of wrong) { const x = await setAttrs(A, 'lp', v); res.push(refused(x, new RegExp(`kind ${kind}`)) || [v, x.err]); }
check('a value of the wrong kind is refused, with the field and its kind (number, date, yes/no, choice, several, text, decimal)', res.every((x) => x === true), res.filter((x) => x !== true));
r = await setAttrs(A, 'lp', { nope: 'x' });
check('a value for a field the shop doesn\'t have is refused (and said to be missing, so a phone retries until it arrives)', refused(r, /doesn't have/) && r.code === '23503', r);
r = await setAttrs(A, 'lp', Object.fromEntries(Array.from({ length: 61 }, (_, i) => ['k' + i, 'x'])));
check('at most 60 values on a product', refused(r, /up to 60 field values/), r);
r = await tryAs(A, `UPDATE public.hangtag_products SET attrs = '[]' WHERE id = 'lp'`);
check('values are an object', refused(r, /attrs_check/), r);
r = await tryAs(A, `UPDATE public.hangtag_products SET options = '{"opts":[{"name":"Wattage","values":["100 W","200 W"],"attr":"watt"}]}' WHERE id = 'lamp'`);
const linked = await tryAs(A, `UPDATE public.hangtag_products SET options = '{"opts":[{"name":"Shade","values":["Red"],"attr":"shade"}]}' WHERE id = 'lp'`);
check('an option may take its values from one of the shop\'s fields; not from one it doesn\'t have', !r.err && refused(linked, /field the shop doesn't have/), { r, linked });
r = await tryAs(A, `INSERT INTO public.hangtag_products (id, name, price, attrs) VALUES ('old', 'Older app', 10, DEFAULT)`);
check('a product saved without values (an older app) is taken as before', !r.err && (await rows(A, `SELECT attrs FROM public.hangtag_products WHERE id = 'old'`))[0].attrs && Object.keys((await rows(A, `SELECT attrs FROM public.hangtag_products WHERE id = 'old'`))[0].attrs).length === 0, r);

console.log('\n=== a field in use is kept ===');
r = await tryAs(A, `UPDATE public.hangtag_attributes SET type = 'text', options = '[]' WHERE id = 'year'`);
check('a field with values keeps its kind', refused(r, /kind can't change/), r);
r = await tryAs(A, `UPDATE public.hangtag_attributes SET type = 'multi' WHERE id = 'watt'`);
check('…so does a field an option takes its values from', refused(r, /kind can't change/), r);
await field(A, 'unused', 'Unused', 'text');
r = await tryAs(A, `UPDATE public.hangtag_attributes SET type = 'number' WHERE id = 'unused'`);
check('a field no product uses can change its kind', !r.err, r);
r = await tryAs(A, `DELETE FROM public.hangtag_attributes WHERE id = 'year'`);
const opt = await tryAs(A, `DELETE FROM public.hangtag_attributes WHERE id = 'watt'`);
check('a field in use (a value, or an option) isn\'t removed: archive it', refused(r, /archive it instead/) && refused(opt, /archive it instead/) && r.code === '23503', { r, opt });
r = await tryAs(A, `UPDATE public.hangtag_attributes SET archived = true WHERE id = 'year'`);
const still = await setAttrs(A, 'lamp', { watt: '100 W', year: 2025 });
check('…archived, its values stay and can still be saved', !r.err && !still.err, { r, still });
r = await tryAs(A, `DELETE FROM public.hangtag_attributes WHERE id = 'unused' RETURNING id`);
check('a field no product uses is removed', !r.err && r.r.rows.length === 1, r);

console.log('\n=== the shop\'s own units ===');
const unit = (who, id, label, decimals = 0, kind = 'count', uqc = 'OTH') => tryAs(who, `INSERT INTO public.hangtag_units (id, label, decimals, kind, uqc) VALUES ($1, $2, $3, $4, $5)`, [id, label, decimals, kind, uqc]);
r = await unit(A, 'roll', 'Roll', 0, 'count', 'ROL');
const sq = await unit(A, 'sqft', 'Sq ft', 2, 'measure', 'SQF');
check('units of the shop\'s own (Roll, Sq ft), with decimals and their GST code', !r.err && !sq.err, { r, sq });
check('a code of Hangtag\'s, a code that isn\'t one, more than 3 decimals, a GST code not on the list, a name twice: refused',
  refused(await unit(A, 'kg', 'Kilo'), /check/) && refused(await unit(A, 'Sq Ft', 'Sq feet'), /check/) && refused(await unit(A, 'bale', 'Bale', 4), /check/)
  && refused(await unit(A, 'bale', 'Bale', 0, 'count', 'XYZ'), /check/) && refused(await unit(A, 'rl', ' roll '), /uq_hangtag_units_label|duplicate/));
r = await tryAs(A, `INSERT INTO public.hangtag_products (id, name, price, unit) VALUES ('rug', 'Hand-knotted rug', 450, 'sqft'), ('tape', 'Kraft tape', 90, 'roll')`);
check('products are sold in them', !r.err, r);
r = await tryAs(A, `INSERT INTO public.hangtag_products (id, name, price, unit) VALUES ('x', 'X', 1, 'Sq Ft')`);
check('…a unit that isn\'t a code is refused', refused(r, /unit_check/), r);
const bill = { sale: { id: 'b1', timestamp: 1790000000000, subtotal: 5512, discount: 0, total: 5512, payment_method: 'cash', device_id: 'till', bill_no: 'INV-1', kind: 'sale', is_void: false },
  items: [{ sale_id: 'b1', line_no: 0, product_id: 'rug', product_name: 'Hand-knotted rug', color: '', size: '', quantity: 12.25, unit_price: 400, unit: 'sqft' }],
  payments: [{ id: 'b1:cash', method: 'cash', amount: 4900 }] };
bill.sale.subtotal = bill.sale.total = 4900;
r = await tryAs(A, `SELECT public.hangtag_save_sales($1::jsonb)`, [JSON.stringify([bill])]);
check('a bill of 12.25 sq ft is saved with its unit', !r.err && (await rows(A, `SELECT unit, quantity FROM public.hangtag_sale_items WHERE sale_id = 'b1'`))[0].unit === 'sqft', r);
// the decimals a quantity may have come from its unit: the shop's own, Hangtag's, or 3 for a code the shop never made
// (as the app reads one). Supplier bills, quotations and orders, and the online store check quantities with them.
r = await tryAs(A, `SELECT public.hangtag_unit_decimals($1, 'sqft') sq, public.hangtag_unit_decimals($1, 'roll') ro, public.hangtag_unit_decimals($1, 'kg') kg,
  public.hangtag_unit_decimals($1, 'm') m, public.hangtag_unit_decimals($1, 'pcs') pcs, public.hangtag_unit_decimals($1, 'tonne') other`, [A]);
check('a quantity\'s decimals: the shop\'s own unit\'s (sq ft 2, roll 0), Hangtag\'s (kg 3, m 2, pcs 0), 3 for a code the shop never made',
  !r.err && JSON.stringify(r.r.rows[0]) === JSON.stringify({ sq: 2, ro: 0, kg: 3, m: 2, pcs: 0, other: 3 }), r);
await as(A, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('rug:v', 'rug', '[]'), ('tape:v', 'tape', '[]')`);
const supplierBill = (id, v, p, qty) => tryAs(A, `SELECT public.hangtag_import_stock($1::jsonb, '[]'::jsonb, '[]'::jsonb, $2::jsonb, false) AS r`,
  [JSON.stringify({ id, file_hash: 'hash-' + id, file_name: id + '.pdf', file_type: 'application/pdf', supplier_name: 'Loom House', invoice_no: id, invoice_date: '2026-10-01', line_count: 1 }),
    JSON.stringify([{ id: id + ':0', variant_id: v, product_id: p, qty, cost_price: 300, t: 1790000001000, device_id: 'till' }])]);
r = await supplierBill('sb1', 'rug:v', 'rug', 24.5);
check('a supplier bill of 24.5 sq ft (a unit of 2 decimals) is taken in', !r.err && r.r.rows[0].r.status === 'imported', r);
const fine = await supplierBill('sb2', 'rug:v', 'rug', 24.555), half = await supplierBill('sb3', 'tape:v', 'tape', 2.5);
check('…24.555 sq ft, and 2.5 of a unit of whole numbers (roll), are refused', refused(fine, /decimal places/) && refused(half, /decimal places/), { fine, half });
await as(A, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1', 'Asha', '9876543210')`);
const quote = (id, line) => { const a = orderArgs({ id, kind: 'quote', no: 'QT-261001-' + id.toUpperCase().padStart(6, '0'), status: 'draft', cust: { id: 'c1', name: 'Asha', phone: '9876543210' },
  billDisc: null, notes: '', validUntil: '2026-10-30', source: 'staff', saleIds: [], version: 0, t: 1790000000000, updatedT: 1790000000000, dev: 'till',
  items: [{ ln: 0, fq: 0, gst: null, ...line }] });
  return tryAs(A, `SELECT public.hangtag_save_order($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(a.p_order), JSON.stringify(a.p_items)]); };
const q1 = await quote('qa', { p: 'rug', v: 'rug:v', name: 'Hand-knotted rug', vl: '', q: 12.25, u: 'sqft', price: 450 });
const q2 = await quote('qb', { p: 'tape', v: 'tape:v', name: 'Kraft tape', vl: '', q: 2.5, u: 'roll', price: 90 });
check('a quotation of 12.25 sq ft is saved; 2.5 rolls is refused', !q1.err && refused(q2, /quantity its unit cannot use/), { q1, q2 });
r = await tryAs(A, `UPDATE public.hangtag_units SET decimals = 3 WHERE id = 'sqft'`);
const lab = await tryAs(A, `UPDATE public.hangtag_units SET label = 'Square feet' WHERE id = 'sqft'`);
check('a unit in use keeps its decimals; its name can change', refused(r, /decimals can't change/) && !lab.err, { r, lab });
r = await tryAs(A, `DELETE FROM public.hangtag_units WHERE id = 'roll'`);
const arch = await tryAs(A, `UPDATE public.hangtag_units SET archived = true WHERE id = 'roll'`);
check('a unit in use isn\'t removed (archive it), and archiving keeps its products as they are', refused(r, /archive it instead/) && !arch.err
  && (await rows(A, `SELECT unit FROM public.hangtag_products WHERE id = 'tape'`))[0].unit === 'roll', { r, arch });
await unit(A, 'bundle', 'Bundle', 0, 'count', 'BDL');
r = await tryAs(A, `DELETE FROM public.hangtag_units WHERE id = 'bundle' RETURNING id`);
check('a unit no product uses is removed', !r.err && r.r.rows.length === 1, r);

console.log('\n=== each shop\'s own; the team by role ===');
check('shop B sees none of A\'s fields or units', (await rows(B, `SELECT count(*)::int n FROM public.hangtag_attributes`))[0].n === 0 && (await rows(B, `SELECT count(*)::int n FROM public.hangtag_units`))[0].n === 0);
r = await tryAs(B, `INSERT INTO public.hangtag_attributes (owner_id, id, name, type) VALUES ($1, 'sneak', 'Sneak', 'text')`, [A]);
check('B can\'t add a field to A\'s shop', !!r.err && (await rows(A, `SELECT count(*)::int n FROM public.hangtag_attributes WHERE id = 'sneak'`))[0].n === 0, r);
r = await tryAs(B, `UPDATE public.hangtag_attributes SET name = 'Hacked' WHERE id = 'watt' RETURNING id`);
const del = await tryAs(B, `DELETE FROM public.hangtag_units WHERE id = 'sqft' RETURNING id`);
check('…nor change or remove A\'s fields and units (no rows reached)', !r.err && r.r.rows.length === 0 && !del.err && del.r.rows.length === 0, { r, del });
await as(B, `INSERT INTO public.hangtag_products (id, name, price) VALUES ('bp', 'B product', 10)`);
r = await setAttrs(B, 'bp', { watt: '100 W' });
const bu = await tryAs(B, `INSERT INTO public.hangtag_products (id, name, price, unit) VALUES ('bq', 'B rug', 10, 'sqft')`);
check('B\'s product can\'t use A\'s field (B doesn\'t have it); a unit code is just a code (B\'s report would flag it)', refused(r, /doesn't have/) && !bu.err, { r, bu });
await as(B, `DELETE FROM public.hangtag_products WHERE id = 'bq'`);
check('A\'s cashier reads the fields and units (to sell)', (await rows(CASH, `SELECT count(*)::int n FROM public.hangtag_attributes`))[0].n > 0 && (await rows(CASH, `SELECT count(*)::int n FROM public.hangtag_units`))[0].n === 2);
r = await tryAs(CASH, `INSERT INTO public.hangtag_attributes (id, name, type) VALUES ('c1', 'Cashier field', 'text')`);
const cu = await tryAs(CASH, `UPDATE public.hangtag_units SET label = 'Rolls' WHERE id = 'roll' RETURNING id`);
check('…but can\'t add or change them (manage_products)', !!r.err && !cu.err && cu.r.rows.length === 0, { r, cu });
r = await tryAs(MGR, `INSERT INTO public.hangtag_attributes (id, name, type, options) VALUES ('mf', 'Pot size', 'choice', '["10 cm","15 cm"]')`);
check('A\'s manager can add one (manage_products)', !r.err, r);
r = await tryAs(null, `SELECT count(*) FROM public.hangtag_attributes`);
check('signed out: nothing', !!r.err || +(r.r.rows[0].count) === 0, r);

console.log('\n=== the team\'s poll, the report, the account removed ===');
const before = (await rows(MGR, `SELECT public.hangtag_biz_changes() c`))[0].c;
await as(A, `UPDATE public.hangtag_attributes SET options = '["10 cm","15 cm","20 cm"]' WHERE id = 'mf'`);
const after = (await rows(MGR, `SELECT public.hangtag_biz_changes() c`))[0].c;
check('a member\'s poll sees the fields and units change', before.fields && before.units && before.fields !== after.fields && before.units === after.units, { before, after });
// every product has its variants (the report checks them): one per Wattage of the lamp, one plain variant for the others
await as(A, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('lamp:100', 'lamp', '["100 W"]'), ('lamp:200', 'lamp', '["200 W"]')`);
for (const [who, p] of [[A, 'lp'], [A, 'old'], [B, 'bp']]) await as(who, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ('${p}:v', '${p}', '[]')`);   // (the rug's and the tape's came with their supplier bills)
for (const who of [A, B]) await as(who, `UPDATE public.hangtag_products SET options = '{"opts":[]}' WHERE NOT options ? 'opts'`);   // as the app writes them
const rep = await report();
check('report: 80 rows, all ok (36: products in known units, 91–93: fields, values and units)', rep.length === 80 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
await as(A, `INSERT INTO public.hangtag_products (id, name, price, unit) VALUES ('ghost', 'Ghost', 1, 'tonne')`);
const flagged = (await report()).find((x) => /known unit/.test(x.check_name));
check('…a product in a unit code the shop never made is flagged (row 36)', flagged && !flagged.ok, flagged);
await as(A, `DELETE FROM public.hangtag_products WHERE id = 'ghost'`);
r = await tryAs(null, `SELECT 1`);
let gone = null;
try { await db.query(`DELETE FROM auth.users WHERE id = $1`, [A]); gone = await db.query(`SELECT (SELECT count(*) FROM public.hangtag_attributes WHERE owner_id = $1)::int a, (SELECT count(*) FROM public.hangtag_units WHERE owner_id = $1)::int u`, [A]); }
catch (e) { gone = { err: e.message }; }
check('removing the account removes its fields and units too (the in-use guards let the account go)', gone && !gone.err && gone.rows[0].a === 0 && gone.rows[0].u === 0, gone);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
