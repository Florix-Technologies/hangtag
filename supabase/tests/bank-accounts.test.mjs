// Bank accounts (schema.sql section 3s, migration 20261004120000_hangtag_bank_accounts.sql): the owner adds accounts and
// entries; a manager may too (manage_settings / view_reports); a cashier sees and writes none; entries are never changed or
// removed; a transfer names another account; an adjustment and a reversal say why; a reversal is of a whole entry, once;
// another shop never sees them; the migration file runs on top of schema.sql and the report stays all ok.
// Run: node supabase/tests/bank-accounts.test.mjs
import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import fs from 'fs';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIG = fs.readFileSync(new URL('../migrations/20261004120000_hangtag_bank_accounts.sql', import.meta.url), 'utf8');
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
const MGR = { id: '33333333-3333-3333-3333-333333333333', key: 'dev-key-manager-000000000000000000', dev: 'dev-manager-1', role: 'manager', username: 'meera' };
const CSH = { id: '44444444-4444-4444-4444-444444444444', key: 'dev-key-cashier-000000000000000000', dev: 'dev-cashier-1', role: 'cashier', username: 'ravi' };
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
async function as(db, who, sql, params) {
  const id = typeof who === 'string' ? who : who && who.id, key = who && typeof who === 'object' ? who.key : null;
  await db.exec(`SET ROLE ${id ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`,
    [id || '', key ? JSON.stringify({ authorization: 'Bearer x', 'x-hangtag-device': key }) : JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const tryAs = async (db, who, sql, params) => { try { return { r: await as(db, who, sql, params) }; } catch (e) { return { err: e.message, code: e.code }; } };
const hash = (k) => crypto.createHash('sha256').update(k, 'utf8').digest('hex');
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'owner@a.test'), ($2, 'owner@b.test'), ($3, 'meera@staff'), ($4, 'ravi@staff')`, [A, B, MGR.id, CSH.id]);
await db.exec(NEW);
await db.exec(MIG);   // the migration runs on top of schema.sql (and again: safe to run twice)
await db.exec(MIG);
for (const m of [MGR, CSH]) {
  await db.exec('SET ROLE service_role');
  await db.query(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role, status, created_by) VALUES ($1, $2, $3, $4, $5, 'active', $2)`, [m.id, A, 'Staff', m.username, m.role]);
  await db.query(`INSERT INTO public.hangtag_devices (owner_id, id, user_id, name, platform, key_hash) VALUES ($1, $2, $3, 'Phone', 'Android', $4)`, [A, m.dev, m.id, hash(m.key)]);
  await db.exec('RESET ROLE');
}
const T = Date.now();

console.log('=== accounts ===');
{
  let r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_accounts (id, name, bank, last4, opening, opening_date, is_default, methods) VALUES ('hdfc', 'HDFC Current', 'HDFC Bank', '4321', 50000, '2026-10-01', true, '{upi}'), ('icici', 'ICICI Savings', 'ICICI Bank', NULL, 12000, '2026-10-01', false, '{card}')`);
  check('the owner adds accounts (owner_id is the shop)', !r.err && (await as(db, A, `SELECT owner_id FROM public.hangtag_bank_accounts`)).rows.every((x) => x.owner_id === A), r.err);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_accounts (id, name, last4) VALUES ('x1', 'Bad', '12345')`);
  check('last 4 digits are exactly 4 digits (never an account number)', !!r.err, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_accounts (id, name, methods) VALUES ('x2', 'Bad', '{cash}')`);
  check('only UPI and card money can land in an account', !!r.err, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_bank_accounts SET active = false WHERE id = 'icici' RETURNING updated_at > created_at OR true AS ok`);
  check('an account can be switched off (changed, never removed)', !r.err && r.r.rows.length === 1, r.err);
  await as(db, A, `UPDATE public.hangtag_bank_accounts SET active = true WHERE id = 'icici'`);
  r = await tryAs(db, A, `DELETE FROM public.hangtag_bank_accounts WHERE id = 'icici'`);
  check('…but not deleted (no delete grant)', !!r.err, r);
  check('the manager reads the accounts', (await as(db, MGR, `SELECT count(*)::int n FROM public.hangtag_bank_accounts`)).rows[0].n === 2);
  r = await tryAs(db, MGR, `INSERT INTO public.hangtag_bank_accounts (id, name) VALUES ('mgr', 'Petty bank')`);
  check('the manager (manage_settings) adds an account to the shop', !r.err && (await as(db, A, `SELECT count(*)::int n FROM public.hangtag_bank_accounts WHERE id = 'mgr'`)).rows[0].n === 1, r.err);
  check('a cashier sees no bank accounts', (await as(db, CSH, `SELECT count(*)::int n FROM public.hangtag_bank_accounts`)).rows[0].n === 0);
  r = await tryAs(db, CSH, `INSERT INTO public.hangtag_bank_accounts (id, name) VALUES ('c1', 'Mine')`);
  check('…and can\'t add one', !!r.err, r);
  check('another shop sees none of them', (await as(db, B, `SELECT count(*)::int n FROM public.hangtag_bank_accounts`)).rows[0].n === 0);
}

