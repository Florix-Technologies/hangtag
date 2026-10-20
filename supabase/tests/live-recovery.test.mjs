// What happened to the live database on 2026-10-13, and the way back, rehearsed on PGlite (never on the live project).
// Between 20:39 and 20:45 IST, after the whole schema.sql had run, the section files were run again newest-first (3za … 3r)
// and then the very first migration: 18 functions went back to older versions, and the first migration's six
// "Public access to …" policies came back. Those are always true, and policies are OR-ed, so every signed-in account could
// read and change every shop's bills, bill lines, products, pictures and settings; and the app's single-row reads of the
// shop's settings and logo got one row per shop (PostgREST refuses those: PGRST116), so every download stopped there
// ("Pull from Supabase failed" from 20:49).
// This suite: (1) the first two migrations, as guarded now, change nothing on a current database (the second, as it was,
// would renumber bill lines by their random ids); (2) the incident recreated with the files as they were: report row 96
// counts the open tables, the section rows name the old functions; (3) the way back — schema.sql once more: every function
// as on a fresh database, no open table, the report all ok, and every shop row exactly as it was; (4) each shop sees only
// its own rows again. Run: node supabase/tests/live-recovery.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'fs';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs } from '../../src/infrastructure/supabase/mappers.js';
import { readLeaks, shopTables } from '../../tests/helpers/tenancy.mjs';
import { REPORT_ROWS } from './report-rows.mjs';

const NEW = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIGS = new URL('../migrations/', import.meta.url);
const file = (name) => fs.readFileSync(new URL(name, MIGS), 'utf8');
const INITIAL = file('20260923102731_hangtag_initial_schema.sql'), LINE_NO = file('20260923103616_hangtag_sale_items_line_no.sql');
// the two files as they were until today: the same, without the guard that now leaves a current database alone
const INITIAL_AS_IT_WAS = INITIAL.replace(/    IF EXISTS \(SELECT 1 FROM information_schema\.columns WHERE table_schema = 'public' AND table_name = 'hangtag_meta' AND column_name = 'owner_id'\) THEN\n        RETURN;\n    END IF;\n/, '');
const LINE_NO_AS_IT_WAS = `ALTER TABLE public.hangtag_sale_items ADD COLUMN IF NOT EXISTS line_no INTEGER NOT NULL DEFAULT 0;
UPDATE public.hangtag_sale_items t SET line_no = r.rn
FROM (SELECT id, (row_number() OVER (PARTITION BY sale_id ORDER BY id)) - 1 AS rn FROM public.hangtag_sale_items) r
WHERE t.id = r.id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_hangtag_sale_items_line ON public.hangtag_sale_items(sale_id, line_no);`;
// the section files, newest first (as they were run on 2026-10-13: the ones that existed then, 3r … 3za; a later file,
// such as the post-repair migration, wasn't part of it)
const SECTIONS_NEWEST_FIRST = fs.readdirSync(MIGS).filter((f) => /^202610\d{8}_.+\.sql$/.test(f) && f.slice(0, 14) <= '20261013120000').sort().reverse();
// the functions whose bodies differed from schema.sql on the live project at 21:17 IST that evening (read from its catalog)
const LIVE_OLDER = ['hangtag_access_ok(p_owner uuid)', 'hangtag_biz_changes()', 'hangtag_cap_on(p_owner uuid, p_cap text)',
  'hangtag_import_stock(p_import jsonb, p_products jsonb, p_variants jsonb, p_moves jsonb, p_allow_duplicate boolean)', 'hangtag_mobile_catalog(p_token text)',
  'hangtag_mobile_order_status(p_order_token text)', 'hangtag_place_mobile_order(p_token text, p_items jsonb, p_customer jsonb, p_checkout_key text, p_note text, p_payment text, p_mode text)',
  'hangtag_platform_dashboard()', 'hangtag_platform_permissions(p_role text)', 'hangtag_promo_evaluate(p_owner uuid, p_plan text, p_code text)', 'hangtag_save_sales(p_bills jsonb)',
  'hangtag_subscription_activate(p_payment uuid, p_provider_payment text, p_amount numeric)', 'hangtag_subscription_checkout(p_plan text, p_promo text, p_provider text)',
  'hangtag_subscription_ensure(p_owner uuid)', 'hangtag_subscription_plans()', 'hangtag_subscription_quote(p_plan text, p_promo text)',
  'hangtag_subscription_state(p_owner uuid, p_now timestamp with time zone)', 'hangtag_subscription_status()'].sort();

