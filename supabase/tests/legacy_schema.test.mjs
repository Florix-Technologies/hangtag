import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const V1 = fs.readFileSync(new URL('./fixtures/legacy/schema_v1.sql', import.meta.url), 'utf8');       // first cloud version (open "Public access" rules)
const V2 = fs.readFileSync(new URL('./fixtures/legacy/schema_old.sql', import.meta.url), 'utf8');      // access-list version (commit d4a6b0f)
const V3 = fs.readFileSync(new URL('./fixtures/legacy/schema_v3.sql', import.meta.url), 'utf8');       // per-account version already on the live database
const LINE_NO = `ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_sale_items_line ON public.hangtag_sale_items(sale_id, line_no);`;
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  ' + JSON.stringify(info) : '')); };

// Minimal stand-in for what Supabase provides
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
const LEGACY = `
INSERT INTO public.hangtag_products (id, name, price, sort_order) VALUES ('p1','Charcoal Grey',750,0), ('p2','citronella',750,1);
INSERT INTO public.hangtag_sizes (product_id, size, stock) VALUES ('p1','M',5), ('p1','L',4), ('p2','S',7);
INSERT INTO public.hangtag_images (product_id, image_data) VALUES ('p1','data:image/jpeg;base64,AAAA');
INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s1', 1790000000000, 1500, 1500, 'cash');
INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price) VALUES ('s1',0,'p1','Charcoal Grey','M',2,750);
`;
async function as(db, uid, sql, params) {
  // behave like a PostgREST request from a signed-in user (or anon when uid is null)
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
async function tryAs(db, uid, sql, params) { try { return { r: await as(db, uid, sql, params) }; } catch (e) { return { err: e.message }; } }
const count = async (db, uid, t) => (await as(db, uid, `SELECT count(*)::int AS n FROM public.${t}`)).rows[0].n;

async function scenario(label, before, opts = {}) {
  console.log('\n=== ' + label + ' ===');
  const db = new PGlite();
  await db.exec(SUPABASE);
  for (const s of before) await db.exec(s);
  const hadLegacy = before.some(s => s === LEGACY);
  // accounts: the owner signed in once, plus a second person
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${A}','florixenergy@gmail.com','{"full_name":"Shop Owner","avatar_url":"https://x/a.png"}'), ('${B}','staff@gmail.com','{"name":"Staff Person"}')`);
  await db.exec(`INSERT INTO auth.identities (user_id, provider, email) VALUES ('${A}','google','florixenergy@gmail.com'), ('${B}','email','staff@gmail.com')`);
  if (opts.v3First) await db.exec(V3);
  await db.exec(NEW);
  check('script runs', true);
  await db.exec(NEW);
  check('script runs a second time (safe to re-run)', true);

  const cols = (await db.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND column_name='owner_id' AND is_nullable='NO'`)).rows[0].n;
  check('every shop table has a required owner_id (including payments, books, deliveries and events)', cols === 18, cols);
  const nulls = (await db.query(`SELECT (SELECT count(*) FROM public.hangtag_products WHERE owner_id IS NULL)+(SELECT count(*) FROM public.hangtag_sales WHERE owner_id IS NULL) AS n`)).rows[0].n;
  check('no rows without an owner', Number(nulls) === 0);
  if (hadLegacy) {
    check('owner sees the existing products', (await count(db, A, 'hangtag_products')) === 2);
    check('owner sees the existing sizes, photo, bill and bill line', (await count(db, A, 'hangtag_sizes')) === 3 && (await count(db, A, 'hangtag_images')) === 1 && (await count(db, A, 'hangtag_sales')) === 1 && (await count(db, A, 'hangtag_sale_items')) === 1);
  }
  check('second person sees none of it', (await count(db, B, 'hangtag_products')) === 0 && (await count(db, B, 'hangtag_sales')) === 0 && (await count(db, B, 'hangtag_sale_items')) === 0);

  // second person builds their own shop with the SAME product ids (e.g. "Load 10 examples")
  let r = await tryAs(db, B, `INSERT INTO public.hangtag_products (id, name, price) VALUES ('p1','B product',100) ON CONFLICT (owner_id, id) DO UPDATE SET name = EXCLUDED.name`);
  check('second person can use the same product id (p1)', !r.err, r.err);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_sizes (product_id, size, stock) VALUES ('p1','M',3) ON CONFLICT (owner_id, product_id, size) DO UPDATE SET stock = EXCLUDED.stock`);
  check('size upsert matches per owner (owner_id,product_id,size)', !r.err, r.err);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s1', 1, 100, 100, 'upi') ON CONFLICT (owner_id, id) DO UPDATE SET total = EXCLUDED.total`);
  check('second person can have their own bill s1', !r.err, r.err);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price) VALUES ('s1',0,'p1','B product','M',1,100) ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET quantity = EXCLUDED.quantity`);
  check('bill line upsert matches per owner (owner_id,sale_id,line_no)', !r.err, r.err);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_sale_items (sale_id, line_no, product_id, product_name, size, quantity, unit_price) VALUES ('s1',0,'p1','B product','M',5,100) ON CONFLICT (owner_id, sale_id, line_no) DO UPDATE SET quantity = EXCLUDED.quantity`);
  check('re-uploading a bill line updates, not duplicates', !r.err && (await count(db, B, 'hangtag_sale_items')) === 1, r.err);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_images (product_id, image_data) VALUES ('p1','data:image/png;base64,BBBB') ON CONFLICT (owner_id, product_id) DO UPDATE SET image_data = EXCLUDED.image_data`);
  check('photo upsert on (owner_id, product_id)', !r.err, r.err);

  // isolation both ways
  const aName = (await as(db, A, `SELECT name FROM public.hangtag_products WHERE id='p1'`)).rows.map(x => x.name);
  const bName = (await as(db, B, `SELECT name FROM public.hangtag_products WHERE id='p1'`)).rows.map(x => x.name);
  check('each person sees only their own p1', JSON.stringify(aName) === (hadLegacy ? '["Charcoal Grey"]' : '[]') && JSON.stringify(bName) === '["B product"]', { aName, bName });
  r = await tryAs(db, B, `UPDATE public.hangtag_sales SET is_void = true WHERE owner_id = '${A}'`);
  check("second person can't cancel the owner's bills", !r.err && r.r.affectedRows === 0);
  r = await tryAs(db, B, `DELETE FROM public.hangtag_products WHERE owner_id = '${A}'`);
  check("second person can't delete the owner's products", !r.err && r.r.affectedRows === 0);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_products (owner_id, id, name) VALUES ('${A}','px','sneaky')`);
  check("second person can't write rows into the owner's shop", !!r.err, r.err);
  if (hadLegacy) {
    // deleting the owner's product removes only the owner's sizes/photo
    await as(db, A, `DELETE FROM public.hangtag_products WHERE id='p1'`);
    check("owner deleting p1 removes owner's sizes and photo only", (await count(db, A, 'hangtag_sizes')) === 1 && (await count(db, A, 'hangtag_images')) === 0 && (await count(db, B, 'hangtag_sizes')) === 1 && (await count(db, B, 'hangtag_images')) === 1);
  }
  // signed-out visitors get an error, not an empty answer
  r = await tryAs(db, null, `SELECT * FROM public.hangtag_sales`);
  check('signed-out (public key) reads are refused', !!r.err, r.err);
  r = await tryAs(db, null, `UPDATE public.hangtag_sales SET is_void = true`);
  check('signed-out writes are refused', !!r.err, r.err);

  // profiles
  const profs = (await db.query(`SELECT id, email, full_name, avatar_url FROM public.hangtag_profiles ORDER BY email`)).rows;
  check('a profile exists for each existing account', profs.length === 2 && profs.some(p => p.full_name === 'Shop Owner' && p.avatar_url) && profs.some(p => p.full_name === 'Staff Person'), profs);
  await db.exec(`INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('33333333-3333-3333-3333-333333333333','new@gmail.com','{"full_name":"New Person","picture":"https://x/p.png"}')`);
  const np = (await db.query(`SELECT full_name, avatar_url FROM public.hangtag_profiles WHERE email='new@gmail.com'`)).rows;
  check('a new account gets a profile automatically', np.length === 1 && np[0].full_name === 'New Person' && np[0].avatar_url === 'https://x/p.png', np);
  const bp = (await as(db, B, `SELECT email FROM public.hangtag_profiles`)).rows;
  check('each person can read only their own profile', bp.length === 1 && bp[0].email === 'staff@gmail.com', bp);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_profiles (id, email, full_name, last_seen_at) VALUES ('${B}','staff@gmail.com','Staff', now()) ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, last_seen_at = EXCLUDED.last_seen_at`);
  check("the app's profile upsert works for your own profile", !r.err, r.err);
  r = await tryAs(db, B, `UPDATE public.hangtag_profiles SET full_name = 'hacked' WHERE id = '${A}'`);
  check("can't change someone else's profile", !r.err && r.r.affectedRows === 0);
  const al = (await db.query(`SELECT to_regclass('public.hangtag_allowed_users') AS t, to_regprocedure('public.hangtag_is_allowed()') AS f`)).rows[0];
  check('old access list removed', al.t === null && al.f === null, al);
  const pols = (await db.query(`SELECT tablename, policyname FROM pg_policies WHERE schemaname='public' AND policyname IN ('Public access to hangtag_products','Approved staff access to hangtag_products')`)).rows;
  check('old open / access-list rules removed', pols.length === 0, pols);
  // sign-in method lookup (used before anyone is signed in)
  const m1 = (await as(db, null, `SELECT public.hangtag_sign_in_methods('FlorixEnergy@gmail.com ') AS m`)).rows[0].m;
  const m2 = (await as(db, null, `SELECT public.hangtag_sign_in_methods('staff@gmail.com') AS m`)).rows[0].m;
  const m3 = (await as(db, null, `SELECT public.hangtag_sign_in_methods('nobody@gmail.com') AS m`)).rows[0].m;
  check('sign-in lookup: Google account found (any case, spaces)', JSON.stringify(m1) === '["google"]', m1);
  check('sign-in lookup: email account found', JSON.stringify(m2) === '["email"]', m2);
  check('sign-in lookup: unknown email is new', JSON.stringify(m3) === '[]', m3);
  const leak = await tryAs(db, null, `SELECT * FROM auth.identities`);
  check('signed-out visitors still cannot read accounts directly', !!leak.err, leak.err);
  // shop details on the profile
  r = await tryAs(db, B, `INSERT INTO public.hangtag_profiles (id, email, full_name, shop_name, phone, city, state, business_type, gstin, onboarded_at) VALUES ('${B}','staff@gmail.com','Staff','Staff Store','+91 98765 43210','Pune','Maharashtra','Retail store','27ABCDE1234F1Z5', now()) ON CONFLICT (id) DO UPDATE SET shop_name = EXCLUDED.shop_name, phone = EXCLUDED.phone, city = EXCLUDED.city, state = EXCLUDED.state, business_type = EXCLUDED.business_type, gstin = EXCLUDED.gstin, onboarded_at = EXCLUDED.onboarded_at`);
  check('shop details save on your own profile', !r.err, r.err);
  const mine = (await as(db, B, `SELECT shop_name, city, gstin FROM public.hangtag_profiles`)).rows;
  check('...and read back', mine.length === 1 && mine[0].shop_name === 'Staff Store' && mine[0].gstin === '27ABCDE1234F1Z5', mine);
  r = await tryAs(db, B, `UPDATE public.hangtag_profiles SET gstin = 'NOT-A-GST' WHERE id = '${B}'`);
  check('bad GST number refused by the database', !!r.err, r.err && r.err.slice(0, 80));
  r = await tryAs(db, B, `UPDATE public.hangtag_profiles SET shop_name = repeat('x', 500) WHERE id = '${B}'`);
  check('overlong shop name refused', !!r.err);
  await db.close();
}

async function noOwnerScenario() {
  console.log('\n=== existing data, but the owner has never signed in ===');
  const db = new PGlite();
  await db.exec(SUPABASE);
  await db.exec(V1); await db.exec(LINE_NO); await db.exec(LEGACY);
  await db.exec(`INSERT INTO auth.users (id, email) VALUES ('${B}','staff@gmail.com')`);
  let err = null;
  try { await db.exec(NEW); } catch (e) { err = e.message; }
  check('script stops with a clear message', !!err && /no account with the email florixenergy@gmail.com/.test(err), err && err.slice(0, 160));
  const c = (await db.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema='public' AND column_name='owner_id'`)).rows[0].n;
  const p = (await db.query(`SELECT count(*)::int n FROM pg_policies WHERE policyname LIKE 'Public access%'`)).rows[0].n;
  check('...and nothing was changed', c === 0 && p > 0, { owner_id_columns: c, old_policies_left: p });
  await db.close();
}

await scenario('upgrade from the first cloud version (open rules + line_no)', [V1, LINE_NO, LEGACY]);
await scenario('upgrade from the access-list version (commit d4a6b0f)', [V1, LINE_NO, LEGACY, V2]);
await scenario('fresh install, empty database', []);
await scenario('upgrade from the per-account version already on your database', [V1, LINE_NO, LEGACY], { v3First: true });
await noOwnerScenario();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
