// The post-repair migration (supabase/migrations/20261019120000_hangtag_post_repair_integrity.sql), in the runbook's order on
// a database built like the live project: the section files of 2026-10-13 over schema.sql (its 18 older functions), then
// the repair (schema.sql again: every function current, the 13 Oct version check all ok), then the migration, twice.
// - each function it takes from schema.sql is schema.sql's text with exactly the edits listed in post-repair-edits.mjs;
// - outside function bodies it writes rows and changes tables, indexes, triggers and policies only of its own tables
//   (and its two triggers on products and stock records);
// - returns: one return of a bill line at a time (the line's lock is held by the transaction); never more back than bought;
// - stock records of tracked products carry their serial numbers or batch, on any path; others are as before;
// - bills keep the unit sent (through the app's own mapper), a line without one gets its product's, a re-sent line keeps
//   the first, an unknown unit is refused;
// - a deleted product leaves a mark its shop can read and nobody else; no app account writes one;
// - capabilities answer an app account about its own shop only; the public store page (no session) still works;
// - plan billing: a notification is known the second time, money for review is kept once; app accounts can't touch either;
//   a suspended shop can't start a payment, and one it started before is still honoured (the billing remediation itself:
//   billing-consistency.test.mjs);
// - every shop table, the new one included, is closed to other shops, outsiders and the signed-out;
// - the undo puts every changed function back exactly, grants included, and removes what it says; applying the migration
//   again works; the undo and then the 2026-10-13 repair undo give the live project's functions back.
// Run: node supabase/tests/post-repair-integrity.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs, returnArgs } from '../../src/infrastructure/supabase/mappers.js';
import { readLeaks, shopTables, writeLeaks } from '../../tests/helpers/tenancy.mjs';
import { FUNCTION_EDITS, applyEdits, fnText } from './post-repair-edits.mjs';