const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 900) : '')); };
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
async function as(db, id, sql, params) {
  await db.exec(`SET ROLE ${id ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [id || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(sql, params); } finally { await db.exec('RESET ROLE'); }
}
const one = async (db, id, sql, params) => (await as(db, id, sql, params)).rows[0];
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const row96 = (rep) => rep.find((r) => /open to every account/.test(r.check_name));
/* the checks the runbook runs on the live project (supabase/checks/): each file's last result set */
const CHECKS = new URL('../checks/', import.meta.url);
const runCheck = async (db, name) => (await db.exec(fs.readFileSync(new URL(name, CHECKS), 'utf8'))).at(-1).rows;
/* RELEASE.md's repair: the whole schema.sql in one explicit transaction, never waiting long for a lock */
const REPAIR = `BEGIN;\nSET LOCAL lock_timeout = '10s';\n${NEW}\nCOMMIT;`;
/* every Hangtag function's body, as a fingerprint */
const functions = async (db) => Object.fromEntries((await db.query(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
  md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hangtag%'`)).rows.map((r) => [r.k, r.v]));
const changedFunctions = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]).sort();
/* every row of every shop table, as one fingerprint per table (read by the database owner: no row security) */
async function data(db, tables) {
  const out = {};
  for (const t of tables) out[t] = (await db.query(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM (SELECT to_jsonb(r) AS x FROM public.${t} r) s`)).rows[0];
  return out;
}
const changedTables = (a, b) => Object.keys(a).filter((t) => a[t].n !== b[t].n || a[t].h !== b[t].h);
const openPolicies = async (db) => (await db.query(`SELECT tablename || ': ' || policyname AS p FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'Public access to %' ORDER BY 1`)).rows.map((r) => r.p);

/* A bill of three lines (Tee, Cap, Belt), paid in cash */
function bill(id) {
  const prices = [500, 200, 300];
  const T = computeCheckout({ lines: prices.map((price) => ({ q: 1, price, rate: 0 })), billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, [{ method: 'cash', amount: T.total }], { customer: false });
  const names = ['Tee', 'Cap', 'Belt'];
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: T.lines.map((L, ln) => ({ ln, p: 'p' + ln, v: 'p' + ln + ':', n: names[ln], c: '', s: '', vl: '', ov: [], sku: '', q: 1, price: prices[ln], cost: null, dAmt: 0, bdAmt: 0,
      gst: 0, hsn: '', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total })),
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'cash', payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}

const db = new PGlite();
await db.exec(SUPABASE);
await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.test'), ($2, 'b@shop.test')`, [A, B]);
await db.exec(NEW);
for (const [owner, name] of [[A, 'Shop A'], [B, 'Shop B']]) {
  await as(db, owner, `UPDATE public.hangtag_profiles SET shop_name = $2, business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [owner, name]);
  for (const [i, n, price] of [[0, 'Tee', 500], [1, 'Cap', 200], [2, 'Belt', 300]]) {
    await as(db, owner, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ($1, $2, $3, '{"opts":[]}')`, ['p' + i, n, price]);
    await as(db, owner, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ($1, $2, '[]')`, ['p' + i + ':', 'p' + i]);
    await as(db, owner, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ($1, $2, $3, 'OPENING', 10, 1)`, ['open:p' + i, 'p' + i + ':', 'p' + i]);
  }
  await as(db, owner, `INSERT INTO public.hangtag_images (product_id, image_data) VALUES ('p0', 'data:image/png;base64,AA==')`);
  await as(db, owner, `INSERT INTO public.hangtag_sizes (product_id, size, stock) VALUES ('p0', 'M', 0)`);   // the old size list (kept, no stock)
  await as(db, owner, `INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', $1), ('logo', '{"data":"data:image/png;base64,AA=="}')`, [JSON.stringify({ prefix: name === 'Shop A' ? 'A-' : 'B-' })]);
  const saved = await as(db, owner, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([billArgs(bill('s1'))])]);
  if (!saved.rows[0]) throw new Error('bill not saved');
}
const lines = async () => (await db.query(`SELECT owner_id::text AS o, sale_id, line_no, product_name FROM public.hangtag_sale_items ORDER BY 1, 2, 3`)).rows;
const TABLES = await shopTables(db);
const FRESH = await functions(db), DATA0 = await data(db, TABLES), LINES0 = await lines();
const rep0 = await report(db);
check(`a current database with two shops: the report is all ok (${REPORT_ROWS} rows), row 96 is 0, and each shop sees only its own settings`,
  rep0.length === REPORT_ROWS && rep0.every((r) => r.ok) && row96(rep0) && +row96(rep0).value === 0
  && (await one(db, A, `SELECT count(*)::int AS n FROM public.hangtag_meta WHERE key = 'settings'`)).n === 1, rep0.filter((r) => !r.ok));

