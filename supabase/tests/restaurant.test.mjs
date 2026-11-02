// Restaurant tables and QR ordering: public guests may use only the two deliberately public RPCs.
// The token identifies a table, not a shop account; tables, sessions, tickets and kitchen controls stay private.
// Run: node supabase/tests/restaurant.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const TOKEN = 'qr_public_table_token_1234567890123456789012345';
let fails = 0;
const check = (name, ok, info) => {
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 600) : ''));
};

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

// Simulate an anon or PostgREST authenticated request, including the JWT subject used by RLS.
async function as(db, who, sql, params) {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
    [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, who, sql, params) => {
  try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; }
};
const customerOrderCount = async (db) => (await as(db, A,
  `SELECT count(*)::int n FROM public.hangtag_orders WHERE kind = 'table' AND source = 'customer'`)).rows[0].n;
const rpcResult = (r) => r.r?.rows[0]?.result;

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner@cafe.test'), ($2, 'other@shop.test')`, [A, B]);
await db.exec(NEW);

await as(db, A, `UPDATE public.hangtag_profiles SET business_type = 'restaurant', shop_name = 'Cedar Cafe' WHERE id = $1`, [A]);
await as(db, A, `INSERT INTO public.hangtag_tables (id, name, area, seats, qr_token) VALUES ('patio-7', 'Patio 7', 'Garden', 4, $1)`, [TOKEN]);
await as(db, A, `INSERT INTO public.hangtag_products (id, name, price, cost_price, category, options)
  VALUES ('chai', 'Masala Chai', 120, 42, 'Hot drinks', '{"opts":[]}'::jsonb)`);
await as(db, A, `INSERT INTO public.hangtag_variants (id, product_id, option_values, price, cost_price, active)
  VALUES ('chai:cup', 'chai', '[]'::jsonb, 120, 42, true)`);

console.log('=== public QR menu and private restaurant data ===');
{
  const bad = await tryAs(db, null, `SELECT public.hangtag_table_menu($1) AS result`, ['not-a-qr-token']);
  check('anon gets a safe rejection for an invalid QR token', !bad.err && rpcResult(bad)?.ok === false, bad);

  const menu = await tryAs(db, null, `SELECT public.hangtag_table_menu($1) AS result`, [TOKEN]);
  const data = rpcResult(menu);
  const chai = data?.items?.find((item) => item.v === 'chai:cup');
  check('anon can execute the public menu RPC for a live table', !menu.err && data?.ok === true
    && data.shop === 'Cedar Cafe' && data.table === 'Patio 7' && data.ordering === true, menu.err || data);
  check('public menu exposes sale data but not product costs or stock', chai?.name === 'Masala Chai' && chai?.price === 120
    && chai?.cat === 'Hot drinks' && !Object.hasOwn(chai, 'cost_price') && !Object.hasOwn(chai, 'stock'), chai);

  const tableRead = await tryAs(db, null, `SELECT id, qr_token FROM public.hangtag_tables`);
  const sessionRead = await tryAs(db, null, `SELECT id, table_id FROM public.hangtag_table_sessions`);
  const ticketRead = await tryAs(db, null, `SELECT id, customer FROM public.hangtag_orders`);
  check('anon cannot read table records or their QR tokens', !!tableRead.err || tableRead.r.rows.length === 0, tableRead);
  check('anon cannot read table sessions', !!sessionRead.err || sessionRead.r.rows.length === 0, sessionRead);
  check('anon cannot read customer tickets directly', !!ticketRead.err || ticketRead.r.rows.length === 0, ticketRead);

  const status = await tryAs(db, null, `SELECT public.hangtag_order_status('missing', 'accepted')`);
  check('anon cannot call the staff kitchen-status RPC', !!status.err, status);
}

