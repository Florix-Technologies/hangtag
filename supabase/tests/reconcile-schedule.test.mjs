// The hourly billing reconciliation's schedule (supabase/operations/billing-reconcile-schedule.sql, its undo and
// supabase/checks/reconcile-schedule-health.sql) on the real schema and the post-repair and Cashfree migrations, with
// stand-ins for what a Supabase project has and PGlite lacks: pg_cron's cron.job / schedule / unschedule /
// job_run_details, pg_net's net.http_post / _http_response and Vault's decrypted_secrets. Then the request the job makes
// is handed to the real reconcile handler (supabase/functions/subscription/reconcile.js): it must be let in, run and be
// recorded — and a different secret must not. No network, no keys.
// Run: node supabase/tests/reconcile-schedule.test.mjs
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { handleReconcile } from '../functions/subscription/reconcile.js';
import { autopayProviderFor, providerFor, providerNamed } from '../functions/subscription/providers/index.js';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const lr = read('./live-recovery.test.mjs');
const STUB = lr.slice(lr.indexOf('const SUPABASE = `') + 18, lr.indexOf('`;', lr.indexOf('const SUPABASE = `')));
let fails = 0;
const check = (name, ok, info) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (!ok && info !== undefined ? '  ' + JSON.stringify(info).slice(0, 700) : '')); };
const db = new PGlite();
await db.exec(STUB);
await db.exec(read('../schema.sql'));
await db.exec(read('../migrations/20261019120000_hangtag_post_repair_integrity.sql'));
await db.exec(read('../migrations/20261027120000_hangtag_cashfree_readiness.sql'));
const sql = async (q, p) => (await db.query(q, p)).rows;
const OP = read('../operations/billing-reconcile-schedule.sql'), UNDO = read('../operations/billing-reconcile-schedule-undo.sql');
const HEALTH = read('../checks/reconcile-schedule-health.sql');
const tryOp = () => db.exec(OP).then((r) => ({ ok: true, rows: r.at(-1).rows }), (e) => ({ ok: false, message: String(e.message) }));
const jobs = () => sql(`SELECT jobname, schedule, command, active FROM cron.job`);

// what each piece needs before it exists: the operation refuses, naming it, and schedules nothing
const r1 = await tryOp();
await db.exec(`CREATE SCHEMA cron;
  CREATE TABLE cron.job (jobid BIGSERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT NOT NULL, command TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE);
  CREATE TABLE cron.job_run_details (jobid BIGINT, status TEXT, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, return_message TEXT);
  -- as pg_cron: unscheduling an unknown name is an error; scheduling a known one here is too (so a doubled job can't hide)
  CREATE FUNCTION cron.schedule(job_name TEXT, schedule TEXT, command TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $f$
    DECLARE id BIGINT; BEGIN
      IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = job_name) THEN RAISE EXCEPTION 'test: job % scheduled twice', job_name; END IF;
      INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid INTO id; RETURN id; END $f$;
  CREATE FUNCTION cron.unschedule(job_name TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $f$
    BEGIN DELETE FROM cron.job WHERE jobname = job_name; IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job ''%''', job_name; END IF; RETURN TRUE; END $f$;`);
const r2 = await tryOp();
await db.exec(`CREATE SCHEMA net;
  CREATE TABLE net.calls (id BIGSERIAL PRIMARY KEY, url TEXT, body JSONB, params JSONB, headers JSONB, timeout_ms INT);
  CREATE TABLE net._http_response (id BIGINT, status_code INT, content TEXT, timed_out BOOLEAN, error_msg TEXT, created TIMESTAMPTZ DEFAULT NOW());
  CREATE FUNCTION net.http_post(url TEXT, body JSONB DEFAULT '{}', params JSONB DEFAULT '{}', headers JSONB DEFAULT '{"Content-Type": "application/json"}', timeout_milliseconds INT DEFAULT 5000)
    RETURNS BIGINT LANGUAGE sql AS $f$ INSERT INTO net.calls (url, body, params, headers, timeout_ms) VALUES (url, body, params, headers, timeout_milliseconds) RETURNING id $f$;`);
const r3 = await tryOp();
await db.exec(`CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets (name TEXT PRIMARY KEY, decrypted_secret TEXT);`);
const r4 = await tryOp();
await sql(`INSERT INTO vault.decrypted_secrets VALUES ('hangtag_reconcile_url', 'http://proj.supabase.co/functions/v1/subscription-webhook')`);
const r5 = await tryOp();
await sql(`UPDATE vault.decrypted_secrets SET decrypted_secret = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/subscription-webhook' WHERE name = 'hangtag_reconcile_url'`);
const r6 = await tryOp();
await sql(`INSERT INTO vault.decrypted_secrets VALUES ('hangtag_reconcile_secret', 'too-short')`);
const r7 = await tryOp();
check('refused, naming what is missing and scheduling nothing: pg_cron, pg_net, the Vault secrets, an http (not https) or other URL, a secret under 32 characters',
  !r1.ok && /pg_cron/.test(r1.message) && !r2.ok && /pg_net/.test(r2.message) && !r3.ok && /Vault/.test(r3.message) && !r4.ok && /hangtag_reconcile_url/.test(r4.message)
  && !r5.ok && /hangtag_reconcile_url/.test(r5.message) && !r6.ok && /hangtag_reconcile_secret/.test(r6.message) && !r7.ok && /32/.test(r7.message)
  && (await jobs()).length === 0, [r1, r2, r3, r4, r5, r6, r7].map((r) => r.message));