console.log('=== (1) the first two migrations, as guarded now, change nothing on a current database ===');
{
  await db.exec(INITIAL);
  await db.exec(LINE_NO);
  check('the first migration run again: no "Public access" policy comes back', (await openPolicies(db)).length === 0, await openPolicies(db));
  check('the line-number migration run again: every bill line keeps its number', JSON.stringify(await lines()) === JSON.stringify(LINES0));
  check('…and no shop row changed, no function either', changedTables(DATA0, await data(db, TABLES)).length === 0 && changedFunctions(FRESH, await functions(db)).length === 0);
  // as it was: it numbers every bill's lines again by their random ids — each bill's lines reordered or, as here, refused
  // by the shop's line key (rolled back either way)
  await db.exec('BEGIN');
  let err = null;
  try { await db.exec(LINE_NO_AS_IT_WAS); } catch (e) { err = e.message; }
  const after = err ? null : await lines();
  await db.exec('ROLLBACK');
  check('the line-number file as it was would renumber bill lines by their random ids (or fail on the line key) — the guard keeps it out',
    !!err || JSON.stringify(after) !== JSON.stringify(LINES0), { err, after });
  check('…(rolled back here: the lines are as they were)', JSON.stringify(await lines()) === JSON.stringify(LINES0));
}

console.log('=== (2) the incident: the section files newest-first, then the first migration as it was ===');
{
  const ran = [];
  for (const f of SECTIONS_NEWEST_FIRST) { await db.exec(file(f)); ran.push(f.slice(0, 14)); }
  await db.exec(INITIAL_AS_IT_WAS);
  check(`the files ran as on the live project (${ran.length} section files, 3za … 3r, then the first migration)`, ran.length === 10 && ran[0] === '20261013120000' && ran.at(-1) === '20261003120000', ran);
  const old = changedFunctions(FRESH, await functions(db));
  check('18 functions are now older versions — exactly the 18 found older on the live project that evening', JSON.stringify(old) === JSON.stringify(LIVE_OLDER), old);
  check('the six "Public access" policies are back', (await openPolicies(db)).length === 6, await openPolicies(db));
  const settingsRows = (await one(db, A, `SELECT count(*)::int AS n FROM public.hangtag_meta WHERE key = 'settings'`)).n;
  check('shop A\'s owner now reads 2 "settings" rows (one per shop): the single-row read the app makes is refused (PGRST116), so every download stops',
    settingsRows === 2, settingsRows);
  const seen = await one(db, A, `SELECT (SELECT count(*) FROM public.hangtag_sales WHERE owner_id = $1)::int AS sales, (SELECT count(*) FROM public.hangtag_products WHERE owner_id = $1)::int AS products,
    (SELECT count(*) FROM public.hangtag_sale_items WHERE owner_id = $1)::int AS lines`, [B]);
  check('…and shop A sees shop B\'s bills, bill lines and products', seen.sales === 1 && seen.products === 3 && seen.lines === 3, seen);
  await db.exec('BEGIN');
  const changed = (await as(db, A, `UPDATE public.hangtag_meta SET value = '{"prefix":"HACKED"}' WHERE owner_id = $1 AND key = 'settings' RETURNING key`, [B])).rows.length;
  await db.exec('ROLLBACK');
  check('…and can change shop B\'s settings (rolled back here)', changed === 1);
  const rep = await report(db), bad = rep.filter((r) => !r.ok).map((r) => r.check_name.slice(0, 70));
  console.log('     report rows not ok:', JSON.stringify(bad));
  check('the report says so: row 96 counts the 6 open tables, and the section rows name the older functions', +row96(rep).value === 6 && !row96(rep).ok
    && bad.length > 1, bad);
  check('the incident itself changed no shop row', changedTables(DATA0, await data(db, TABLES)).length === 0, changedTables(DATA0, await data(db, TABLES)));
  // the runbook's checks see it too
  const fv = await runCheck(db, '2026-10-13-function-versions.sql');
  check('checks/2026-10-13-function-versions.sql: 18 functions OLDER VERSION, the 3 indexes STILL THERE', fv.filter((r) => r.state === 'OLDER VERSION').length === 18
    && fv.filter((r) => r.state === 'STILL THERE').length === 3 && fv.length === 21, fv.filter((r) => r.state !== 'OLDER VERSION'));
  check('checks/open-policies.sql: the six "Public access" policies', (await runCheck(db, 'open-policies.sql')).length === 6);
  const probe = await runCheck(db, 'shop-isolation-probe.sql');
  check('checks/shop-isolation-probe.sql: each shop sees and changes the other\'s rows', probe.filter((r) => /^ALLOWED/.test(r.result)).length > 0
    && probe.some((r) => r.probe === '1 read' && /other shops' rows visible: [1-9]/.test(r.result)), probe.slice(0, 6));
}

console.log('=== (3) the way back: schema.sql once more, as RELEASE.md runs it ===');
{
  const dry = (await runCheck(db, 'schema-dry-run.sql'))[0].dryrun;
  check('checks/schema-dry-run.sql before it: every one of the 26 data changes would touch 0 rows', Object.keys(dry).length === 26 && Object.values(dry).every((n) => +n === 0), dry);
  const fpBefore = await runCheck(db, 'data-fingerprint.sql');
  await db.exec(REPAIR);
  const fpAfter = await runCheck(db, 'data-fingerprint.sql');
  check(`checks/data-fingerprint.sql: the same before and after, for every one of the ${fpBefore.length} shop tables`,
    fpBefore.length === TABLES.length && JSON.stringify(fpBefore) === JSON.stringify(fpAfter), fpAfter.filter((r, i) => JSON.stringify(r) !== JSON.stringify(fpBefore[i])));
  const rep = await report(db);
  check('every function is as on a fresh database again', changedFunctions(FRESH, await functions(db)).length === 0, changedFunctions(FRESH, await functions(db)));
  check('no "Public access" policy is left; report row 96 is 0', (await openPolicies(db)).length === 0 && +row96(rep).value === 0);
  check(`the report is all ok (${REPORT_ROWS} rows)`, rep.length === REPORT_ROWS && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
  const moved = changedTables(DATA0, await data(db, TABLES));
  check('every row of every shop table is exactly as before (bills, lines, payments, products, stock, settings…)', moved.length === 0, moved);
  check('…bill lines keep their numbers', JSON.stringify(await lines()) === JSON.stringify(LINES0));
  const fv = await runCheck(db, '2026-10-13-function-versions.sql');
  check('checks/2026-10-13-function-versions.sql: all 21 ok', fv.length === 21 && fv.every((r) => r.state === 'ok'), fv.filter((r) => r.state !== 'ok'));
  check('checks/open-policies.sql: none', (await runCheck(db, 'open-policies.sql')).length === 0);
  const probe = await runCheck(db, 'shop-isolation-probe.sql');
  const want = { '1 read': /other shops' rows visible: 0; own rows visible: [1-9]/, '2 change other shop': /^blocked \(0 rows\)$/, '3 delete other shop': /^blocked \(0 rows\)$/,
    '4 add as other shop': /^blocked by row security \(42501\)$/, '5 change own row': /^works \(1 row\)$/ };
  check('checks/shop-isolation-probe.sql: no shop reads, changes, deletes or adds the other\'s rows; each changes its own', probe.length === 60
    && probe.every((r) => want[r.probe] && want[r.probe].test(r.result)), probe.filter((r) => !(want[r.probe] && want[r.probe].test(r.result))));
  check('…and the probe itself left every shop row as it was', changedTables(DATA0, await data(db, TABLES)).length === 0);
  const RESTRICTED = /^hangtag_(backup_v\d+_\w+|subscriptions|trial_claims|promo_redemptions|webhook_secrets):42501$/;
  const sync = await runCheck(db, 'sync-read-isolation.sql');
  check('checks/sync-read-isolation.sql: a full sync as either owner reads no other shop\'s row, in any shop table; refusals only where the app never reads directly',
    sync.length === 2 && sync.every((r) => +r.rows_of_other_shops === 0 && +r.rows_visible > 0 && +r.tables === TABLES.length
      && String(r.errors || '').split(', ').filter(Boolean).every((e) => RESTRICTED.test(e))), sync);
}

console.log('=== (5) the repair\'s undo (checks/2026-10-13-repair-undo.sql, captured from the live project) ===');
{
  // the incident's functions are the live project's, byte for byte: the undo must give exactly them back, then the repair again
  await db.exec(fs.readFileSync(new URL('2026-10-13-repair-undo.sql', CHECKS), 'utf8'));
  const fv = await runCheck(db, '2026-10-13-function-versions.sql');
  check('after the undo: the 18 functions are the live project\'s pre-repair versions again, the 3 indexes back', fv.filter((r) => r.state === 'OLDER VERSION').length === 18
    && fv.filter((r) => r.state === 'STILL THERE').length === 3, fv.filter((r) => r.state === 'ok'));
  check('…and they are byte for byte the bodies the incident left (the same 18 as the live project)', JSON.stringify(changedFunctions(FRESH, await functions(db))) === JSON.stringify(LIVE_OLDER));
  check('…it changed no shop row', changedTables(DATA0, await data(db, TABLES)).length === 0);
  await db.exec(REPAIR);
  check('the repair applies again on top of it: all 21 ok', (await runCheck(db, '2026-10-13-function-versions.sql')).every((r) => r.state === 'ok'));
}

console.log('=== (4) each shop sees only its own rows again ===');
{
  check('shop A reads 1 "settings" row (its own)', (await one(db, A, `SELECT count(*)::int AS n FROM public.hangtag_meta WHERE key = 'settings'`)).n === 1);
  const run = (who, sql, params) => as(db, who, sql, params);
  const leaks = [...await readLeaks({ run, tables: TABLES, victim: B, attackers: [['A', A], ['signed out', null]] }),
    ...await readLeaks({ run, tables: TABLES, victim: A, attackers: [['B', B], ['signed out', null]] })];
  check(`no shop (nor anyone signed out) sees a row of the other, in any of the ${TABLES.length} shop tables`, leaks.length === 0, leaks);
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
