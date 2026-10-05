// Public mobile store and assisted cart: tenant-scoped catalog, ledger availability, idempotent customer sales orders,
// customer linkage, status-token privacy and duplicate/racing fulfilment protection.
// Run: node supabase/tests/mobile-store.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';

const SCHEMA = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if(!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };
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
async function as(db, who, sql, params){
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.headers',$2,false)`, [who || '', JSON.stringify({ authorization:'Bearer x' })]);
  try{ return await db.query(sql, params); } finally{ await db.exec('RESET ROLE'); }
}
const attempt = async (db, who, sql, params) => { try{ return { r:await as(db, who, sql, params) }; }catch(e){ return { err:e.message, code:e.code }; } };
const value = r => r.r?.rows[0]?.result;

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users(id,email) VALUES($1,'a@shop.test'),($2,'b@shop.test')`, [A, B]);
await db.exec(SCHEMA);
await as(db, A, `UPDATE public.hangtag_profiles SET shop_name='Aura Mobile',business_type='retail' WHERE id=$1`, [A]);
await as(db, B, `UPDATE public.hangtag_profiles SET shop_name='Other Shop',business_type='retail' WHERE id=$1`, [B]);
await as(db, A, `INSERT INTO public.hangtag_meta(key,value) VALUES('settings','{"caps":{"uses_mobile_store":true},"capsAt":1,"taxOn":true,"taxIncl":true,"taxRate":5}'::jsonb)`);
await as(db, B, `INSERT INTO public.hangtag_meta(key,value) VALUES('settings','{"caps":{"uses_mobile_store":true},"capsAt":1}'::jsonb)`);
await as(db, A, `INSERT INTO public.hangtag_products(id,name,price,cost_price,category,description,gst_rate,unit,options)
  VALUES('tee','Everyday Tee',500,200,'Clothing','Soft cotton',5,'pcs','{"opts":[{"name":"Size","values":["M"]}]}'::jsonb)`);
await as(db, A, `INSERT INTO public.hangtag_variants(id,product_id,option_values,price,cost_price,active) VALUES('tee:m','tee','["M"]',500,200,true)`);
await as(db, A, `INSERT INTO public.hangtag_images(product_id,image_data) VALUES('tee','data:image/jpeg;base64,AA==')`);
await as(db, A, `INSERT INTO public.hangtag_stock_moves(id,variant_id,product_id,type,qty,t) VALUES('open:tee','tee:m','tee','OPENING',2,1)`);
await as(db, B, `INSERT INTO public.hangtag_products(id,name,price,cost_price,category,options) VALUES('secret','Other Product',999,1,'Other','{"opts":[]}'::jsonb)`);
await as(db, B, `INSERT INTO public.hangtag_variants(id,product_id,option_values,price,active) VALUES('secret:','secret','[]',999,true)`);
await as(db, B, `INSERT INTO public.hangtag_stock_moves(id,variant_id,product_id,type,qty,t) VALUES('open:secret','secret:','secret','OPENING',9,1)`);
const ta = (await as(db, A, `SELECT store_token FROM public.hangtag_profiles WHERE id=$1`, [A])).rows[0].store_token;
const tb = (await as(db, B, `SELECT store_token FROM public.hangtag_profiles WHERE id=$1`, [B])).rows[0].store_token;

console.log('=== public catalog and isolation ===');
{
  const catalog = await attempt(db, null, `SELECT public.hangtag_mobile_catalog($1) result`, [ta]), data = value(catalog), product = data?.items?.[0], variant = product?.variants?.[0];
  check('opaque shop token exposes only that shop catalog with live availability', !catalog.err && data?.ok && data.shop === 'Aura Mobile'
    && data.items.length === 1 && product.name === 'Everyday Tee' && product.description === 'Soft cotton' && product.gst === 5
    && product.image === 'data:image/jpeg;base64,AA==' && variant.v === 'tee:m' && variant.price === 500 && variant.available === 2
    && !JSON.stringify(data).includes('Other Product') && !Object.hasOwn(product, 'cost_price'), data);
  const other = value(await attempt(db, null, `SELECT public.hangtag_mobile_catalog($1) result`, [tb]));
  check('a different shop token cannot cross tenant catalog data', other?.ok && other.shop === 'Other Shop' && other.items[0]?.name === 'Other Product' && !JSON.stringify(other).includes('Everyday Tee'), other);
  const direct = await attempt(db, null, `SELECT id,name,cost_price FROM public.hangtag_products`);
  const helpers = [];
  for(const fn of ['hangtag_mobile_reserved','hangtag_mobile_free','hangtag_mobile_available']) helpers.push(await attempt(db, null, `SELECT public.${fn}($1,$2)`, [A, 'tee:m']));
  check('anon cannot bypass RPC projection or call the private stock helpers', (!!direct.err || direct.r.rows.length === 0) && helpers.every(x => !!x.err), { direct, helpers });
}

console.log('=== customer order, reservation and retry ===');
let mobile;
{
  const args = [ta, JSON.stringify([{ v:'tee:m', q:1 }]), JSON.stringify({ name:'Asha Rao', phone:'+91 98765 43210', email:'asha@example.com' }), 'ck_12345678901234567890123456789012', 'Please keep ready', 'upi', 'assisted'];
  const placed = await attempt(db, null, `SELECT public.hangtag_place_mobile_order($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7) result`, args); mobile = value(placed);
  check('anon creates an existing sales order snapshot, never a second order type', !placed.err && mobile?.ok && /^MO-/.test(mobile.order_no) && /^mo_/.test(mobile.order_token), placed.err || mobile);
  const rows = (await as(db, A, `SELECT o.id,o.kind,o.status,o.source,o.checkout_mode,o.payment_preference,o.customer_id,o.customer,o.total,
      i.variant_id,i.qty::text qty,i.price::text price,i.gst_rate::text gst,c.phone,c.email
    FROM public.hangtag_orders o JOIN public.hangtag_order_items i ON i.owner_id=o.owner_id AND i.order_id=o.id
    JOIN public.hangtag_customers c ON c.owner_id=o.owner_id AND c.id=o.customer_id WHERE o.public_token=$1`, [mobile.order_token])).rows[0];
  check('mobile checkout links a same-shop customer and snapshots catalog price/GST in a confirmed sales order', rows.kind === 'sales' && rows.status === 'confirmed'
    && rows.source === 'customer' && rows.checkout_mode === 'assisted' && rows.payment_preference === 'upi' && rows.variant_id === 'tee:m'
    && rows.qty === '1.000' && rows.price === '500.00' && rows.gst === '5.00' && rows.total === '500.00' && rows.phone === '919876543210', rows);
  const after = value(await attempt(db, null, `SELECT public.hangtag_mobile_catalog($1) result`, [ta]));
  check('the active order reserves stock immediately', after.items[0].variants[0].available === 1, after.items[0].variants[0]);
  const retry = value(await attempt(db, null, `SELECT public.hangtag_place_mobile_order($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7) result`, args));
  const count = (await as(db, A, `SELECT count(*)::int n FROM public.hangtag_orders WHERE public_token IS NOT NULL`)).rows[0].n;
  check('a repeated checkout key returns the original order without duplicating it', retry?.order_token === mobile.order_token && count === 1, { retry, count });
  const race = await attempt(db, null, `SELECT public.hangtag_place_mobile_order($1,$2::jsonb,$3::jsonb,$4,NULL,'counter','store') result`,
    [ta, JSON.stringify([{ v:'tee:m', q:2 }]), JSON.stringify({ name:'Ravi', phone:'9988776655' }), 'ck_abcdefghijklmnopqrstuvwxyz123456']);
  check('a second checkout cannot race past reserved stock', !!race.err && /only 1 available/i.test(race.err), race);
  const cross = await attempt(db, null, `SELECT public.hangtag_place_mobile_order($1,$2::jsonb,$3::jsonb,$4,NULL,'counter','store') result`,
    [tb, JSON.stringify([{ v:'tee:m', q:1 }]), JSON.stringify({ name:'Mallory', phone:'9988776655' }), 'ck_crossshop_abcdefghijklmnopqrstuv']);
  check('a shop token cannot order another tenant variant', !!cross.err && /not available/i.test(cross.err), cross);

  let stoleReservation;
  try{
    await db.exec('BEGIN');
    await db.query(`INSERT INTO public.hangtag_sales(owner_id,id,timestamp,total,payment_method) VALUES($1,'walkin-too-many',90,1000,'cash')`, [A]);
    await db.query(`INSERT INTO public.hangtag_sale_items(owner_id,sale_id,line_no,product_id,product_name,size,quantity,unit_price,variant_id)
      VALUES($1,'walkin-too-many',0,'tee','Everyday Tee','',2,500,'tee:m')`, [A]);
    await db.exec('COMMIT');
  }catch(e){ stoleReservation = e.message; try{ await db.exec('ROLLBACK'); }catch{ /* transaction already aborted */ } }
  const walkins = (await as(db, A, `SELECT count(*)::int n FROM public.hangtag_sales WHERE id='walkin-too-many'`)).rows[0].n;
  check('a normal till bill cannot consume stock reserved by a mobile order', /reserved for a mobile order/i.test(stoleReservation || '') && walkins === 0,
    { stoleReservation, walkins });
}

console.log('=== private status and duplicate billing ===');
{
  const invalid = value(await attempt(db, null, `SELECT public.hangtag_mobile_order_status($1) result`, ['mo_00000000000000000000000000000000']));
  const before = value(await attempt(db, null, `SELECT public.hangtag_mobile_order_status($1) result`, [mobile.order_token]));
  check('only the per-order secret reads safe status, without customer or tenant identifiers', invalid?.ok === false && before?.ok && before.state === 'received'
    && before.payment_state === 'awaiting_staff' && !Object.hasOwn(before, 'customer') && !Object.hasOwn(before, 'owner_id'), { invalid, before });

  const orderId = (await as(db, A, `SELECT id FROM public.hangtag_orders WHERE public_token=$1`, [mobile.order_token])).rows[0].id;
  await db.exec('BEGIN');
  await db.query(`INSERT INTO public.hangtag_sales(owner_id,id,timestamp,total,payment_method,order_id) VALUES($1,'bill-one',100,500,'cash',$2)`, [A, orderId]);
  await db.query(`INSERT INTO public.hangtag_sale_items(owner_id,sale_id,line_no,product_id,product_name,size,quantity,unit_price,variant_id)
    VALUES($1,'bill-one',0,'tee','Everyday Tee','',1,500,'tee:m')`, [A]);
  await db.query(`INSERT INTO public.hangtag_payments(owner_id,id,sale_id,method,amount,tendered,change_given,status,t,verification)
    VALUES($1,'bill-one:cash','bill-one','cash',500,500,0,'completed',100,'recorded')`, [A]);
  await db.exec('COMMIT');
  const afterBill = value(await attempt(db, null, `SELECT public.hangtag_mobile_order_status($1) result`, [mobile.order_token]));
  const catalog = value(await attempt(db, null, `SELECT public.hangtag_mobile_catalog($1) result`, [ta]));
  check('existing bill/payment state drives customer confirmation (billed and paid: completed) and releases the matching reservation exactly once', afterBill?.state === 'completed'
    && afterBill.payment_state === 'confirmed' && catalog.items[0].variants[0].available === 1, { afterBill, available:catalog.items[0].variants[0].available });

  let duplicate;
  try{
    await db.exec('BEGIN');
    await db.query(`INSERT INTO public.hangtag_sales(owner_id,id,timestamp,total,payment_method,order_id) VALUES($1,'bill-two',101,500,'cash',$2)`, [A, orderId]);
    await db.query(`INSERT INTO public.hangtag_sale_items(owner_id,sale_id,line_no,product_id,product_name,size,quantity,unit_price,variant_id)
      VALUES($1,'bill-two',0,'tee','Everyday Tee','',1,500,'tee:m')`, [A]);
    await db.exec('COMMIT');
  }catch(e){ duplicate = e.message; try{ await db.exec('ROLLBACK'); }catch{ /* transaction already aborted */ } }
  const bills = (await as(db, A, `SELECT count(*)::int n FROM public.hangtag_sales WHERE order_id=$1 AND NOT is_void`, [orderId])).rows[0].n;
  check('a second till cannot bill the same mobile quantity again', /already been billed/i.test(duplicate || '') && bills === 1, { duplicate, bills });

  let ordinary;
  try{
    await db.exec('BEGIN');
    await db.query(`INSERT INTO public.hangtag_sales(owner_id,id,timestamp,total,payment_method) VALUES($1,'walkin-after',102,500,'cash')`, [A]);
    await db.query(`INSERT INTO public.hangtag_sale_items(owner_id,sale_id,line_no,product_id,product_name,size,quantity,unit_price,variant_id)
      VALUES($1,'walkin-after',0,'tee','Everyday Tee','',1,500,'tee:m')`, [A]);
    await db.exec('COMMIT'); ordinary = true;
  }catch(e){ ordinary = e.message; try{ await db.exec('ROLLBACK'); }catch{ /* transaction already aborted */ } }
  check('ordinary POS billing is unchanged once no mobile quantity remains reserved', ordinary === true, ordinary);
}

console.log('=== explicit switch-off ===');
{
  await as(db, A, `UPDATE public.hangtag_meta SET value='{"caps":{"uses_mobile_store":false},"capsAt":2}'::jsonb WHERE key='settings'`);
  const off = value(await attempt(db, null, `SELECT public.hangtag_mobile_catalog($1) result`, [ta]));
  const status = value(await attempt(db, null, `SELECT public.hangtag_mobile_order_status($1) result`, [mobile.order_token]));
  check('switching the store off closes catalog and checkout while existing customer status remains available', off?.ok === false && status?.ok === true && status.state === 'completed', { off, status });
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
