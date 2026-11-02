// AutoPay's readiness with Cashfree as the provider, on the real schema: the post-repair migration, then
// 20261027120000_hangtag_cashfree_readiness.sql. Before it, Cashfree's own notifications (proven, about its probes) left
// AutoPay unready for ever — so it could never be offered; after it they prove readiness as Razorpay's do, and still only
// about a probe or an object Hangtag made, and each kind only for its own proof.
// Run: node supabase/tests/cashfree-readiness.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };

const db = new PGlite();
await db.exec(STUB);
await db.exec(read('../schema.sql'));
await db.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
const one = async (q, p) => Object.values((await db.query(q, p)).rows[0])[0];
const ready = () => one(`SELECT public.hangtag_billing_readiness()`);
const LINK = 'ht_' + 'a'.repeat(32), SUB = 'htap_' + 'b'.repeat(32), OTHER = 'htap_' + 'c'.repeat(32);

await one(`SELECT public.hangtag_billing_probe_record('cashfree', 'payment_link', $1, 'live')`, [LINK]);
await one(`SELECT public.hangtag_billing_probe_record('cashfree', 'subscription', $1, 'live')`, [SUB]);
const rec = (id, type, entity, ago) => one(`SELECT public.hangtag_billing_event_record('cashfree', $1, $2, $3, 'live', $3, NOW() - $4::interval)`, [id, type, entity, ago]);
await rec('cf_1', 'PAYMENT_SUCCESS_WEBHOOK', LINK, '3 minutes');
await rec('cf_2', 'SUBSCRIPTION_STATUS_CHANGED', SUB, '2 minutes');
const b = await one(`SELECT public.hangtag_billing_reconcile_begin(10, 'live')`);
await one(`SELECT public.hangtag_billing_reconcile_done($1, '{"ok": true, "complete": true}')`, [b.run_id]);
const before = await ready();
check('before the fix: Cashfree\'s proven notifications (a link probe, a mandate probe) and a complete run still leave AutoPay unready — it could never be offered',
  before.ready === false && before.link_event_at === null && before.autopay_event_at === null, before);

await db.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql'));
await db.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql'));   // safe to run again
const after = await ready();
check('after it: the same notifications prove it — ready, each proof from its own kind of notification', after.ready === true && !!after.link_event_at && !!after.autopay_event_at
  && Date.parse(after.link_event_at) < Date.parse(after.autopay_event_at), after);

// each kind proves only its own part, and only about Hangtag's objects
const db2 = new PGlite();
await db2.exec(STUB); await db2.exec(read('../schema.sql'));
await db2.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
await db2.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql'));
const one2 = async (q, p) => Object.values((await db2.query(q, p)).rows[0])[0];
await one2(`SELECT public.hangtag_billing_probe_record('cashfree', 'payment_link', $1, 'live')`, [LINK]);
await one2(`SELECT public.hangtag_billing_probe_record('cashfree', 'subscription', $1, 'live')`, [SUB]);
const rec2 = (id, type, entity) => one2(`SELECT public.hangtag_billing_event_record('cashfree', $1, $2, $3, 'live', $3, NOW() - interval '1 minute')`, [id, type, entity]);
await rec2('x1', 'SUBSCRIPTION_STATUS_CHANGED', LINK);        // a subscription event about the link probe
await rec2('x2', 'PAYMENT_SUCCESS_WEBHOOK', SUB);             // a payment event about the mandate probe
await rec2('x3', 'SUBSCRIPTION_STATUS_CHANGED', OTHER);       // about a mandate no one registered
// another mode: refused outright, or recorded and never counted
const otherMode = await one2(`SELECT public.hangtag_billing_event_record('cashfree', 'x4', 'PAYMENT_SUCCESS_WEBHOOK', $1, 'test', $1, NOW())`, [LINK])
  .then(() => 'recorded', (e) => 'refused: ' + String(e && e.message).slice(0, 80));
