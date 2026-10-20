// Tenant isolation beyond the tables (team-tenancy sweeps those): the database functions that run with the owner's rights
// and the bills bucket's files.
// - The functions an app account (or the signed-out) may call that run with the database owner's rights are exactly the
//   reviewed list below; a new one fails here until it is reviewed. The post-repair migration adds none.
// - Each that takes another record's id, called by another shop with the first shop's ids: refused, or no effect.
// - hangtag_cap_on answered about any shop on schema.sql (a small inference: a shop's capabilities and whether its plan runs,
//   given its id); after the post-repair migration it answers an app account about its own shop only.
// - The bills bucket (with a stand-in for Supabase Storage): a shop reads, adds and changes files in its own folder only;
//   nobody deletes; the signed-out see nothing.
// Run: node supabase/tests/tenant-rpc-isolation.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
// Supabase Storage, the part the policies use: buckets, objects (row security on), the app roles' table rights
const STORAGE = `CREATE SCHEMA storage; GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text, owner uuid, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated; GRANT SELECT ON storage.buckets TO anon, authenticated;`;
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(STORAGE);
await db.exec(read('../schema.sql'));
const sql = async (q, p) => (await db.query(q, p)).rows;
async function as(who, q, p) {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return (await db.query(q, p)).rows; } catch (e) { return { err: e.message }; } finally { await db.exec('RESET ROLE'); }
}

// the reviewed list: what each is for, and what keeps it to the caller's own shop
const REVIEWED = {
  // the shop's plan (owner only, in the database) and AutoPay: by the caller's shop
  hangtag_autopay_begin: 'shop', hangtag_autopay_cancel_request: 'shop', hangtag_autopay_quote: 'shop', hangtag_subscription_checkout: 'shop',
  hangtag_subscription_plans: 'public list', hangtag_subscription_quote: 'shop', hangtag_subscription_status: 'shop',
  // who the caller is
  hangtag_can: 'caller', hangtag_role: 'caller', hangtag_shop_id: 'caller', hangtag_touch_device: 'caller', hangtag_cap_on: 'id (own shop after the post-repair migration)',
  // the shop's own records, by hangtag_shop_id()
  hangtag_cancel_voucher: 'shop', hangtag_issue_voucher: 'shop', hangtag_redeem_voucher: 'shop', hangtag_release_voucher: 'shop', hangtag_voucher_lookup: 'shop',
  hangtag_order_status: 'shop', hangtag_po_for_receipt: 'shop', hangtag_save_order: 'shop', hangtag_save_purchase_order: 'shop', hangtag_save_repack: 'shop',
  hangtag_webhook_create: 'shop owner', hangtag_webhook_delete: 'shop owner', hangtag_webhook_rotate: 'shop owner', hangtag_webhook_test: 'shop owner', hangtag_webhook_update: 'shop owner',
  // trigger functions (can't be called directly)
  hangtag_check_order_fulfilment: 'trigger', hangtag_event_delete_check: 'trigger', hangtag_post_refund: 'trigger', hangtag_sale_status: 'trigger',
  // the public pages: by an unguessable token (store, table menu, order status), or the sign-in page's question
  hangtag_mobile_catalog: 'token', hangtag_mobile_order_status: 'token', hangtag_place_mobile_order: 'token', hangtag_place_table_order: 'token', hangtag_table_menu: 'token',
  hangtag_sign_in_methods: 'sign-in page',
  // the console: a staff role, checked in the database on every call
  hangtag_platform_audit_list: 'staff', hangtag_platform_campaign_save: 'staff', hangtag_platform_customer: 'staff', hangtag_platform_customer_action: 'staff',
  hangtag_platform_customers: 'staff', hangtag_platform_dashboard: 'staff', hangtag_platform_payment: 'staff', hangtag_platform_payments: 'staff', hangtag_platform_plan_save: 'staff',
  hangtag_platform_promotions: 'staff', hangtag_platform_settings: 'staff', hangtag_platform_settings_save: 'staff', hangtag_platform_sign_in: 'caller', hangtag_platform_staff_list: 'staff',
  hangtag_platform_staff_save: 'staff', hangtag_platform_subscription: 'staff', hangtag_platform_subscriptions: 'staff', hangtag_platform_whoami: 'caller',
};
const ANON = ['hangtag_mobile_catalog', 'hangtag_mobile_order_status', 'hangtag_place_mobile_order', 'hangtag_place_table_order', 'hangtag_sign_in_methods', 'hangtag_table_menu'];
const elevated = async () => (await sql(`SELECT p.proname AS fn, bool_or(has_function_privilege('anon', p.oid, 'EXECUTE')) AS anon FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.prosecdef
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE')) GROUP BY 1 ORDER BY 1`));
const e0 = await elevated();
check(`the functions an app account may call with the owner's rights are exactly the reviewed ${Object.keys(REVIEWED).length}`,
  JSON.stringify(e0.map((r) => r.fn)) === JSON.stringify(Object.keys(REVIEWED).sort()), { unreviewed: e0.map((r) => r.fn).filter((f) => !REVIEWED[f]), gone: Object.keys(REVIEWED).filter((f) => !e0.some((r) => r.fn === f)) });
