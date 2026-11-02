// The runbook's steps 2–4 (supabase/REPAIR-RUNBOOK.md) on a restored copy, with the runbook's own check files: a backup of
// the live project as reconstructed (schema.sql of 2026-10-13, the section files newest-first, the first migration as it
// was, the containment; two shops with products, settings and bills) is taken as a whole data directory — a physical backup
// — and restored into a separate database. Then:
// - the restored copy against the source: data fingerprint, row counts, function versions, open policies all the same;
//   no reference pointing at nothing; a row written on the source after the backup shows as the one difference, by table;
// - the rehearsal on the restored copy: the dry run 0, the repair in one transaction, its report all ok, the version check
//   all ok, no open policy, the data fingerprint unchanged, the isolation probes clean; then the post-repair migration
//   (report ok) and its undo; on a second restored copy the repair's undo puts the 18 functions back byte for byte;
// - the source is never touched by any of it.
// (On the live project the backup is the owner's pg_dump or the platform's, and the restore a throwaway project: the
// checks and their comparisons are these.) Run: node supabase/tests/restore-rehearsal.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { computeCheckout } from '../../src/domain/sales/checkout-totals.js';
import { paymentId, settlePayments } from '../../src/domain/sales/payments.js';
import { billArgs } from '../../src/infrastructure/supabase/mappers.js';
import { REPORT_ROWS } from './report-rows.mjs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
const NEW = read('../schema.sql'), MIGS = new URL('../migrations/', import.meta.url);
const INITIAL = fs.readFileSync(new URL('20260923102731_hangtag_initial_schema.sql', MIGS), 'utf8');
const INITIAL_AS_IT_WAS = INITIAL.replace(/    IF EXISTS \(SELECT 1 FROM information_schema\.columns WHERE table_schema = 'public' AND table_name = 'hangtag_meta' AND column_name = 'owner_id'\) THEN\r?\n        RETURN;\r?\n    END IF;\r?\n/, '');
const SECTIONS = fs.readdirSync(MIGS).filter((f) => /^202610\d{8}_.+\.sql$/.test(f) && f.slice(0, 14) <= '20261013120000').sort().reverse();
const POST_UNDO = read('../operations/post-repair-integrity-undo.sql');
const REPAIR = `BEGIN;\nSET LOCAL lock_timeout = '10s';\n${NEW}\nCOMMIT;`;
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const runCheck = async (db, f) => (await db.exec(read(`../checks/${f}`))).at(-1).rows;
const report = async (db) => (await db.query(`SELECT check_name, value, expected, ok FROM (${NEW.slice(NEW.lastIndexOf('SELECT check_name')).replace(/;\s*$/, '')}) q`)).rows;
const fns = async (db) => Object.fromEntries((await db.query(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k, md5(replace(p.prosrc, chr(13), '')) AS v
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hangtag%'`)).rows.map((r) => [r.k, r.v]));
async function as(db, who, q, p) {
  await db.exec('SET ROLE authenticated');
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who, JSON.stringify({ authorization: 'Bearer x' })]);
  try { return await db.query(q, p); } finally { await db.exec('RESET ROLE'); }
}
function bill(id) {
  const prices = [500, 200];
  const T = computeCheckout({ lines: prices.map((price) => ({ q: 1, price, rate: 0 })), billDisc: null, gst: { mode: 'none', inclusive: true } });
  const S = settlePayments(T.total, [{ method: 'cash', amount: T.total }], { customer: false });
  return { id, no: 'INV-' + id, t: 1790000000000, dev: 'd1', kind: 'sale', ex: null, credit: 0, cust: null,
    items: T.lines.map((L, ln) => ({ ln, p: 'p' + ln, v: 'p' + ln + ':', n: 'Item' + ln, c: '', s: '', vl: '', ov: [], sku: '', q: 1, price: prices[ln], cost: null, dAmt: 0, bdAmt: 0,
      gst: 0, hsn: '', tx: L.taxable, cgst: 0, sgst: 0, igst: 0, lt: L.total })),
    sub: T.sub, disc: 0, itemDisc: 0, billDisc: null, billDiscAmt: 0, taxable: T.taxable, tax: 0, cgst: 0, sgst: 0, igst: 0, taxRate: 0, taxIncl: true, gst: { mode: 'none', pos: '27' },
    roundOff: T.roundOff, total: T.total, pay: 'cash', payments: S.payments.map((p) => ({ id: paymentId(id, p.method), ...p })) };
}

// the source: the live project as reconstructed, with two shops' rows (made while the database was current, as on live)
const src = new PGlite();
await src.exec(STUB);
await src.exec(NEW);
const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
await src.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'a@shop.test'), ($2, 'b@shop.test')`, [A, B]);
for (const [o, name] of [[A, 'Shop A'], [B, 'Shop B']]) {
  await as(src, o, `UPDATE public.hangtag_profiles SET shop_name = $2, business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [o, name]);
  for (const i of [0, 1]) {
    await as(src, o, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ($1, $2, 100, '{"opts":[]}')`, ['p' + i, 'Item' + i]);
    await as(src, o, `INSERT INTO public.hangtag_variants (id, product_id, option_values) VALUES ($1, $2, '[]')`, ['p' + i + ':', 'p' + i]);
    await as(src, o, `INSERT INTO public.hangtag_stock_moves (id, variant_id, product_id, type, qty, t) VALUES ($1, $2, $3, 'OPENING', 10, 1)`, ['open:p' + i, 'p' + i + ':', 'p' + i]);
  }
  await as(src, o, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c1', $1)`, [name + ' customer']);
  await as(src, o, `INSERT INTO public.hangtag_images (product_id, image_data) VALUES ('p0', 'data:image/png;base64,AA==')`);
  await as(src, o, `INSERT INTO public.hangtag_sizes (product_id, size, stock) VALUES ('p0', 'M', 0)`);
  await as(src, o, `INSERT INTO public.hangtag_meta (key, value) VALUES ('settings', $1), ('logo', '{"data":"data:image/png;base64,AA=="}')`, [JSON.stringify({ prefix: name.slice(-1) + '-' })]);
  await as(src, o, `SELECT public.hangtag_save_sales($1::jsonb)`, [JSON.stringify([billArgs(bill('s1'))])]);
}
for (const f of SECTIONS) await src.exec(fs.readFileSync(new URL(f, MIGS), 'utf8'));
await src.exec(INITIAL_AS_IT_WAS);
for (const p of (await src.query(`SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'Public access to %'`)).rows) {
  await src.exec(`DROP POLICY "${p.policyname}" ON public.${p.tablename}`);   // the containment of 2026-10-13 23:45 IST
}
const SRC = { fp: await runCheck(src, 'data-fingerprint.sql'), rows: await runCheck(src, 'restore-row-counts.sql'), fv: await runCheck(src, '2026-10-13-function-versions.sql'),
  open: await runCheck(src, 'open-policies.sql'), fns: await fns(src) };