console.log('=== entries ===');
{
  let r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, reason, t) VALUES ('m1', 'hdfc', 'in', 2500, 'Loan from partner', $1)`, [T]);
  check('money in', !r.err, r.err);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, to_account, reason, t) VALUES ('m2', 'hdfc', 'transfer', 5000, 'icici', 'Top up', $1)`, [T + 1]);
  check('a transfer to another account of the shop', !r.err, r.err);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, to_account, t) VALUES ('m3', 'hdfc', 'transfer', 10, 'hdfc', $1)`, [T]);
  check('a transfer to the same account is refused', !!r.err, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, t) VALUES ('m4', 'hdfc', 'adjust', -118, $1)`, [T]);
  check('an adjustment needs its reason', !!r.err, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, reason, t) VALUES ('m5', 'hdfc', 'adjust', -118, 'Bank charges', $1)`, [T + 2]);
  check('…with it, it may take the balance down', !r.err, r.err);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, t) VALUES ('m6', 'hdfc', 'out', -50, $1)`, [T]);
  check('money out is a positive amount (only adjustments and reversals are signed)', !!r.err, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, t) VALUES ('m7', 'nope', 'in', 50, $1)`, [T]);
  check('an entry needs an account of the shop', !!r.err, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, to_account, reason, reverses, t) VALUES ('r2', 'hdfc', 'reversal', 5000, 'icici', 'Entered twice', 'm2', $1)`, [T + 3]);
  check('a reversal of a whole transfer (same accounts, same amount)', !r.err, r.err);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, to_account, reason, reverses, t) VALUES ('r2b', 'hdfc', 'reversal', 5000, 'icici', 'Again', 'm2', $1)`, [T + 4]);
  check('…only once', !!r.err, r);
  r = await tryAs(db, A, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, reason, reverses, t) VALUES ('r1', 'hdfc', 'reversal', 100, 'Part of it', 'm1', $1)`, [T + 4]);
  check('a reversal of part of an entry is refused', !!r.err, r);
  r = await tryAs(db, A, `UPDATE public.hangtag_bank_moves SET amount = 1 WHERE id = 'm1'`);
  check('entries are never changed', !!r.err || r.r.rowCount === 0, r);
  r = await tryAs(db, A, `DELETE FROM public.hangtag_bank_moves WHERE id = 'm1'`);
  check('…or removed', !!r.err || r.r.rowCount === 0, r);
  r = await tryAs(db, MGR, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, reason, t) VALUES ('mm', 'hdfc', 'out', 1500, 'Rent', $1)`, [T + 5]);
  check('the manager records money out', !r.err, r.err);
  r = await tryAs(db, CSH, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, t) VALUES ('mc', 'hdfc', 'in', 10, $1)`, [T]);
  check('a cashier can\'t record bank entries', !!r.err, r);
  check('a cashier reads none', (await as(db, CSH, `SELECT count(*)::int n FROM public.hangtag_bank_moves`)).rows[0].n === 0);
  check('another shop reads none', (await as(db, B, `SELECT count(*)::int n FROM public.hangtag_bank_moves`)).rows[0].n === 0);
  r = await tryAs(db, B, `INSERT INTO public.hangtag_bank_moves (id, account_id, type, amount, t) VALUES ('bx', 'hdfc', 'in', 10, $1)`, [T]);
  check('another shop can\'t write into this shop\'s account', !!r.err, r);
}

console.log('=== the report ===');
{
  const rep = await report(db);
  check('migration report: 73 rows, all ok with bank accounts and entries', rep.length === 73 && rep.every((x) => x.ok), rep.filter((x) => !x.ok));
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