check('…the signed-out may call only the six public-page ones (each by a token, or the sign-in question)', JSON.stringify(e0.filter((r) => r.anon).map((r) => r.fn)) === JSON.stringify(ANON), e0.filter((r) => r.anon));

const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', OUT = '44444444-4444-4444-4444-444444444444';
await sql(`INSERT INTO auth.users (id, email) VALUES ($1,'a@x.test'),($2,'b@x.test'),($3,'out@x.test')`, [A, B, OUT]);
for (const o of [A, B]) await sql(`UPDATE public.hangtag_profiles SET shop_name = 'S', full_name = 'X', business_type = 'electronics', onboarded_at = NOW() WHERE id = $1`, [o]);

console.log('=== another shop\'s ids, given to the functions that take one ===');
const made = (await as(A, `SELECT public.hangtag_webhook_create('https://hooks.example.com/a', ARRAY['sale.completed'], 'A') AS r`))[0];
const wid = made && made.r && made.r.endpoint && made.r.endpoint.id;
const endpoint = async () => (await sql(`SELECT e.id, e.url, e.active, e.events, e.updated_at, s.secret FROM public.hangtag_webhook_endpoints e
  LEFT JOIN public.hangtag_webhook_secrets s ON s.endpoint_id = e.id WHERE e.id = $1`, [wid]))[0] || null;
const before = JSON.stringify(await endpoint());
check('shop A has a webhook endpoint (the fixture)', !!wid && before !== 'null', made);
for (const [what, q] of [
  ['rotate its secret', `SELECT public.hangtag_webhook_rotate($1::uuid)`], ['change it', `SELECT public.hangtag_webhook_update($1::uuid, 'https://evil.example.com/x', ARRAY['sale.completed'], TRUE)`],
  ['send it a test', `SELECT public.hangtag_webhook_test($1::uuid)`], ['delete it', `SELECT public.hangtag_webhook_delete($1::uuid)`]]) {
  await as(B, q, [wid]);
  check(`shop B can't ${what}: A's endpoint is unchanged`, JSON.stringify(await endpoint()) === before);
}
check('…nor can an account in no shop, nor the signed-out', !!(await as(null, `SELECT public.hangtag_webhook_delete($1::uuid)`, [wid])).err
  && (await as(OUT, `SELECT public.hangtag_webhook_delete($1::uuid)`, [wid]), JSON.stringify(await endpoint()) === before));
for (const [fn, q] of [['hangtag_platform_customer', `SELECT public.hangtag_platform_customer($1::uuid)`], ['hangtag_platform_subscription', `SELECT public.hangtag_platform_subscription($1::uuid)`],
  ['hangtag_platform_customer_action', `SELECT public.hangtag_platform_customer_action($1::uuid, 'extend', 'x', '{"days":90}'::jsonb, false)`]]) {
  const r = await as(B, q, [A]);
  check(`${fn}: refused to a shop owner who isn't console staff`, !!r.err || JSON.stringify(r).includes('"ok":false'), r);
}
check('the console\'s staff list and payments: refused to a shop owner', !!(await as(B, `SELECT public.hangtag_platform_staff_list()`)).err && !!(await as(B, `SELECT public.hangtag_platform_payments(NULL, NULL, NULL, NULL, 10, 0, 0)`)).err);
check('a trigger function called directly: refused', !!(await as(B, `SELECT public.hangtag_sale_status()`)).err);
const capBefore = (await as(B, `SELECT public.hangtag_cap_on($1, 'uses_serials') r`, [A]))[0];
check('hangtag_cap_on on schema.sql: answers about shop A to shop B (the known small inference)', capBefore && capBefore.r === true, capBefore);
await db.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
// the migration adds four console functions an app account may call (each checks a console role first) and nothing else
const MIGRATION_ADDS = { hangtag_billing_selfcheck_allowed: 'staff', hangtag_platform_billing_exception_resolve: 'staff', hangtag_platform_billing_exceptions: 'staff',
  hangtag_platform_billing_health: 'staff' };