check('the source is the live state: 18 older functions, the 3 indexes, no open policy (after the containment), two shops of rows',
  SRC.fv.filter((r) => r.state === 'OLDER VERSION').length === 18 && SRC.fv.filter((r) => r.state === 'STILL THERE').length === 3 && SRC.open.length === 0
  && SRC.fp.some((r) => +r.row_count > 0), SRC.fv.filter((r) => r.state !== 'ok'));

console.log('=== step 2–3: the backup, the restore, and the comparison ===');
const backup = await src.dumpDataDir('none');
check(`a backup of the whole database (${Math.round(backup.size / 1e6)} MB)`, backup.size > 1e6);
const restore = () => new PGlite({ loadDataDir: backup });
const copy = restore();
const same = async (f) => JSON.stringify(await runCheck(copy, f)) === JSON.stringify(SRC[{ 'data-fingerprint.sql': 'fp', 'restore-row-counts.sql': 'rows', '2026-10-13-function-versions.sql': 'fv', 'open-policies.sql': 'open' }[f]]);
check('the restored copy against the source: the data fingerprint, line for line', await same('data-fingerprint.sql'));
check('…the exact row counts of every table (public and auth)', await same('restore-row-counts.sql'));
check('…the function versions (18 older, 3 indexes) and no open policy', (await same('2026-10-13-function-versions.sql')) && (await same('open-policies.sql')));
check('…and on the copy, no reference pointing at nothing', (await runCheck(copy, 'restore-fk-orphans.sql')).length === 0);
await as(src, A, `INSERT INTO public.hangtag_customers (id, name) VALUES ('c-late', 'Late')`);
const fpLate = await runCheck(src, 'data-fingerprint.sql'), fpCopy = await runCheck(copy, 'data-fingerprint.sql');
const moved = fpLate.filter((r, i) => JSON.stringify(r) !== JSON.stringify(fpCopy[i])).map((r) => r.tbl);
check('a customer added on the source after the backup: the comparison names that table and the audit trail of that write, nothing else', JSON.stringify(moved) === '["hangtag_audit_log","hangtag_customers"]', moved);