const SECRET = 'rs_' + 'k9'.repeat(20), URL_ = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/subscription-webhook';
await sql(`UPDATE vault.decrypted_secrets SET decrypted_secret = $1 WHERE name = 'hangtag_reconcile_secret'`, [SECRET]);
const s1 = await tryOp();
const s2 = await tryOp();
const j = await jobs();
check('scheduled: one job, hourly at minute 7, active; run again, still one (replaced, never doubled); the job\'s text names the Vault secrets but holds neither value',
  s1.ok && s2.ok && j.length === 1 && j[0].jobname === 'hangtag-billing-reconcile' && j[0].schedule === '7 * * * *' && j[0].active === true
  && !j[0].command.includes(SECRET) && !j[0].command.includes(URL_) && /hangtag_reconcile_secret/.test(j[0].command) && s2.rows[0].jobname === 'hangtag-billing-reconcile', { s1, s2, j });

// the job runs as pg_cron would run it: its own text, as one statement batch
await db.exec(j[0].command);
const [call] = await sql(`SELECT url, body, headers, timeout_ms FROM net.calls`);
check('the job\'s run: one POST to the subscription-webhook URL from Vault, with x-hangtag-reconcile: 1 and the bearer secret from Vault, an empty JSON body, waiting up to 120 s',
  call && call.url === URL_ && call.headers['x-hangtag-reconcile'] === '1' && call.headers.Authorization === 'Bearer ' + SECRET && JSON.stringify(call.body) === '{}' && call.timeout_ms === 120000,
  call && { url: call.url, headers: Object.keys(call.headers), timeout: call.timeout_ms });

// that request, handed to the real reconcile handler (as the deployed function receives it: header names in lower case)
function client() {
  return { rpc: async (name, args = {}) => {
    try {
      const sig = (await db.query(`SELECT p.proargnames AS n, oidvectortypes(p.proargtypes) AS t FROM pg_proc p WHERE p.proname = $1 AND p.pronamespace = 'public'::regnamespace`, [name])).rows[0];
      if (!sig) return { data: null, error: { code: 'PGRST202' } };
      const names = sig.n || [], types = sig.t ? sig.t.split(', ') : [], keys = Object.keys(args).filter((k) => names.includes(k));
      await db.exec('SET ROLE service_role');
      try {
        const r = await db.query(`SELECT public.${name}(${keys.map((k, i) => `${k} => $${i + 1}::${types[names.indexOf(k)]}`).join(', ')}) AS r`,
          keys.map((k) => (args[k] != null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
        return { data: r.rows[0].r, error: null };
      } finally { await db.exec('RESET ROLE'); }
    } catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
  } };
}
await sql(`UPDATE public.hangtag_billing_settings SET billing_mode = 'test'`);
const ENV = { SUBSCRIPTION_PROVIDER: 'cashfree', SUBSCRIPTION_AUTOPAY_PROVIDER: 'cashfree', SUBSCRIPTION_CASHFREE_APP_ID: 'TEST10app', SUBSCRIPTION_CASHFREE_SECRET_KEY: 'cfsk_ma_test_k',
  SUBSCRIPTION_TEST_MODE: 'true', SUBSCRIPTION_RECONCILE_SECRET: SECRET };
const noNet = async () => { throw new Error('test: no network'); };
const headers = Object.fromEntries(Object.entries(call.headers).map(([k, v]) => [k.toLowerCase(), v]));
const rec = (env) => handleReconcile({ method: 'POST', headers }, { env, admin: client, provider: providerFor(env, noNet), autopay: autopayProviderFor(env, noNet),
  named: (n) => providerNamed(n, env, noNet), log: { error: () => {} } });
const wrong = await rec({ ...ENV, SUBSCRIPTION_RECONCILE_SECRET: 'x'.repeat(40) });
const unset = await rec({ ...ENV, SUBSCRIPTION_RECONCILE_SECRET: '' });
const before = (await sql(`SELECT count(*)::int n FROM public.hangtag_billing_reconcile_runs`))[0].n;
const good = await rec(ENV);
const runs = await sql(`SELECT ok, complete, finished_at IS NOT NULL AS finished FROM public.hangtag_billing_reconcile_runs ORDER BY id DESC LIMIT 1`);
const again = await rec(ENV);
check('…let in by the function only with its own secret: another secret 401, the function\'s secret unset 503 (neither starts a run); with it, a run begins, completes and is recorded; a second within 5 minutes is "busy"',
  wrong.status === 401 && unset.status === 503 && before === 0 && good.status === 200 && good.body.ok === true && good.body.complete === true && runs[0].ok && runs[0].complete && runs[0].finished
  && again.status === 200 && again.body.busy === true, { wrong, unset, good, again });

await sql(`INSERT INTO cron.job_run_details SELECT jobid, 'succeeded', NOW() - interval '1 minute', NOW(), '1 row' FROM cron.job`);
await sql(`INSERT INTO net._http_response (id, status_code, content, timed_out) VALUES (1, 200, $1, FALSE)`, [JSON.stringify(good.body)]);
const health = (await db.exec(HEALTH)).at(-1).rows;
check('the health check (read-only): the job, its run, the function\'s answer and the last complete run, in that order',
  health.length === 4 && health.map((r) => r.what).join() === 'job,cron run,function answer,last complete run' && health[0].detail.schedule === '7 * * * *'
  && health[1].detail.status === 'succeeded' && health[2].detail.status === 200 && health[3].detail.hours_ago !== null, health);

const u1 = (await db.exec(UNDO)).at(-1).rows, u2 = (await db.exec(UNDO)).at(-1).rows;
check('the undo: the job removed, and safe to run again', u1[0].removed === true && u2[0].removed === true && (await jobs()).length === 0, { u1, u2 });

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
