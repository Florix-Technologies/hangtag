// Bills sent to customers and the shop logo in the database (schema.sql section 3f): delivery records are written only by
// the send-receipt Edge Function (service role) and read by their own shop; an attempt starts "pending" and becomes "sent"
// only with the provider's message id; deleting a bill keeps its records (the bill link is cleared), so the log and the
// hourly limit can't be erased; the logo lives in hangtag_meta with a size limit. PGlite with Supabase stand-ins.
// Run: npm run test:db
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
// the Edge Function writes with the service role (it bypasses row security, like the database owner here)
const asService = async (db, sql, params) => { try { return { r: await db.query(sql, params) }; } catch (e) { return { err: e.message }; } };
async function fresh() { const db = new PGlite(); await db.exec(SUPABASE); await db.query(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.in'),($2,'b@x.in')`, [A, B]); return db; }
const n = async (db, uid, where = '') => (await as(db, uid, `SELECT count(*)::int n FROM public.hangtag_deliveries ${where}`)).rows[0].n;
const ins = (owner, sale, channel, status, pid, extra = {}) => asService(db, `INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, provider_message_id, error)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [owner, sale, channel, extra.to || 'riya@mail.in', status, extra.provider || 'resend', pid, extra.error || null]);

console.log('=== upgrade keeps existing data; runs twice ===');
{
  const up = await fresh();
  await up.exec(V5);
  await as(up, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s0', 1790000000000, 500, 500, 'cash')`);
  await up.exec(NEW); await up.exec(NEW);
  check('existing bills kept; the deliveries table is there and empty', (await as(up, A, `SELECT count(*)::int n FROM public.hangtag_sales`)).rows[0].n === 1 && (await n(up, A)) === 0);
  await up.close();
}

console.log('\n=== delivery records ===');
const db = await fresh();
await db.exec(NEW);
await as(db, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s1', 1790000000000, 500, 500, 'cash'), ('s2', 1790000001000, 700, 700, 'upi')`);
await as(db, B, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s1', 1790000002000, 900, 900, 'card')`);
let r = await ins(A, 's1', 'email', 'sent', 're_123');
check('the function records a sent email with the provider\'s id', !r.err, r.err);
r = await ins(A, 's1', 'sms', 'failed', null, { to: '+919845012345', provider: 'twilio', error: 'The To number is not valid' });
check('…and a failed SMS with the reason', !r.err, r.err);
r = await ins(A, 's1', 'whatsapp', 'sent', null, { to: '+919845012345', provider: 'meta' });
check('"sent" without the provider\'s message id is refused (no false success)', /hangtag_deliveries_sent_check/.test(r.err || ''), r);
r = await ins(A, 's1', 'fax', 'sent', 'x');
check('only email, WhatsApp and SMS', /channel_check|violates check/.test(r.err || ''), r);
r = await ins(A, 's1', 'email', 'delivered', 'x');
check('only pending / sent / failed (delivery to the inbox is not claimed)', /status_check|violates check/.test(r.err || ''), r);
// the function's flow: take a place as "pending", then finish the row
r = await asService(db, `INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider) VALUES ($1,'s2','email','riya@mail.in','pending','resend') RETURNING id`, [A]);
const pid = r.r && r.r.rows[0].id;
check('an attempt starts as pending, without a message id', !r.err && !!pid, r.err);
r = await asService(db, `UPDATE public.hangtag_deliveries SET status = 'sent' WHERE id = $1`, [pid]);
check('…it can\'t become sent without the provider\'s id', /hangtag_deliveries_sent_check/.test(r.err || ''), r);
r = await asService(db, `UPDATE public.hangtag_deliveries SET status = 'sent', provider_message_id = 're_77' WHERE id = $1`, [pid]);
check('…and becomes sent with it', !r.err && (await as(db, A, `SELECT status FROM public.hangtag_deliveries WHERE id = $1`, [pid])).rows[0].status === 'sent', r.err);
check('pending rows count toward the hourly limit like the rest (the function counts every row of the last hour)', (await n(db, A, `WHERE created_at > now() - interval '1 hour'`)) === 3);
r = await ins(A, 'nope', 'email', 'sent', 'x');
check('a record must point at a real bill of the same shop', /hangtag_deliveries_sale_fkey|foreign key/.test(r.err || ''), r);
r = await ins(A, 's1', 'email', 'failed', null, { error: 'x'.repeat(301) });
check('reasons are at most 300 characters', /error_check|violates check/.test(r.err || ''), r);
check('the shop reads its own bill\'s records', (await n(db, A, `WHERE sale_id = 's1'`)) === 2 && (await as(db, A, `SELECT status FROM public.hangtag_deliveries WHERE channel = 'email' AND sale_id = 's1'`)).rows[0].status === 'sent');
r = await tryAs(db, A, `INSERT INTO public.hangtag_deliveries (sale_id, channel, recipient, status, provider_message_id) VALUES ('s2','email','x@y.in','sent','fake')`);
check('the app can\'t write a record itself (so it can\'t fake "sent")', /permission denied/.test(r.err || ''), r);
r = await tryAs(db, A, `UPDATE public.hangtag_deliveries SET status = 'sent', provider_message_id = 'fake' WHERE channel = 'sms'`);
check('…nor change one', /permission denied/.test(r.err || ''), r);
r = await tryAs(db, A, `DELETE FROM public.hangtag_deliveries`);
check('…nor delete them', /permission denied/.test(r.err || ''), r);
check("another shop sees none of them (even for its own bill with the same id)", (await n(db, B)) === 0);
r = await tryAs(db, A, `UPDATE public.hangtag_deliveries SET status = 'sent', provider_message_id = 'fake' WHERE id = $1`, [pid]);
check('the app can\'t finish a pending attempt as sent either', /permission denied/.test(r.err || ''), r);
r = await ins(B, 's1', 'email', 'sent', 're_b');
check("B's record points at B's own bill s1", !r.err && (await n(db, B)) === 1 && (await n(db, A, `WHERE sale_id = 's1'`)) === 2, r.err);
check('signed-out visitors can\'t read them', /permission denied/.test((await tryAs(db, null, `SELECT * FROM public.hangtag_deliveries`)).err || ''));
await as(db, A, `DELETE FROM public.hangtag_sales WHERE id = 's1'`);
check("deleting a bill keeps its delivery records (the bill link is cleared): the log and the hourly count can't be erased that way",
  (await n(db, A)) === 3 && (await n(db, A, `WHERE sale_id IS NULL`)) === 2 && (await n(db, A, `WHERE sale_id = 's2'`)) === 1 && (await n(db, B)) === 1);
check("B's records are untouched", (await as(db, B, `SELECT sale_id FROM public.hangtag_deliveries`)).rows[0].sale_id === 's1');
{
  const gone = await fresh(); await gone.exec(NEW);
  await as(gone, A, `INSERT INTO public.hangtag_sales (id, timestamp, subtotal, total, payment_method) VALUES ('s9', 1790000000000, 500, 500, 'cash')`);
  await gone.query(`INSERT INTO public.hangtag_deliveries (owner_id, sale_id, channel, recipient, status, provider, provider_message_id) VALUES ($1,'s9','email','riya@mail.in','sent','resend','re_1')`, [A]);
  const del = await gone.query(`DELETE FROM auth.users WHERE id = $1`, [A]).then(() => null, (e) => e.message);
  check('deleting an account still removes all its bills and delivery records', del === null && (await gone.query(`SELECT count(*)::int n FROM public.hangtag_deliveries`)).rows[0].n === 0, del);
  await gone.close();
}

console.log('\n=== shop logo ===');
const small = 'data:image/jpeg;base64,' + 'A'.repeat(1000), big = 'data:image/jpeg;base64,' + 'A'.repeat(400001);
r = await tryAs(db, A, `INSERT INTO public.hangtag_meta (key, value) VALUES ('logo', $1::jsonb) ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ data: small })]);
check('a small logo is saved in the shop\'s settings store', !r.err, r.err);
r = await tryAs(db, A, `UPDATE public.hangtag_meta SET value = $1::jsonb WHERE key = 'logo'`, [JSON.stringify({ data: big })]);
check('a huge picture is refused (about 300 KB limit)', /hangtag_meta_logo_size_check/.test(r.err || ''), r);
r = await tryAs(db, A, `INSERT INTO public.hangtag_meta (key, value) VALUES ('notes', $1::jsonb)`, [JSON.stringify({ data: big })]);
check('the limit is only for the logo', !r.err, r.err);
check("another shop can't read the logo", (await as(db, B, `SELECT count(*)::int n FROM public.hangtag_meta WHERE key = 'logo'`)).rows[0].n === 0);
await db.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