const at = (p) => new URL(p, import.meta.url);
const read = (p) => fs.readFileSync(at(p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
const SCHEMA = read('../schema.sql'), MIG = read('../migrations/20261019120000_hangtag_post_repair_integrity.sql');
const UNDO = read('../operations/post-repair-integrity-undo.sql');
const SECTIONS = fs.readdirSync(at('../migrations/')).filter((f) => /^202610\d{8}_.+\.sql$/.test(f) && f.slice(0, 14) <= '20261013120000').sort().reverse();
// the migration's own tables (created by it); everything else in the database existed before it
const OWN_TABLES = ['hangtag_deleted_products', 'hangtag_billing_settings', 'hangtag_billing_events', 'hangtag_billing_exceptions',
  'hangtag_autopay_mandates', 'hangtag_billing_reconcile_runs', 'hangtag_billing_probes', 'hangtag_billing_payment_checks', 'hangtag_billing_call_counts'];
const REPORT_N = 13;

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(SCHEMA);
const fns = async () => Object.fromEntries((await db.query(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
  md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hangtag%'`)).rows.map((r) => [r.k, r.v]));
// who may run each function, and how (its grants, owner's rights, settings): the undo must give these back too
const acls = async () => Object.fromEntries((await db.query(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
  COALESCE(p.proacl::text, '') || '|' || p.prosecdef || '|' || COALESCE(array_to_string(p.proconfig, ','), '') AS v
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hangtag%'`)).rows.map((r) => [r.k, r.v]));
const FRESH = await fns(), FRESH_ACL = await acls();
for (const f of SECTIONS) await db.exec(read(`../migrations/${f}`));
const sql = async (q, p) => (await db.query(q, p)).rows;
const last = async (q) => (await db.exec(q)).at(-1).rows;
async function as(who, q, p) {
  await db.exec(`SET ROLE ${who === 'service' ? 'service_role' : who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who && who !== 'service' ? who : '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return (await db.query(q, p)).rows; } catch (e) { return { err: e.message }; } finally { await db.exec('RESET ROLE'); }
}

console.log('=== the runbook\'s order: the live-like database, the repair, then the migration ===');
const LIVE = await fns();
check('before the repair: functions older than schema.sql\'s (the live project\'s 18)', Object.keys(FRESH).filter((k) => FRESH[k] !== LIVE[k]).length === 18);
let early = null; try { await db.exec(MIG); } catch (e) { early = e.message; }
check('the migration run BEFORE the repair: refused at its first statement ("run the repair first"), nothing changed',
  /Run the database repair first/.test(early || '') && JSON.stringify(await fns()) === JSON.stringify(LIVE) && (await sql(`SELECT to_regclass('public.hangtag_deleted_products') AS t`))[0].t === null, early);
await db.exec(`BEGIN;\nSET LOCAL lock_timeout = '10s';\n${SCHEMA}\nCOMMIT;`);
const versions = await last(read('../checks/2026-10-13-function-versions.sql'));
check('the repair (schema.sql once more): every function current, the 13 Oct version check all ok — run before the migration', JSON.stringify(await fns()) === JSON.stringify(FRESH)
  && versions.filter((r) => !/^index /.test(r.object)).every((r) => r.state === 'ok'), versions.filter((r) => r.state !== 'ok'));
// a row of its own report that isn't ok stops the migration before it can commit — here the console functions' grant is
// left out (report row 12), and it is run as the runbook runs it: nothing of it stays
const REPAIRED = await fns();
const SABOTAGED = MIG.replace(/^GRANT EXECUTE ON FUNCTION public\.hangtag_billing_selfcheck_allowed\(\)[^\n]* TO authenticated;$/m, '-- (left out on purpose)');
let stopped = null; try { await db.exec(`BEGIN;\nSET LOCAL lock_timeout = '10s';\n${SABOTAGED}\nCOMMIT;`); } catch (e) { stopped = e.message; }
await db.exec('ROLLBACK');
check('a report row that isn\'t ok (the console functions\' grant left out): the migration stops before it commits, naming the row; nothing of it stays',
  SABOTAGED !== MIG && /post-repair report is not all ok \(12 Billing review in the console/.test(stopped || '') && /Nothing was changed/.test(stopped || '')
  && JSON.stringify(await fns()) === JSON.stringify(REPAIRED) && (await sql(`SELECT to_regclass('public.hangtag_billing_settings') AS t, to_regclass('public.hangtag_deleted_products') AS d`))
    .every((r) => r.t === null && r.d === null), stopped);
const policies = async () => (await sql(`SELECT schemaname || '.' || tablename || ': ' || policyname || ' ' || cmd || ' ' || array_to_string(roles, ',') || ' ' || COALESCE(qual, '') || ' ' || COALESCE(with_check, '') AS p
  FROM pg_policies ORDER BY 1`)).map((r) => r.p);
const rows = async () => { const out = {}; for (const { t } of await sql(`SELECT relname AS t FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' ORDER BY 1`)) {
  out[t] = (await sql(`SELECT count(*)::int AS n, COALESCE(md5(string_agg(md5(x::text), ',' ORDER BY md5(x::text))), '') AS h FROM public.${t} x`))[0]; } return out; };
const POL0 = await policies(), ROWS0 = await rows(), ACL0 = await acls();
const rep1 = await last(MIG), rep2 = await last(MIG);
check(`the migration's report: all ${REPORT_N} rows ok, the first time and run again; its read-only check file says the same`, rep1.length === REPORT_N && rep1.every((r) => r.ok === true)
  && rep2.every((r) => r.ok === true) && (await last(read('../checks/post-repair-report.sql'))).every((r) => r.ok === true), rep1.filter((r) => !r.ok));
const POL1 = await policies(), ROWS1 = await rows();
check('…every existing row-security rule as it was; one added, on its own new table (a shop reads its own marks)',
  POL0.every((p) => POL1.includes(p)) && JSON.stringify(POL1.filter((p) => !POL0.includes(p))) === JSON.stringify(['public.hangtag_deleted_products: A shop reads its own deleted products SELECT authenticated (owner_id = hangtag_shop_id()) ']),
  POL1.filter((p) => !POL0.includes(p)));
check(`…every existing table's rows exactly as they were (here the seed and settings tables: no shop has rows yet); its ${OWN_TABLES.length} new tables empty but the one row of billing settings ('live')`,
  Object.keys(ROWS0).every((t) => JSON.stringify(ROWS0[t]) === JSON.stringify(ROWS1[t]))
  && OWN_TABLES.every((t) => ROWS1[t] && !(t in ROWS0) && ROWS1[t].n === (t === 'hangtag_billing_settings' ? 1 : 0))
  && (await sql(`SELECT billing_mode FROM public.hangtag_billing_settings`))[0].billing_mode === 'live', OWN_TABLES.map((t) => [t, ROWS1[t]]));
// outside function bodies (DO blocks are read like the rest), the migration writes rows and changes tables, indexes,
// triggers and policies only of its own tables — and puts its two triggers on products and stock records
const outside = lf(MIG).replace(/CREATE OR REPLACE FUNCTION[\s\S]*?\bAS \$(\w*)\$[\s\S]*?\$\1\$/g, '').replace(/--[^\n]*/g, '');
const own = new RegExp(`^(public\\.)?(${OWN_TABLES.join('|')})$`, 'i');
const targets = [...outside.matchAll(/\b(INSERT\s+INTO|UPDATE(?!\s+(?:OR|SET)\b)|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|COPY|ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+\w+\s+ON|CREATE\s+POLICY\s+"[^"]+"\s+ON|DROP\s+POLICY\s+IF\s+EXISTS\s+"[^"]+"\s+ON)\s+([\w.]+)/gi)]
  .map((m) => [m[1].replace(/\s+/g, ' ').toUpperCase().split(' ')[0], m[2]]);
const triggers = [...outside.matchAll(/\b(?:CREATE|DROP)\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(\w+)\s+[\s\S]*?\bON\s+([\w.]+)/gi)].map((m) => [m[1], m[2]]);
const badTargets = targets.filter(([, t]) => !own.test(t));
const badTriggers = triggers.filter(([n, t]) => !own.test(t) && !(n === 'hangtag_tracking_required' && /hangtag_stock_moves$/.test(t)) && !(n === 'hangtag_product_deleted' && /hangtag_products$/.test(t)));
check('…and outside its function bodies it writes rows and changes tables, indexes, policies and triggers only of its own tables (its two triggers on products and stock records aside)',
  targets.length > 20 && badTargets.length === 0 && badTriggers.length === 0 && triggers.length >= 6
  && !/CREATE OR REPLACE FUNCTION/.test(outside) && !/SELECT quantity INTO bought|jsonb_populate_recordset/.test(outside)
  && /CREATE TABLE IF NOT EXISTS public\.hangtag_autopay_mandates/.test(outside), { badTargets, badTriggers, n: targets.length, triggers: triggers.length });

console.log('=== only the stated edits ===');
for (const f of FUNCTION_EDITS) {
  const want = applyEdits(fnText(SCHEMA, f.name), f.edits, f.name), got = fnText(MIG, f.name);
  check(`${f.name}: schema.sql's text with its ${f.edits.length} stated edit${f.edits.length > 1 ? 's' : ''} (${f.what}), nothing else`, got === want && got !== fnText(SCHEMA, f.name));
}

// shops: A sells electronics (serial numbers), C groceries (batches), B is another shop; M a member of A
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', C = '33333333-3333-3333-3333-333333333333', OUT = '44444444-4444-4444-4444-444444444444';
await sql(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.test'),($2,'b@x.test'),($3,'c@x.test'),($4,'out@x.test')`, [A, B, C, OUT]);
for (const [o, kind] of [[A, 'electronics'], [B, 'retail'], [C, 'grocery']]) await sql(`UPDATE public.hangtag_profiles SET shop_name = 'S', full_name = 'X', business_type = $2, onboarded_at = NOW() WHERE id = $1`, [o, kind]);
const product = async (who, id, tracking = 'none', unit = 'pcs') => {
  const r = await as(who, `INSERT INTO public.hangtag_products (id, name, price, options, tracking, unit) VALUES ($1, $1, 100, '{"opts":[]}', $2, $3)`, [id, tracking, unit]);
  return r.err ? r : as(who, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ($1 || ':', $1, '[]')`, [id]);
};
for (const [who, id, tr, u] of [[A, 'ph', 'serial', 'pcs'], [A, 'tee', 'none', 'pcs'], [A, 'cap', 'none', 'pcs'], [C, 'rice', 'batch', 'kg']]) {
  const r = await product(who, id, tr, u); if (r.err) console.log('fixture', id, r.err);
}
const move = (who, id, v, p, q, extra = {}) => as(who, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t, serials, batch_no)
  VALUES ($1, $2, $3, 'RESTOCK', $4, 1, $5, $6) RETURNING id`, [id, v, p, q, extra.serials || null, extra.batch || null]);

console.log('=== stock records of tracked products ===');
const s0 = await move(A, 'm0', 'ph:', 'ph', 1), s00 = await move(A, 'm00', 'ph:', null, 1, { serials: [] });
check('a serial-tracked product: a stock record without serial numbers is refused (none, or an empty list; found through its variant too)',
  /serial number of each piece/.test(s0.err || '') && /serial number of each piece/.test(s00.err || ''), [s0, s00]);
check('…with one per piece it is saved', !(await move(A, 'm1', 'ph:', 'ph', 2, { serials: ['SN1', 'SN2'] })).err);
const b0 = await move(C, 'm2', 'rice:', 'rice', 5);
check('a batch-tracked product: a stock record without its batch is refused; with it, saved', /needs the batch/.test(b0.err || '') && !(await move(C, 'm3', 'rice:', 'rice', 5, { batch: 'B1' })).err, b0);
check('a product tracked by neither: as before', !(await move(A, 'm4', 'tee:', 'tee', 10)).err);

console.log('=== bills keep the unit they were sold in ===');
function bill(id, lines) {
  const T = computeCheckout({ lines: lines.map((l) => ({ q: l.q, price: l.price, rate: 0 })), billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, [{ method: 'cash', amount: T.total }], { customer: false });
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: T.lines.map((L, ln) => ({ ln, p: lines[ln].p, v: lines[ln].p + ':', n: lines[ln].p, c: '', s: '', vl: '', ov: [], sku: '', q: lines[ln].q, price: lines[ln].price, cost: null,
      dAmt: 0, bdAmt: 0, gst: 0, hsn: '', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total, ...(lines[ln].u ? { u: lines[ln].u } : {}) })),
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'cash', payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}
const save = (who, b) => as(who, `SELECT public.hangtag_save_sales($1::jsonb) AS r`, [JSON.stringify([billArgs(b)])]);
const units = async (sale) => (await sql(`SELECT line_no, unit FROM public.hangtag_sale_items WHERE owner_id = $1 AND sale_id = $2 ORDER BY 1`, [A, sale])).map((r) => r.unit);
const sv = await save(A, bill('s1', [{ p: 'tee', q: 1, price: 100, u: 'box' }, { p: 'tee', q: 2, price: 50 }]));
check('the unit sent is kept (box); a line without one gets its product\'s (pcs) — through the app\'s own mapper', !sv.err && JSON.stringify(await units('s1')) === '["box","pcs"]', [sv, await units('s1')]);
await save(A, bill('s1', [{ p: 'tee', q: 1, price: 100, u: 'dozen' }, { p: 'tee', q: 2, price: 50 }]));
check('…sent again with another unit: the line keeps the one saved first', JSON.stringify(await units('s1')) === '["box","pcs"]', await units('s1'));
const bad = await save(A, bill('s2', [{ p: 'tee', q: 1, price: 100, u: 'Box!' }]));
check('…an unknown unit is refused (and nothing of that bill is saved)', !!bad.err && (await units('s2')).length === 0, bad);

console.log('=== returns: one at a time per bill line ===');
await save(A, bill('s3', [{ p: 'tee', q: 2, price: 100 }]));
const ret = (id, q) => ({ id, sale: 's3', t: 1790000001000, kind: 'return', refund: 100 * q, pay: 'cash', value: 100 * q, dev: 'd1',
  items: [{ ln: 0, p: 'tee', v: 'tee:', n: 'tee', c: '', s: '', vl: '', ov: [], sku: '', q, price: 100, value: 100 * q, cost: null, restock: true, tx: 100 * q, gst: 0 }] });
const saveRet = (r) => as(A, `SELECT public.hangtag_save_return($1::jsonb, $2::jsonb) AS r`, [JSON.stringify(returnArgs(r).p_return), JSON.stringify(returnArgs(r).p_items)]);
await db.exec('BEGIN');
const r1 = await saveRet(ret('r1', 1));
const locks = await sql(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted`);
await db.exec('COMMIT');
check('a return takes its bill line\'s lock, held until its transaction ends (a second return of that line waits, then counts this one)', !r1.err && locks[0].n >= 1, { r1, locks });
check('after it: no lock left behind', (await sql(`SELECT count(*)::int n FROM pg_locks WHERE locktype = 'advisory'`))[0].n === 0);
const r2 = await saveRet(ret('r2', 1)), r3 = await saveRet(ret('r3', 1));
check('one after the other: the second piece back, a third refused (2 bought)', !r2.err && /2 bought, 2 already returned/.test(r3.err || ''), [r2, r3]);

console.log('=== a deleted product leaves a mark for its shop only ===');
const del = await as(A, `DELETE FROM public.hangtag_products WHERE id = 'cap' RETURNING id`);
check('the shop deletes a product: a mark with its id and time', !del.err && (await as(A, `SELECT product_id FROM public.hangtag_deleted_products`)).map((r) => r.product_id).join() === 'cap', del);
check('…another shop, an outsider and the signed-out see none of it', (await as(B, `SELECT count(*)::int n FROM public.hangtag_deleted_products`))[0].n === 0
  && (await as(OUT, `SELECT count(*)::int n FROM public.hangtag_deleted_products`))[0].n === 0 && !!(await as(null, `SELECT count(*) FROM public.hangtag_deleted_products`)).err);
check('…no app account writes a mark itself (only the delete does)', !!(await as(A, `INSERT INTO public.hangtag_deleted_products (owner_id, product_id) VALUES ($1, 'tee')`, [A])).err);

console.log('=== capabilities: an app account\'s own shop only ===');
check('the shop asks about itself: its answer (electronics: serial numbers on)', (await as(A, `SELECT public.hangtag_cap_on($1, 'uses_serials') r`, [A]))[0].r === true);
check('another shop asks about it: no (whatever the answer is)', (await as(B, `SELECT public.hangtag_cap_on($1, 'uses_serials') r`, [A]))[0].r === false
  && (await as(B, `SELECT public.hangtag_cap_on($1, 'uses_mobile_store') r`, [A]))[0].r === false);
await sql(`UPDATE public.hangtag_profiles SET store_token = 'st_' || repeat('a', 40) WHERE id = $1`, [A]);
await sql(`INSERT INTO public.hangtag_meta (owner_id, key, value) VALUES ($1, 'settings', '{"caps":{"uses_mobile_store":true,"uses_sales_orders":true}}')
  ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value`, [A]);
const page = (await as(null, `SELECT public.hangtag_mobile_catalog($1) r`, ['st_' + 'a'.repeat(40)]))[0];
check('the public store page (no session, as store.js asks) still opens the shop\'s store', page && page.r && page.r.ok === true, page);
const signedIn = (await as(B, `SELECT public.hangtag_mobile_catalog($1) r`, ['st_' + 'a'.repeat(40)]))[0];
check('…asked with another shop\'s session instead (the store pages never send one): "not open" — documented, not a path the app uses', signedIn && signedIn.r && signedIn.r.ok === false, signedIn);

console.log('=== plan billing: notifications once, money for review ===');
const ev = (who) => as(who, `SELECT public.hangtag_billing_event_record('cashfree', 'evt-1', 'PAYMENT_SUCCESS_WEBHOOK', 'ht_x', 'live') r`);
const e1 = await ev('service'), e2 = await ev('service');
check('a notification: new the first time, known the second (one row)', e1[0].r.duplicate === false && e2[0].r.duplicate === true
  && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_events`))[0].n === 1, [e1, e2]);
const x = (who) => as(who, `SELECT public.hangtag_billing_exception_open('cashfree', 'refund', 'cf_ref_1', $1, NULL, 499, '{"note":"refund processed"}') r`, [A]);
const x1 = await x('service'), x2 = await x('service');
check('money for review: opened once per provider, kind and reference', x1[0].r.opened === true && x2[0].r.opened === false, [x1, x2]);
check('…app accounts and the signed-out can neither call these nor read them', !!(await ev(A)).err && !!(await x(null)).err
  && !!(await as(A, `SELECT * FROM public.hangtag_billing_exceptions`)).err && !!(await as(A, `SELECT * FROM public.hangtag_billing_events`)).err);

console.log('=== plan payments: a suspended shop ===');
const pay = (who) => as(who, `SELECT public.hangtag_subscription_checkout('m1', NULL, 'cashfree') r`);
const before = await pay(C);
await sql(`UPDATE public.hangtag_subscriptions SET suspended = TRUE, suspended_reason = 'test' WHERE owner_id = $1`, [C]);
const blocked = await pay(C), other = await pay(B);
check('a suspended shop can\'t start a plan payment (the support message), and nothing is created; another shop still can',
  /This shop is suspended/.test(blocked.err || '') && other[0] && !!other[0].r.payment_id
  && (await sql(`SELECT count(*)::int n FROM public.hangtag_subscription_payments WHERE owner_id = $1`, [C]))[0].n === 1, { before, blocked, other });
const act = await as('service', `SELECT public.hangtag_subscription_activate($1, 'cf_pay_c1', $2) r`, [before[0].r.payment_id, before[0].r.amount]);
check('…the payment it started before the suspension: honoured when its money comes (paid); the shop stays suspended',
  act[0] && act[0].r.ok === true && (await sql(`SELECT status FROM public.hangtag_subscription_payments WHERE id = $1`, [before[0].r.payment_id]))[0].status === 'paid'
  && (await sql(`SELECT public.hangtag_subscription_state($1, NOW()) s`, [C]))[0].s === 'suspended', act);
await sql(`UPDATE public.hangtag_subscriptions SET suspended = FALSE, suspended_reason = NULL WHERE owner_id = $1`, [C]);
const again = await pay(C);
check('…restored: it can pay again', again[0] && !!again[0].r.payment_id, again);

console.log('=== tenant isolation on the migrated database ===');
const tables = await shopTables(db), run = async (who, q, p) => {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(q, p); } finally { await db.exec('RESET ROLE'); }
};
const attackers = [['B', B], ['outsider', OUT], ['signed out', null]];
check(`the new table is among the shop tables swept (${tables.length})`, tables.includes('hangtag_deleted_products'));
const rl = await readLeaks({ run, tables, victim: A, attackers });
const wl = await writeLeaks({ db, run, tables, victim: A, attackers });
check('nothing of shop A is seen, changed, deleted or added to by anyone outside it, in any shop table', rl.length === 0 && wl.leaks.length === 0, { rl, wl: wl.leaks });

console.log('=== the undo, then the migration again ===');
const und = await last(UNDO);
const after = await fns(), afterAcl = await acls();
const changed = Object.keys({ ...after, ...FRESH }).filter((k) => after[k] !== FRESH[k]);
const aclChanged = Object.keys({ ...afterAcl, ...ACL0 }).filter((k) => afterAcl[k] !== ACL0[k]);
check(`the undo says it took; every function exactly as before the migration — the ${FUNCTION_EDITS.length} it changed back byte for byte, every one it added gone — and every function's grants, owner's rights and settings as before`,
  und[0].undone === true && changed.length === 0 && aclChanged.length === 0, { und, changed, aclChanged });
await sql(`UPDATE public.hangtag_subscriptions SET suspended = TRUE WHERE owner_id = $1`, [C]);
const unguarded = await pay(C);
await sql(`UPDATE public.hangtag_subscriptions SET suspended = FALSE WHERE owner_id = $1`, [C]);
check('…and without the migration a suspended shop starts a payment again (the defect the fix closes)', unguarded[0] && !!unguarded[0].r.payment_id, unguarded);
check('…its triggers are gone and its tables stay, with what they hold', (await sql(`SELECT count(*)::int n FROM pg_trigger WHERE tgname IN ('hangtag_tracking_required', 'hangtag_product_deleted')
     OR (tgname = 'zz_hangtag_subscription_guard' AND tgrelid = 'public.hangtag_deleted_products'::regclass)`))[0].n === 0
  && (await sql(`SELECT count(*)::int n FROM public.hangtag_deleted_products`))[0].n === 1 && (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_exceptions`))[0].n === 1);
const rep3 = await last(MIG);
check('applied again after the undo: its report all ok', rep3.every((r) => r.ok === true), rep3);
await last(UNDO);
await db.exec(read('../checks/2026-10-13-repair-undo.sql'));
const back = await fns();
const left = Object.keys({ ...back, ...LIVE }).filter((k) => back[k] !== LIVE[k]);
check('the whole way back (this undo, then the repair\'s own undo): every function exactly as on the live project before the repair', left.length === 0, left);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
