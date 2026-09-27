// Customers in the database (schema.sql section 3d): GSTIN and customer type, the upgrade of existing customers, and
// each shop seeing only its own customers. PGlite with Supabase stand-ins. Run: npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const V5 = fs.readFileSync(new URL('./fixtures/legacy/schema_v5.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info) : '')); };
const SUPABASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now());
CREATE TABLE auth.identities (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, user_id uuid REFERENCES auth.users(id), provider text, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.jwt() TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated;`;
async function as(db, uid, sql, params) {
  await db.exec(`SET ROLE ${uid ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, uid, sql, params) => { try { return { r: await as(db, uid, sql, params) }; } catch (e) { return { err: e.message }; } };
async function fresh() { const db = new PGlite(); await db.exec(SUPABASE); await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]); return db; }

console.log('=== upgrade: existing customers ===');
{
  const db = await fresh();
  await db.exec(V5);
  await as(db, A, `INSERT INTO public.hangtag_customers (id, name, phone) VALUES ('c1','Meera Shah','9876543210')`);
  await db.exec(NEW); await db.exec(NEW);
  const c = (await db.query(`SELECT name, phone, gstin, customer_type FROM public.hangtag_customers WHERE id='c1'`)).rows[0];
  check('existing customers are kept and become individuals', c.name === 'Meera Shah' && c.phone === '9876543210' && c.gstin === null && c.customer_type === 'individual', c);
  check('the script still runs twice', true);
  await db.close();
}

console.log('\n=== rules and shop isolation ===');
const db = await fresh();
await db.exec(NEW);
let r = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name, phone, gstin, customer_type) VALUES ('b1','Shah Traders','9123456780','27ABCDE1234F1Z5','business')`);
check('a business customer with its GSTIN is saved', !r.err, r);
r = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('i1','Arjun')`);
check('customer type defaults to individual', !r.err && (await as(db, A, `SELECT customer_type FROM public.hangtag_customers WHERE id='i1'`)).rows[0].customer_type === 'individual');
r = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name, gstin) VALUES ('x1','Bad','27ABC')`);
check('an invalid GSTIN is refused', /gstin_check/.test(r.err || ''), r);
r = await tryAs(db, A, `INSERT INTO public.hangtag_customers (id, name, customer_type) VALUES ('x2','Bad','company')`);
check('an unknown customer type is refused', /type_check/.test(r.err || ''), r);
r = await tryAs(db, A, `UPDATE public.hangtag_customers SET name='Shah Traders Pvt', customer_type='business' WHERE id='i1'`);
check('customers can be edited', !r.err && (await as(db, A, `SELECT name FROM public.hangtag_customers WHERE id='i1'`)).rows[0].name === 'Shah Traders Pvt');
check("shop B can't see shop A's customers", (await as(db, B, `SELECT count(*)::int n FROM public.hangtag_customers`)).rows[0].n === 0);
r = await tryAs(db, B, `UPDATE public.hangtag_customers SET name='hacked' WHERE id='b1'`);
check("shop B can't change them", (await as(db, A, `SELECT name FROM public.hangtag_customers WHERE id='b1'`)).rows[0].name === 'Shah Traders');
r = await tryAs(db, B, `INSERT INTO public.hangtag_customers (owner_id, id, name) VALUES ('${A}','sneak','Sneak')`);
check("shop B can't add a customer into shop A", !!r.err, r);
r = await tryAs(db, B, `INSERT INTO public.hangtag_customers (id, name) VALUES ('b1','Same id, other shop')`);
check('the same customer id may exist in another shop (ids are per shop)', !r.err, r);
check('signed-out visitors get nothing', /permission denied/.test((await tryAs(db, null, `SELECT * FROM public.hangtag_customers`)).err || ''));
await db.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