console.log('=== guest order integrity ===');
{
  const placed = await tryAs(db, null, `SELECT public.hangtag_place_table_order($1, $2::jsonb, $3, $4, $5) AS result`,
    [TOKEN, JSON.stringify([{ v: 'chai:cup', q: 2, note: 'Less sugar' }]), 'By the fountain', 'Asha', '+91 98765 43210']);
  const order = rpcResult(placed);
  check('anon can place one valid QR order without a sign-in', !placed.err && order?.ok === true && order.table === 'Patio 7', placed.err || order);

  const saved = (await as(db, A, `SELECT o.kind, o.source, o.status, o.table_id, o.session_id, o.user_id IS NULL AS guest,
      o.customer, o.notes, i.variant_id, i.qty::text AS qty, i.price::text AS price, i.note, s.status AS session_status
    FROM public.hangtag_orders o
    JOIN public.hangtag_order_items i ON i.owner_id = o.owner_id AND i.order_id = o.id
    JOIN public.hangtag_table_sessions s ON s.owner_id = o.owner_id AND s.id = o.session_id
    WHERE o.kind = 'table' AND o.source = 'customer'`)).rows;
  const row = saved[0];
  check('guest order is priced from the catalog and tied to its own open table session', saved.length === 1
    && row?.table_id === 'patio-7' && row.session_status === 'open' && row.guest === true
    && row.variant_id === 'chai:cup' && row.qty === '2.000' && row.price === '120.00'
    && row.customer?.name === 'Asha' && row.customer?.phone === '+919876543210' && row.note === 'Less sugar', row);

  const beforeDuplicate = await customerOrderCount(db);
  const duplicate = await tryAs(db, null, `SELECT public.hangtag_place_table_order($1, $2::jsonb) AS result`,
    [TOKEN, JSON.stringify([{ v: 'chai:cup', q: 1 }, { v: 'chai:cup', q: 1 }])]);
  const afterDuplicate = await customerOrderCount(db);
  check('duplicate variant rows are rejected before creating a customer order', !duplicate.err && rpcResult(duplicate)?.ok === false
    && afterDuplicate === beforeDuplicate, { duplicate, beforeDuplicate, afterDuplicate });

  // Once the bill is being prepared, a new guest ticket must not be added after its snapshot.
  await as(db, A, `UPDATE public.hangtag_table_sessions SET status = 'billing' WHERE id = $1`, [row.session_id]);
  const beforeBilling = await customerOrderCount(db);
  const duringBilling = await tryAs(db, null, `SELECT public.hangtag_place_table_order($1, $2::jsonb) AS result`,
    [TOKEN, JSON.stringify([{ v: 'chai:cup', q: 1 }])]);
  const afterBilling = await customerOrderCount(db);
  check('a billing table rejects new QR orders instead of adding an unbilled ticket', !duringBilling.err && rpcResult(duringBilling)?.ok === false
    && afterBilling === beforeBilling, { duringBilling, beforeBilling, afterBilling });
}

console.log('=== shop isolation and disabled customer ordering ===');
{
  const otherShopRead = await tryAs(db, B, `SELECT id, qr_token FROM public.hangtag_tables`);
  const otherShopWrite = await tryAs(db, B, `INSERT INTO public.hangtag_tables (owner_id, id, name, qr_token)
    VALUES ($1, 'intrude', 'Intrude', 'qr_other_shop_token_123456789012345678901234567')`, [A]);
  check('a signed-in user from another shop cannot read this shop\'s tables', !otherShopRead.err && otherShopRead.r.rows.length === 0, otherShopRead);
  check('a signed-in user from another shop cannot create a table for this shop', !!otherShopWrite.err, otherShopWrite);

  await as(db, A, `INSERT INTO public.hangtag_meta (key, value, updated_at) VALUES ('settings', $1::jsonb, now())
    ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify({ caps: { uses_customer_ordering: false }, capsAt: 1 })]);
  const menu = await tryAs(db, null, `SELECT public.hangtag_table_menu($1) AS result`, [TOKEN]);
  const before = await customerOrderCount(db);
  const denied = await tryAs(db, null, `SELECT public.hangtag_place_table_order($1, $2::jsonb) AS result`,
    [TOKEN, JSON.stringify([{ v: 'chai:cup', q: 1 }])]);
  const after = await customerOrderCount(db);
  check('QR menu remains readable but declares customer ordering off', !menu.err && rpcResult(menu)?.ok === true && rpcResult(menu)?.ordering === false, menu);
  check('customer-ordering capability blocks public placement without a new ticket', !denied.err && rpcResult(denied)?.ok === false && after === before,
    { denied, before, after });
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
