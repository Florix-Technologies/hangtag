// The owner's SQL of 2026-10-18 (supabase/checks/2026-10-18-*.sql, supabase/operations/2026-10-18-*.sql), run exactly as
// written on a database built the way the live project is: schema.sql, then the section files up to 3za newest-first, as
// on 2026-10-13 (its 18 older functions: the 3t subscription functions, the 3w console permissions and dashboard).
// - the console access check and the trial audit read only (in a READ ONLY transaction) and change nothing;
// - the first super admin: one row, only while none is active, only for a real account; a second run changes nothing;
// - the trial corrections: only the shops listed, only those still owed (start + 30 days); no list, nothing; audited as the
//   console's Extend; a second run changes nothing; never a shop with a paid period, AutoPay, a suspension, a 0-day trial
//   (its email had one) or one past its 30 days; no shop's own data;
// - the trial plan set to 30 in the console gives the next shop 30 days under the live 3t trial set-up;
// - the console permissions update: Suspend, Restore and End all sign-ins work (audited, the shop's lock follows), roles
//   without them stay refused, and its undo puts the live body back.
// Run: node supabase/tests/owner-operations.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const at = (p) => new URL(p, import.meta.url);
const read = (p) => fs.readFileSync(at(p), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
const LIVE_OLDER = JSON.parse(lr.slice(lr.indexOf('const LIVE_OLDER = ') + 19, lr.indexOf('].sort();', lr.indexOf('const LIVE_OLDER = ')) + 1).replace(/'/g, '"')).sort();
const SECTIONS = fs.readdirSync(at('../migrations/')).filter((f) => /^202610\d{8}_.+\.sql$/.test(f) && f.slice(0, 14) <= '20261013120000').sort().reverse();
const CHECK = (n) => read(`../checks/${n}`), OP = (n) => read(`../operations/${n}`);

let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(read('../schema.sql'));
const fns = async () => Object.fromEntries((await db.query(`SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k,
  md5(replace(p.prosrc, chr(13), '')) AS v FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'hangtag%'`)).rows.map((r) => [r.k, r.v]));
const FRESH = await fns();
for (const f of SECTIONS) await db.exec(read(`../migrations/${f}`));
const sql = async (q, p) => (await db.query(q, p)).rows;
const last = async (q) => (await db.exec(q)).at(-1).rows;
async function as(who, q, p) {
  await db.exec(`SET ROLE ${who ? 'authenticated' : 'anon'}`);
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false), set_config('request.headers', $2, false)`, [who || '', JSON.stringify({ authorization: 'Bearer x' })]);
  try { return (await db.query(q, p)).rows; } catch (e) { return { err: e.message }; } finally { await db.exec('RESET ROLE'); }
}
const now0 = await fns(), older = Object.keys(FRESH).filter((k) => FRESH[k] !== now0[k]).sort();
check(`built like the live project: exactly its 18 older functions (${older.length})`, JSON.stringify(older) === JSON.stringify(LIVE_OLDER), older);

// the shops: the plan at 15 days when they finished setting up
const id = (n) => `${n.repeat(8)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(4)}-${n.repeat(12)}`;
const ME = '0a0e0b1c-2d3e-4f50-8a6b-7c8d9e0f1a2b';
const [CLIENT, OLD, FIRST, DUP, AP, SUSP, PAID, SECOND, MEMBER, NEW] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a'].map(id);
await sql(`INSERT INTO auth.users (id, email) VALUES ($1,'owner@hangtag.test'),($2,'Client@Shop.test'),($3,'old@shop.test'),($4,'a.b@gmail.com'),($5,'ab+x@gmail.com'),
  ($6,'ap@shop.test'),($7,'susp@shop.test'),($8,'paid@shop.test'),($9,'second@shop.test'),($10,'member@shop.test'),($11,'new@shop.test')`, [ME, CLIENT, OLD, FIRST, DUP, AP, SUSP, PAID, SECOND, MEMBER, NEW]);
const onboard = (o, name) => sql(`UPDATE public.hangtag_profiles SET shop_name = $2, full_name = 'X', business_type = 'retail', onboarded_at = NOW() WHERE id = $1`, [o, name]);
const back = (o, d) => sql(`UPDATE public.hangtag_subscriptions SET trial_started_at = trial_started_at - make_interval(days => $2), trial_ends_at = trial_ends_at - make_interval(days => $2) WHERE owner_id = $1`, [o, d]);
const sub = async (o) => (await sql(`SELECT * FROM public.hangtag_subscriptions WHERE owner_id = $1`, [o]))[0];
await sql(`UPDATE public.hangtag_plans SET days = 15 WHERE code = 'trial'`);
for (const [o, n] of [[CLIENT, 'Client Shop'], [OLD, 'Old Shop'], [FIRST, 'First'], [DUP, 'Dup'], [AP, 'AutoPay Shop'], [SUSP, 'Suspended Shop'], [PAID, 'Paid Shop'], [SECOND, 'Second Shop']]) await onboard(o, n);
await back(CLIENT, 20); await back(OLD, 40); await back(SECOND, 5); await back(AP, 3); await back(SUSP, 3);
await sql(`UPDATE public.hangtag_subscriptions SET autopay_status = 'active' WHERE owner_id = $1`, [AP]);
await sql(`UPDATE public.hangtag_subscriptions SET suspended = TRUE WHERE owner_id = $1`, [SUSP]);
await sql(`UPDATE public.hangtag_subscriptions SET plan_code = 'm1', period_start = NOW(), period_end = NOW() + interval '30 days' WHERE owner_id = $1`, [PAID]);
await sql(`INSERT INTO public.hangtag_members (user_id, shop_id, name, username, role) VALUES ($1, $2, 'Member', 'member1', 'cashier')`, [MEMBER, CLIENT]);
await sql(`INSERT INTO auth.sessions (user_id) VALUES ($1), ($1), ($2)`, [CLIENT, MEMBER]);
await as(CLIENT, `INSERT INTO public.hangtag_products (id, name, price, options) VALUES ('p1', 'Tee', 500, '{"opts":[]}')`);
const shopData = async () => JSON.stringify(await sql(`SELECT owner_id, id, name, price FROM public.hangtag_products ORDER BY 1, 2`));
const subs = async () => JSON.stringify(await sql(`SELECT owner_id, trial_ends_at, period_end, suspended, autopay_status FROM public.hangtag_subscriptions ORDER BY 1`));
const DATA0 = await shopData();
check('the situation: the client\'s 15-day trial ended 5 days ago; the reused Gmail address got no trial', (await sub(CLIENT)).trial_ends_at < new Date()
  && Math.round(((await sub(CLIENT)).trial_ends_at - (await sub(CLIENT)).trial_started_at) / 864e5) === 15 && +(await sub(DUP)).trial_ends_at === +(await sub(DUP)).trial_started_at);

console.log('=== the read-only checks ===');
await as(ME, `SELECT public.hangtag_platform_whoami()`);   // the console's "No access" page
const auditRows = await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit`);
const access = (await db.exec(`BEGIN READ ONLY;\n${CHECK('2026-10-18-console-access.sql').replaceAll(`'<account ID>'`, `'${ME}'`)}\nROLLBACK;`))[1].rows[0];
check('console access check (read only): no super admin, the account known and refused once, not on the team', +access.active_super_admins === 0 && access.your_email === 'owner@hangtag.test'
  && access.your_console_role === null && !!access.your_last_no_access, access);
const audit = async (client, owner) => {
  const rows = (await db.exec(`BEGIN READ ONLY;\n${CHECK('2026-10-18-trial-audit.sql').replace(`'client@example.com'`, `'${client}'`).replace(`'owner@example.com'`, `'${owner}'`)}\nROLLBACK;`))[1].rows;
  return (p) => rows.filter((r) => r.part.startsWith(p)).map((r) => r.detail);
};
const a1 = await audit('  CLIENT@shop.test ', 'owner@hangtag.test');
check('trial audit (read only) 1–3: the plan at 15 (below the standard), no console edit to it, trial lengths by count', a1('1')[0].days === 15 && a1('1')[0].meets_standard === false
  && a1('2').length === 0 && JSON.stringify(a1('3').map((d) => [d.trial_days, d.shops])) === JSON.stringify([[0, 1], [15, 7]]), [a1('1'), a1('3')]);
const c4 = a1('4')[0];
check('4: the client by email (case and spaces ignored): expired, owed 10 days to reach 30 from its start', c4.account_id === CLIENT && c4.state_now === 'trial_expired' && c4.verdict === 'owed' && c4.extend_days === 10, c4);
check('6, 7: no console staff; your account known, not on the team', a1('6').length === 0 && a1('7')[0].account_id === ME && a1('7')[0].console_role === null);
const v8 = Object.fromEntries(a1('8').map((d) => [d.shop, d.verdict]));
check('8: owed — the client, the first Gmail holder, the shop set up 5 days ago; not owed — past 30 days, the reused email, AutoPay, suspended; the paid shop not listed',
  v8['Client Shop'] === 'owed' && v8['First'] === 'owed' && v8['Second Shop'] === 'owed' && /have passed/.test(v8['Old Shop']) && /had already had one/.test(v8['Dup'])
  && /AutoPay/.test(v8['AutoPay Shop']) && /suspended/.test(v8['Suspended Shop']) && !('Paid Shop' in v8), v8);
const p9 = a1('9')[0];
check('9: the owed shops as a list to paste (three)', p9.shops === 3 && [CLIENT, FIRST, SECOND].every((o) => p9.only_shops.includes(`'${o}'`)) && /^ARRAY\[.*\]::uuid\[\]$/.test(p9.only_shops), p9);
check('…a team member\'s email: access follows the shop owner\'s trial', (await audit('member@shop.test', 'owner@hangtag.test'))('4')[0].shop_owner_id === CLIENT);
check('…the checks changed nothing (no audit row, no trial, no shop row)', (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit`))[0].n === auditRows[0].n + 0 && await shopData() === DATA0);

console.log('=== the first super admin ===');
const grant = OP('2026-10-18-first-super-admin.sql');
check('a mistyped account ID: no row, nothing changed', (await last(grant.replaceAll(`'<account ID>'`, `'0a0e0b1c-2d3e-4f50-8a6b-7c8d9e0f1a2c'`))).length === 0
  && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_staff`))[0].n === 0);
const g1 = await last(grant.replaceAll(`'<account ID>'`, `'${ME}'`)), g2 = await last(grant.replaceAll(`'<account ID>'`, `'${ME}'`));
check('your account: one row (super_admin, active) the first time, none the second', g1.length === 1 && g1[0].role === 'super_admin' && g1[0].active === true && g2.length === 0, [g1, g2]);
check('…with a super admin present it adds no other (no second super admin by SQL)', (await last(grant.replaceAll(`'<account ID>'`, `'${OLD}'`))).length === 0);
check('…the console knows you as super admin; a shop owner is not staff', (await as(ME, `SELECT public.hangtag_platform_whoami() r`))[0].r.role === 'super_admin'
  && !(await as(CLIENT, `SELECT public.hangtag_platform_whoami() r`))[0].r.staff);

console.log('=== the trial corrections ===');
const FIX = OP('2026-10-18-trial-corrections.sql');
const fix = async (list, actor = ME) => last(FIX.replace(`'<your account ID>'`, `'${actor}'`).replace(`ARRAY['<shop account ID>']::uuid[] AS only_shops`, `${list} AS only_shops`));
const S0 = await subs();
check('no list: nothing changes (there is no "every shop")', (await fix('ARRAY[]::uuid[]')).length === 0 && await subs() === S0);
check('listed but not owed (past 30 days, reused email, AutoPay, suspended, paid): nothing changes', (await fix(`ARRAY['${OLD}','${DUP}','${AP}','${SUSP}','${PAID}']::uuid[]`)).length === 0 && await subs() === S0);
check('an actor who isn\'t an active super admin: nothing changes', (await fix(`ARRAY['${CLIENT}']::uuid[]`, CLIENT)).length === 0 && await subs() === S0);
const r1 = await fix(`ARRAY['${CLIENT}']::uuid[]`);
const cs = await sub(CLIENT);
check('the client only: one row; its trial now ends exactly 30 days after it started (about 10 days from now), and access is back', r1.length === 1 && r1[0].account_id === CLIENT
  && +cs.trial_ends_at - +cs.trial_started_at === 30 * 864e5 && Math.abs(+r1[0].days_of_access_from_now - 10) < 0.1
  && (await sql(`SELECT public.hangtag_access_ok($1) r`, [CLIENT]))[0].r === true, r1);
const r2 = await fix(p9.only_shops);
check('part 9\'s list: the two others still owed change; the client (already corrected) doesn\'t', r2.length === 2 && r2.map((x) => x.account_id).sort().join() === [FIRST, SECOND].sort().join(), r2);
const S2 = await subs();
check('a second run: no rows, nothing changed', (await fix(p9.only_shops)).length === 0 && await subs() === S2);
const logged = await sql(`SELECT actor, actor_role, target_id, detail FROM public.hangtag_platform_audit WHERE action = 'customer.extend' ORDER BY id`);
check('audited as the console\'s Extend: you, super admin, each shop, the reason, before and after', logged.length === 3 && logged.every((l) => l.actor === ME && l.actor_role === 'super_admin'
  && /30-day standard/.test(l.detail.reason) && l.detail.before.trial_ends_at && l.detail.after.trial_ends_at && l.detail.via === 'sql') && logged[0].target_id === CLIENT, logged);
check('the trials not owed are as they were (past 30 days, reused email, AutoPay, suspended, paid)', [OLD, DUP, AP, SUSP, PAID].every((o) => JSON.parse(S0).find((x) => x.owner_id === o)
  && JSON.stringify(JSON.parse(S0).find((x) => x.owner_id === o)) === JSON.stringify(JSON.parse(S2).find((x) => x.owner_id === o))));
const a2 = await audit('client@shop.test', 'owner@hangtag.test');
check('the audit afterwards: the client ok, nobody left owed (part 9 empty), you a super admin', a2('4')[0].verdict === 'ok' && a2('9')[0].shops === 0 && a2('9')[0].only_shops === 'ARRAY[]::uuid[]'
  && a2('7')[0].console_role === 'super_admin');

console.log('=== the standard: 30 days for new shops ===');
const saved = await as(ME, `SELECT public.hangtag_platform_plan_save('trial', '{"days":30}'::jsonb) r`);
await onboard(NEW, 'New Shop');
const ns = await sub(NEW);
check('the trial plan set to 30 in the console (audited): the next shop gets 30 days under the live 3t set-up', !saved.err && Math.round((+ns.trial_ends_at - +ns.trial_started_at) / 864e5) === 30
  && (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit WHERE action = 'plan.update' AND ok`))[0].n === 1, saved);
check('…and the shops already running keep their own end (the plan never moves a running trial)', await subs() !== S2 && JSON.stringify(JSON.parse(await subs()).filter((x) => x.owner_id !== NEW)) === S2);

console.log('=== the console permissions update and its undo ===');
const fp = async () => (await sql(`SELECT md5(replace(p.prosrc, chr(13), '')) AS f FROM pg_proc p WHERE p.oid = 'public.hangtag_platform_permissions(text)'::regprocedure`))[0].f;
const LIVE_FP = await fp(), act = (action, why) => as(ME, `SELECT public.hangtag_platform_customer_action($1, $2, $3, '{}'::jsonb, false) r`, [CLIENT, action, why]);
const state = async () => (await sql(`SELECT public.hangtag_subscription_state($1, NOW()) s, public.hangtag_access_ok($1) a`, [CLIENT]))[0];
const s0 = await act('suspend', 'before the update');
check('before: Suspend refused for a super admin (the older permissions)', (!!s0.err || s0[0].r.ok === false) && (await state()).s === 'trial_active', s0);
const u1 = await last(OP('2026-10-18-console-permissions.sql'));
await last(OP('2026-10-18-console-permissions.sql'));
check('the update, run twice: its last row says it took (both true); the body is schema.sql\'s', u1[0].suspend_and_sign_out_allowed === true && u1[0].same_as_schema_sql === true
  && (await fp()) === FRESH['hangtag_platform_permissions(p_role text)'], u1);
const s1 = await act('suspend', 'Owner asked: closed for repairs');
check('Suspend: the shop is suspended and locked (the live 3t state honours it)', !s1.err && (await state()).s === 'suspended' && (await state()).a === false, s1);
const r3 = await act('restore', 'Reopened');
check('Restore: the trial runs again and access is back', !r3.err && (await state()).s === 'trial_active' && (await state()).a === true, r3);
const o1 = await act('sign_out', 'Lost phone');
check('End all sign-ins: the owner\'s and the team\'s sessions are gone', !o1.err && (await sql(`SELECT count(*)::int n FROM auth.sessions WHERE user_id IN ($1, $2)`, [CLIENT, MEMBER]))[0].n === 0, o1);
check('…each audited with the role and the reason', (await sql(`SELECT count(*)::int n FROM public.hangtag_platform_audit WHERE action IN ('customer.suspend','customer.restore','customer.sign_out') AND ok
  AND actor_role = 'super_admin' AND detail ->> 'reason' IS NOT NULL`))[0].n === 3);
const roles = (await sql(`SELECT public.hangtag_platform_permissions('read_only') r, public.hangtag_platform_permissions('billing_admin') b, public.hangtag_platform_permissions('support_admin') s`))[0];
check('…roles without them still refused (read only, billing admin); support admin may end sign-ins, not suspend', !roles.r.includes('customers.suspend') && !roles.b.includes('customers.suspend')
  && !roles.b.includes('customers.sessions') && roles.s.includes('customers.sessions') && !roles.s.includes('customers.suspend'), roles);
const d1 = await last(OP('2026-10-18-console-permissions-undo.sql'));
const s2 = await act('suspend', 'after the undo');
check('the undo: its last row says it took; the live body again; Suspend refused again', d1[0].suspend_refused_again === true && d1[0].same_as_before === true && (await fp()) === LIVE_FP
  && (!!s2.err || s2[0].r.ok === false), d1);
check('no shop\'s own data changed by any of it', await shopData() === DATA0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