const e1 = await elevated();
check('…after the post-repair migration: no answer about another shop; the elevated functions are the reviewed ones plus exactly its four console functions, none for the signed-out',
  (await as(B, `SELECT public.hangtag_cap_on($1, 'uses_serials') r`, [A]))[0].r === false
  && JSON.stringify(e1.map((r) => r.fn)) === JSON.stringify([...Object.keys(REVIEWED), ...Object.keys(MIGRATION_ADDS)].sort())
  && e1.filter((r) => MIGRATION_ADDS[r.fn]).every((r) => r.anon === false), { added: e1.map((r) => r.fn).filter((f) => !REVIEWED[f]) });
for (const [fn, q] of [['hangtag_platform_billing_exceptions', `SELECT public.hangtag_platform_billing_exceptions('all', 10)`],
  ['hangtag_platform_billing_exception_resolve', `SELECT public.hangtag_platform_billing_exception_resolve(1, 'settled by a shop')`],
  ['hangtag_platform_billing_health', `SELECT public.hangtag_platform_billing_health()`], ['hangtag_billing_selfcheck_allowed', `SELECT public.hangtag_billing_selfcheck_allowed()`]]) {
  const r = await as(B, q);
  check(`${fn}: refused to a shop owner who isn't console staff`, /HANGTAG_PLATFORM_DENIED/.test(r.err || ''), r);
}

console.log('=== the bills bucket ===');
const put = (who, name) => as(who, `INSERT INTO storage.objects (bucket_id, name) VALUES ('hangtag-bills', $1) RETURNING name`, [name]);
const seen = async (who) => { const r = await as(who, `SELECT name FROM storage.objects WHERE bucket_id = 'hangtag-bills' ORDER BY 1`); return r.err ? r : r.map((x) => x.name); };
check('the bucket is private (made by schema.sql on a project with Storage)', (await sql(`SELECT public FROM storage.buckets WHERE id = 'hangtag-bills'`))[0].public === false);
check('shop A adds a bill file in its own folder', !(await put(A, `${A}/bill-1.pdf`)).err);
check('…not in shop B\'s folder, nor at the top', !!(await put(A, `${B}/planted.pdf`)).err && !!(await put(A, 'loose.pdf')).err);
await put(B, `${B}/bill-9.pdf`);
check('each shop reads only its own folder', JSON.stringify(await seen(A)) === JSON.stringify([`${A}/bill-1.pdf`]) && JSON.stringify(await seen(B)) === JSON.stringify([`${B}/bill-9.pdf`]));
const moved = await as(B, `UPDATE storage.objects SET name = $1 WHERE name = $2 RETURNING name`, [`${B}/stolen.pdf`, `${A}/bill-1.pdf`]);
check('shop B can\'t change (or move to itself) A\'s file', Array.isArray(moved) ? moved.length === 0 : !!moved.err);
const moveOut = await as(A, `UPDATE storage.objects SET name = $1 WHERE name = $2 RETURNING name`, [`${B}/gift.pdf`, `${A}/bill-1.pdf`]);
check('…nor A move its own file into B\'s folder', !!moveOut.err || (Array.isArray(moveOut) && moveOut.length === 0));
const dels = await Promise.all([A, B].map((w) => as(w, `DELETE FROM storage.objects RETURNING name`)));
check('nobody deletes a bill file through the app (no delete rule)', dels.every((d) => Array.isArray(d) ? d.length === 0 : !!d.err) && (await sql(`SELECT count(*)::int n FROM storage.objects`))[0].n === 2);
check('the signed-out and an account in no shop see none', (await seen(null)).length === 0 && (await seen(OUT)).length === 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