console.log('=== step 4: the rehearsal on the restored copy ===');
const dry = (await runCheck(copy, 'schema-dry-run.sql'))[0].dryrun;
check('the dry run before it: all 26 numbers 0', Object.keys(dry).length === 26 && Object.values(dry).every((n) => +n === 0), dry);
const fpBefore = await runCheck(copy, 'data-fingerprint.sql');
await copy.exec(REPAIR);
const rep = await report(copy);
check(`the repair (schema.sql in one transaction): the report all ok (${REPORT_ROWS} rows), row 96 0`, rep.length === REPORT_ROWS && rep.every((r) => r.ok), rep.filter((r) => !r.ok));
check('…the version check all ok; no open policy; the dry run still 0', (await runCheck(copy, '2026-10-13-function-versions.sql')).every((r) => r.state === 'ok')
  && (await runCheck(copy, 'open-policies.sql')).length === 0 && Object.values((await runCheck(copy, 'schema-dry-run.sql'))[0].dryrun).every((n) => +n === 0));
check('…the data fingerprint the same as before it (the repair changes no row)', JSON.stringify(await runCheck(copy, 'data-fingerprint.sql')) === JSON.stringify(fpBefore));
const probe = await runCheck(copy, 'shop-isolation-probe.sql'), sync = await runCheck(copy, 'sync-read-isolation.sql');
const want = { '1 read': /other shops' rows visible: 0; own rows visible: [1-9]/, '2 change other shop': /^blocked \(0 rows\)$/, '3 delete other shop': /^blocked \(0 rows\)$/,
  '4 add as other shop': /^blocked by row security \(42501\)$/, '5 change own row': /^works \(1 row\)$/ };
const RESTRICTED = /^hangtag_(backup_v\d+_\w+|subscriptions|trial_claims|promo_redemptions|webhook_secrets):42501$/;
check(`…the isolation probes (${probe.length} rows): no shop reads, changes, deletes or adds the other's rows, each changes its own; a full sync reads none of the other's`,
  probe.length >= 50 && probe.every((r) => want[r.probe] && want[r.probe].test(r.result))
  && sync.length === 2 && sync.every((r) => +r.rows_of_other_shops === 0 && +r.rows_visible > 0 && String(r.errors || '').split(', ').filter(Boolean).every((e) => RESTRICTED.test(e))),
  { probe: probe.filter((r) => !(want[r.probe] && want[r.probe].test(r.result))), sync });
const post = await runCheck(copy, '../migrations/20261019120000_hangtag_post_repair_integrity.sql');
const fpPost = await runCheck(copy, 'data-fingerprint.sql'), had = new Set(fpBefore.map((r) => r.tbl));
const added = fpPost.filter((r) => !had.has(r.tbl));
check('then the post-repair migration: its report all 13 ok; the rows of every table the same, and its one new shop table (the marks of deleted products) empty', post.length === 13 && post.every((r) => r.ok === true)
  && JSON.stringify(fpPost.filter((r) => had.has(r.tbl))) === JSON.stringify(fpBefore) && added.length > 0 && added.every((r) => +r.row_count === 0)
  && JSON.stringify(added.map((r) => r.tbl)) === JSON.stringify(['hangtag_deleted_products']), { post: post.filter((r) => !r.ok), added });
const und = (await copy.exec(POST_UNDO)).at(-1).rows;
check('…and its undo says it took', und[0] && und[0].undone === true, und);
const copy2 = restore();
await copy2.exec(REPAIR);
await copy2.exec(read('../checks/2026-10-13-repair-undo.sql'));
const back = await fns(copy2), diff = Object.keys({ ...back, ...SRC.fns }).filter((k) => back[k] !== SRC.fns[k]);
check('on a second restored copy, the repair then its undo: every function exactly as before the repair', diff.length === 0, diff);
check('the source itself untouched by all of it (still the 18 older functions, only the late row added)', JSON.stringify(await fns(src)) === JSON.stringify(SRC.fns)
  && (await runCheck(src, '2026-10-13-function-versions.sql')).filter((r) => r.state === 'OLDER VERSION').length === 18);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