const cross = await one2(`SELECT public.hangtag_billing_readiness()`);
check('a subscription event about a link, a payment event about a mandate, one about an unknown mandate, or one in the other mode proves nothing',
  cross.link_event_at === null && cross.autopay_event_at === null && cross.ready === false, { cross, otherMode });
await one2(`SELECT public.hangtag_billing_probe_record('razorpay', 'payment_link', 'plink_Probe1', 'live')`);
await one2(`SELECT public.hangtag_billing_probe_record('razorpay', 'subscription', 'sub_Probe12', 'live')`);
await one2(`SELECT public.hangtag_billing_event_record('razorpay', 'r1', 'payment_link.cancelled', 'plink_Probe1', 'live', 'plink_Probe1', NOW())`);
await one2(`SELECT public.hangtag_billing_event_record('razorpay', 'r2', 'subscription.cancelled', 'sub_Probe12', 'live', 'sub_Probe12', NOW())`);
const rz = await one2(`SELECT public.hangtag_billing_readiness()`);
check('Razorpay\'s notifications still prove it as before', !!rz.link_event_at && !!rz.autopay_event_at, rz);
const priv = (await db.query(`SELECT has_function_privilege('anon', 'public.hangtag_billing_readiness()', 'EXECUTE') AS a,
  has_function_privilege('authenticated', 'public.hangtag_billing_readiness()', 'EXECUTE') AS u`)).rows[0];
check('…and the function keeps its privileges: no app account or signed-out caller can run it', priv.a === false && priv.u === false, priv);

// out of order: on a database without the post-repair migration (live today, before its repair) the migration and its undo
// refuse and change nothing — made fresh there, the functions would carry PostgreSQL's default EXECUTE for everyone
const db3 = new PGlite();
await db3.exec(STUB); await db3.exec(read('../schema.sql'));
const fnsOf = async (d) => (await d.query(`SELECT count(*)::int n FROM pg_proc WHERE proname IN ('hangtag_billing_readiness', 'hangtag_autopay_report', 'hangtag_autopay_cancel_owed')`)).rows[0].n;
const before3 = await fnsOf(db3);
const mig3 = await db3.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql')).then(() => 'ran', (e) => String(e.message));
const undo3 = await db3.exec(read('../operations/cashfree-readiness-undo.sql')).then(() => 'ran', (e) => String(e.message));
check('without the post-repair migration, the migration and its undo refuse, naming it, and make nothing',
  /post-repair migration/.test(mig3) && /post-repair migration/.test(undo3) && (await fnsOf(db3)) === before3, { mig3, undo3, before3, after: await fnsOf(db3) });

// the post-repair migration run again (as the runbook says after any schema.sql run) puts back its own two definitions:
// the report says so, and running this migration again restores them
const REPORT = read('../checks/cashfree-readiness-report.sql');
const rep = async () => (await db.exec(REPORT)).at(-1).rows;
const r1 = await rep();
await db.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
const r2 = await rep();
await db.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql'));
const r3 = await rep();
check('cashfree-readiness-report.sql: all 4 ok after the migration; after the post-repair migration is run again, the two functions it puts back read false (the cancel-owed one stays); after this migration again, all ok',
  r1.length === 4 && r1.every((r) => r.ok) && !r2[0].ok && !r2[1].ok && r2[2].ok && r3.every((r) => r.ok), { r1, r2: r2.map((r) => r.ok), r3: r3.map((r) => r.ok) });
const owedPriv = (await db.query(`SELECT has_function_privilege('anon', 'public.hangtag_autopay_cancel_owed(text, text, text)', 'EXECUTE') AS a,
  has_function_privilege('authenticated', 'public.hangtag_autopay_cancel_owed(text, text, text)', 'EXECUTE') AS u`)).rows[0];
check('…and the new hangtag_autopay_cancel_owed is the service role\'s only', owedPriv.a === false && owedPriv.u === false, owedPriv);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
